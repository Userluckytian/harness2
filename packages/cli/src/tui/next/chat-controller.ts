// chat-controller.ts — W2：next 聊天输入控制器（统一输入层事件 → ChatScreenState 变更）。
//
// 职责：把 P1 统一输入层（input/parser.ts）产出的 KeyEvent / PasteEvent / MouseEvent /
// FocusEvent 变更为 ChatScreenState（chat-screen.ts）的草稿 / 光标 / 候选 / scrollback
// 滚动状态，并经回调上报提交（Enter → onSubmit）与中断（Ctrl+C → onInterrupt）。
// 纯逻辑、headless 可测、零 ink/react 依赖；渲染仍是逐帧拉取（renderChat 读同一 state）。
//
// 状态取舍（钉死）：**受控可变**——controller 原地改写 state.draft / state.cursor /
// state.candidates，scrollback 经其自身方法变更。理由：Scrollback 本就是可变对象
// （wrap 缓存 + 前缀和惰性构建），不可变更新要么整体替换（丢缓存）要么 half-immutable
// （scrollback 共享、其余字段重建），都不如受控可变诚实；上层需要快照时自行浅拷贝。
//
// 草稿编辑复用 src/tui/input.ts 的 reduceInput（Intl.Segmenter grapheme 分段：插入 /
// backspace / delete / ←→ 一次一个 grapheme，绝不劈代理对、ZWJ emoji、组合字符）。
// ↑↓ 用 Infinity 宽度 = 按**硬换行逻辑行**移动；软折行视觉行移动需要终端列宽
// （Composer 用 stdout.columns），属 W3 装配层职责——届时可在 extraKeyHandler 或本层
// 增加 setWidth 扩展。
//
// 键位（2026-09-12 keymap-parity 裁决；本任务只做基础编辑键，grok 特有键留 P3）：
//   可打印字符（含中文）→ 插入光标处；Backspace / Delete（grapheme 步进）；
//   ← →（grapheme）/ Ctrl+←→ 词移动；↑ ↓（多行草稿内逻辑行移动，边界处历史回溯，
//   往返恢复原草稿含光标）；Home / End（逻辑行行首 / 行尾）；Enter 提交（空草稿
//   消费但不提交）/ Shift+Enter 换行；候选可见时 ↑↓ 循环改选、Tab 接受进草稿、
//   Enter 接受并提交（grok 口径，见差异说明）；PageUp / PageDown → scrollback 翻页；
//   Ctrl+U / Ctrl+D → 半页上 / 下滚（keymap 裁决采纳 grok，Ctrl+D 不再是退出）；
//   Ctrl+G → 跟随回底；Ctrl+C → onInterrupt（**每次**上报，双击窗口逻辑留给装配层）。
//   Ctrl+D 显式裁决（2026-09-12 审查 P2-3）：恒为半页下滚，**不做**空草稿退出（Ink
//   Composer 的 EOF 退出语义不带入 next 层）；next 模式退出只走 Ctrl+C 双击与 /exit。
//
// 粘贴语义（对齐现有 Ink usePaste 通道）：bracketed paste 的文本 CRLF（含裸 CR）归一为
// LF 后在光标处插入，多行合法；**粘贴路径绝不调用 onSubmit**（内嵌 \r 不触发提交，
// 对齐「粘贴不会伪装成提交」的既有语义）。chip 占位标签是 Composer 渲染层策略，不在本层。
//
// attachInput 与孤立 ESC / 断流 paste 的 flushIdle 驱动（重要接口说明）：
//   parser 保持纯逻辑、不持有 timer（见 parser.ts 文件头）。孤立 ESC → Esc 键、
//   断流 paste 兜底产出，都靠调用方在**输入空闲时**驱动 attached.flushIdle(now)——
//   TUI 主循环建议挂一个 ~50ms 的空闲定时器（或每次 select 循环空闲时调用）；
//   退出 / 暂停时调 attached.flush() 兜底，保证不静默吞字节。attachInput 自身不创建
//   定时器（headless 纯逻辑、测试确定性），detach 只停路由。
import type { InputDispatcher, InputLayer } from '../../input/dispatcher.js';
import type { InputParser } from '../../input/parser.js';
import type { FocusEvent, InputEvent, KeyEvent, MouseEvent, PasteEvent } from '../../input/types.js';
import {
  createHistoryState,
  createInputState,
  historyNext,
  historyPrev,
  historyPush,
  reduceInput,
  type HistoryState,
  type InputState,
} from '../input.js';
import type { ChatScreenState } from './chat-screen.js';

export interface ChatControllerOptions {
  /** 初始历史（提交的草稿按序入历史，↑↓ 回溯）；缺省空 */
  history?: readonly string[];
  /** Enter 提交回调（收到草稿原文；草稿已同步清空并入历史） */
  onSubmit?: (text: string) => void;
  /** Ctrl+C 回调：本层每次按键都上报，双击退出窗口由装配层实现 */
  onInterrupt?: () => void;
  /**
   * P3 扩展位：先于内置裁决调用的额外键处理（grok 特有键：模式循环 Ctrl+O、
   * 任务面板改绑等）。返回 'consumed' 短路内置处理，'ignored' 继续内置裁决。
   */
  extraKeyHandler?: (ev: KeyEvent) => 'consumed' | 'ignored';
}

export interface ChatController {
  /** 当前聊天状态（受控可变：controller 原地改写字段，见文件头取舍说明） */
  readonly state: ChatScreenState;
  /** 键事件处理：'consumed' = 已变更状态 / 上报回调；'ignored' = 本层不认识该键 */
  handleKey(ev: KeyEvent): 'consumed' | 'ignored';
  /** 粘贴：CRLF→LF 归一后光标处插入；绝不触发 onSubmit */
  handlePaste(ev: PasteEvent): 'consumed' | 'ignored';
  /** 鼠标：滚轮上 / 下（button 0 / 1）→ scrollback ±3 物理行；其余 ignored */
  handleMouse(ev: MouseEvent): 'consumed' | 'ignored';
  /**
   * 终端窗口焦点事件（CSI I / O）：恒 'ignored'。终端窗口失焦 ≠ 应用内 composer 失焦
   * （后者是本层 focused 状态，由 focus()/blur()/setFocused 控制），本层不消费。
   */
  handleFocus(ev: FocusEvent): 'consumed' | 'ignored';
  /** 设置候选（items 为空 → 候选清除）；activeIndex 越界钳制 */
  setCandidates(items: readonly string[], activeIndex?: number): void;
  /** 清除候选 */
  clearCandidates(): void;
  /** composer 焦点开关：blur 期间所有事件 handler 恒 'ignored'（状态不变） */
  setFocused(focused: boolean): void;
  focus(): void;
  blur(): void;
  isFocused(): boolean;
  /** 追加历史（不改变草稿；供装配层同步外部产生的提交） */
  pushHistory(text: string): void;
}

/** 草稿（按硬换行）内 cursor 之前的换行数 = 光标所在逻辑行号 */
function newlinesBefore(draft: string, cursor: number): number {
  let n = 0;
  for (let i = 0; i < cursor && i < draft.length; i += 1) {
    if (draft.charCodeAt(i) === 10) n += 1;
  }
  return n;
}

export function createChatController(initial: ChatScreenState, options: ChatControllerOptions = {}): ChatController {
  const state = initial;
  let history: HistoryState = createHistoryState(options.history ?? []);
  let focused = true;

  function currentInput(): InputState {
    return { value: state.draft, cursor: state.cursor, selectionAnchor: null, composing: '' };
  }

  /** 把编辑内核产出的 InputState 写回 ChatScreenState（受控可变写回点） */
  function applyInput(s: InputState): void {
    state.draft = s.value;
    state.cursor = s.cursor;
  }

  function clampCandidateIndex(n: number, index: number): number {
    return n === 0 ? 0 : Math.max(0, Math.min(Math.floor(index), n - 1));
  }

  function clearCandidates(): void {
    state.candidates = null;
  }

  /**
   * 提交：文本 trim 为空则直接返回（空草稿 Enter 消费但不提交，对齐 Ink）；
   * 否则入历史 → 回调 → 清草稿 → 清候选（草稿已空，旧候选必然失效）。
   * overrideText 用于「候选 Enter 接受并提交」：提交的是高亮候选而非原草稿。
   */
  function submitDraft(overrideText?: string): void {
    const text = overrideText ?? state.draft;
    if (text.trim().length === 0) return;
    history = historyPush(history, text);
    options.onSubmit?.(text);
    applyInput(createInputState(''));
    clearCandidates();
  }

  /** 草稿（硬换行逻辑行）内能否沿 dir 再走一行；边界处 ↑↓ 改走历史回溯 */
  function canMoveLogicalRow(dir: 'up' | 'down'): boolean {
    if (dir === 'up') return newlinesBefore(state.draft, state.cursor) > 0;
    return state.draft.indexOf('\n', state.cursor) !== -1;
  }

  function historyStep(dir: 'up' | 'down'): void {
    const result = dir === 'up' ? historyPrev(history, currentInput()) : historyNext(history, currentInput());
    history = result.history;
    if (result.next !== null) applyInput(result.next);
  }

  function handleKey(ev: KeyEvent): 'consumed' | 'ignored' {
    if (!focused) return 'ignored';
    if (options.extraKeyHandler !== undefined && options.extraKeyHandler(ev) === 'consumed') return 'consumed';

    // —— 候选可见：↑↓ 循环改选、Tab 接受进草稿、Enter 接受并提交（grok 口径）——
    const cands = state.candidates;
    if (cands !== null && cands.items.length > 0) {
      const n = cands.items.length;
      const plain = !ev.modifiers.ctrl && !ev.modifiers.alt;
      if (plain && ev.key === 'up') {
        cands.activeIndex = (cands.activeIndex - 1 + n) % n;
        return 'consumed';
      }
      if (plain && ev.key === 'down') {
        cands.activeIndex = (cands.activeIndex + 1) % n;
        return 'consumed';
      }
      if (plain && ev.key === 'tab' && !ev.modifiers.shift) {
        const chosen = cands.items[clampCandidateIndex(n, cands.activeIndex)] ?? '';
        applyInput(createInputState(chosen)); // 接受进草稿；候选重算（按新前缀）属 W3 装配层
        return 'consumed';
      }
      if (plain && ev.key === 'enter' && !ev.modifiers.shift) {
        const chosen = cands.items[clampCandidateIndex(n, cands.activeIndex)] ?? '';
        submitDraft(chosen); // 接受高亮候选并提交（差异：Ink 提交的是原草稿，见差异表）
        return 'consumed';
      }
      // 其余按键（删除 / 移动 / 可打印字符 / Shift+Tab 等）照常进入编辑流
    }

    // —— Ctrl 组（keymap 裁决：Ctrl+U/D 半页滚动；Ctrl+G 跟随回底；Ctrl+C 中断）——
    if (ev.modifiers.ctrl) {
      if (ev.key === 'c' && !ev.modifiers.alt) {
        options.onInterrupt?.(); // 每次上报；双击窗口逻辑由装配层实现
        return 'consumed';
      }
      if (!ev.modifiers.alt) {
        if (ev.key === 'u') {
          state.scrollback.halfPageUp();
          return 'consumed';
        }
        if (ev.key === 'd') {
          state.scrollback.halfPageDown();
          return 'consumed';
        }
        if (ev.key === 'g') {
          state.scrollback.goToBottom();
          return 'consumed';
        }
      }
    }

    // —— Enter：Shift+Enter 换行；普通 Enter 提交 ——
    if (ev.key === 'enter' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
      if (ev.modifiers.shift) {
        applyInput(reduceInput(currentInput(), { type: 'insert', text: '\n' }));
        return 'consumed';
      }
      submitDraft();
      return 'consumed';
    }

    // —— 编辑键（全部经 reduceInput：grapheme 步进，不劈代理对）——
    if (ev.key === 'backspace' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
      applyInput(reduceInput(currentInput(), { type: 'backspace' }));
      return 'consumed';
    }
    if (ev.key === 'delete' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
      applyInput(reduceInput(currentInput(), { type: 'delete' }));
      return 'consumed';
    }
    if (ev.key === 'home' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
      applyInput(reduceInput(currentInput(), { type: 'move', dir: 'lineStart' }));
      return 'consumed';
    }
    if (ev.key === 'end' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
      applyInput(reduceInput(currentInput(), { type: 'move', dir: 'lineEnd' }));
      return 'consumed';
    }
    if ((ev.key === 'left' || ev.key === 'right') && !ev.modifiers.alt) {
      // Ctrl+←→ 词移动（对齐 Ink：Ctrl 与 Alt+方向都算词移动；本层 Alt 通道留 P3）
      const word = ev.modifiers.ctrl;
      const dir = ev.key === 'left' ? (word ? 'wordLeft' : 'left') : word ? 'wordRight' : 'right';
      applyInput(reduceInput(currentInput(), { type: 'move', dir }));
      return 'consumed';
    }
    if ((ev.key === 'up' || ev.key === 'down') && !ev.modifiers.ctrl && !ev.modifiers.alt) {
      const dir = ev.key === 'up' ? 'up' : 'down';
      if (canMoveLogicalRow(dir)) {
        // 多行草稿内逻辑行移动（Infinity 宽度 = 不做软折行视觉行；软折行属 W3）
        applyInput(reduceInput(currentInput(), { type: 'move', dir }));
      } else {
        historyStep(dir); // 视觉边界：历史回溯（走到头恢复原草稿含光标）
      }
      return 'consumed';
    }

    // —— 滚动键（PageUp/PageDown 整页；Ctrl+U/D 已在上方半页分支消费）——
    if (ev.key === 'pageup' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
      state.scrollback.pageUp();
      return 'consumed';
    }
    if (ev.key === 'pagedown' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
      state.scrollback.pageDown();
      return 'consumed';
    }

    // —— 可打印字符（含中文；Ctrl/Alt 修饰的组合不算文本输入）——
    if (ev.text !== undefined && ev.text.length > 0 && !ev.modifiers.ctrl && !ev.modifiers.alt) {
      applyInput(reduceInput(currentInput(), { type: 'insert', text: ev.text }));
      return 'consumed';
    }
    return 'ignored';
  }

  function handlePaste(ev: PasteEvent): 'consumed' | 'ignored' {
    if (!focused) return 'ignored';
    if (ev.text.length === 0) return 'ignored';
    // CRLF 与裸 CR 统一归一 LF；插入路径与提交路径完全隔离 → 粘贴内嵌 \r 绝不触发 onSubmit
    const normalized = ev.text.replace(/\r\n?/g, '\n');
    applyInput(reduceInput(currentInput(), { type: 'insert', text: normalized }));
    return 'consumed';
  }

  function handleMouse(ev: MouseEvent): 'consumed' | 'ignored' {
    if (!focused) return 'ignored';
    if (ev.kind !== 'scroll') return 'ignored';
    if (ev.button === 0) {
      state.scrollback.scrollBy(-3); // 滚轮上 ±3 物理行（= Scrollback.wheelUp 语义）
      return 'consumed';
    }
    if (ev.button === 1) {
      state.scrollback.scrollBy(3);
      return 'consumed';
    }
    return 'ignored';
  }

  return {
    state,
    handleKey,
    handlePaste,
    handleMouse,
    handleFocus: (_ev: FocusEvent) => 'ignored' as const,
    setCandidates(items, activeIndex = 0) {
      const arr = [...items];
      state.candidates =
        arr.length === 0 ? null : { items: arr, activeIndex: clampCandidateIndex(arr.length, activeIndex) };
    },
    clearCandidates,
    setFocused(f) {
      focused = f;
    },
    focus() {
      focused = true;
    },
    blur() {
      focused = false;
    },
    isFocused: () => focused,
    pushHistory(text: string) {
      history = historyPush(history, text);
    },
  };
}

/**
 * composer 层的 dispatcher handler 工厂（层级顺序：overlay > approval > composer >
 * scrollback；本层只产出 composer）。InputLayer.handle 返回 true = 消费（停止下传）。
 * focus 事件委托给 controller.handleFocus（当前恒 ignored，见上）。
 */
export function createComposerLayer(controller: ChatController): InputLayer {
  return {
    name: 'composer',
    handle: (event: InputEvent): boolean => {
      switch (event.type) {
        case 'key':
          return controller.handleKey(event) === 'consumed';
        case 'paste':
          return controller.handlePaste(event) === 'consumed';
        case 'mouse':
          return controller.handleMouse(event) === 'consumed';
        case 'focus':
          return controller.handleFocus(event) === 'consumed';
      }
    },
  };
}

export interface AttachedInput {
  /** 喂原始字节（parser.feed 透传 + 事件路由）；返回路由的事件数（detach 后恒 0 且不进 parser） */
  feed(bytes: Uint8Array | string): number;
  /** 无条件冲刷 parser（退出 / 暂停兜底：未闭合 paste、孤立 ESC、残缺 UTF-8），事件照常路由 */
  flush(): number;
  /**
   * 空闲超时冲刷（孤立 ESC → Esc 键、断流 paste 兜底）：TUI 主循环在**输入空闲时**驱动
   * （建议 ~50ms 定时器或空闲钩子）；now 缺省用 parser 自身时钟。返回路由的事件数。
   */
  flushIdle(now?: number): number;
  /** 停止事件路由（此后 feed / flush / flushIdle 均为 no-op 返回 0）；不持有定时器，无需清理 */
  detach(): void;
}

/**
 * 派发集成：parser 事件 → controller（可选经 dispatcher 按层级优先级分发）。
 *
 * 路由语义：
 *  - 不传 dispatcher：事件直达 controller（headless 测试与最简装配）。
 *  - 传 dispatcher：事件先 dispatcher.dispatch（层级优先级，如 overlay > approval >
 *    composer > scrollback，composer 层用 createComposerLayer(controller) 装配）；
 *    若全部层未消费，**兜底直达 controller**——保证调用方忘了装配 composer 层时
 *    编辑链路仍然可用（composer 层已存在时其 'ignored' 返回值与直达结果一致，无副作用）。
 */
export function attachInput(
  parser: InputParser,
  controller: ChatController,
  dispatcher?: InputDispatcher,
): AttachedInput {
  let detached = false;

  function routeDirect(ev: InputEvent): boolean {
    switch (ev.type) {
      case 'key':
        return controller.handleKey(ev) === 'consumed';
      case 'paste':
        return controller.handlePaste(ev) === 'consumed';
      case 'mouse':
        return controller.handleMouse(ev) === 'consumed';
      case 'focus':
        return controller.handleFocus(ev) === 'consumed';
    }
  }

  function route(ev: InputEvent): boolean {
    if (dispatcher !== undefined && dispatcher.dispatch(ev)) return true;
    return routeDirect(ev);
  }

  function routeEvents(events: readonly InputEvent[]): number {
    for (const ev of events) route(ev);
    return events.length;
  }

  return {
    feed(bytes) {
      if (detached) return 0;
      return routeEvents(parser.feed(bytes));
    },
    flush() {
      if (detached) return 0;
      return routeEvents(parser.flush());
    },
    flushIdle(now) {
      if (detached) return 0;
      return routeEvents(parser.flushIdle(now));
    },
    detach() {
      detached = true;
    },
  };
}
