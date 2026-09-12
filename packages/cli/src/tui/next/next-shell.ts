// next-shell.ts — W3：next 渲染层接入 chat 命令（HARNESS2_RENDERER=next 开关，默认关闭）。
//
// 职责：与 runInkChat 平行的第二条 chat 装配——复用 setupChatSession（同一 runtime/审批/
// 会话语义，禁止两套装配），渲染与输入改走 next 库：Screen + createInputParser +
// createChatController + renderChat 画帧。开关在 runInkChat.tsx 入口分支
// （process.env.HARNESS2_RENDERER === 'next' → runNextChat），其余路径一行不动。
//
// 装配对照（与 InkShell 的对齐面与取舍，均如实钉死）：
// - 转录流式：复用 useTurnStream 导出的 terminalEvent 纯函数；handler 的 50ms 缓冲逻辑为
//   等价复刻（useTurnStream 是 React hook，不可直接复用），见 createTurnStreamBridge。
//   差异：Ink 的 live 快照渲染在转录底部、不产生转录项；next 的 Scrollback 无原地更新能力，
//   live 文本以 `assistant/step`（turnId+stepIndex 稳定 id，reducer put 原地替换）承载，
//   每次替换触发全量重投影（取舍：换增量追加的简单性；长会话下 50ms 全量重投影是已知开销）。
// - 投影增量：记住上次投影的 item 引用数组与行数；item 前缀引用全等（reducer 不改旧 item，
//   替换必产生新引用）→ 只 appendLines 新增行；否则（tool/result 原地合并、live step 替换、
//   折叠变化）全量重投影重建 Scrollback（follow/scrollTop 尽力保留，注明取舍）。
// - 提交路径：对齐 InkShell——Enter → submit(text)；忙时 FIFO 入队、收尾 drain（选对齐面
//   最小者：完整复刻队列语义，但队列取消面板 Ctrl+X 未接，见文件尾「next 模式暂缺项」）。
// - 审批：askApproval → ApprovalGate → Approval overlay（标题 'Approval' + y/a/n 项，
//   ↑↓ / 数字 1-3 / Enter 选择，Esc / Ctrl+C 取消）。choice 映射与 Ink 版一致（allow→y、
//   allow-always→a、deny→n；gate 直接产出 y/a/n，由 setupChatSession 归一）。
//   未复用 runInkChat 的 createDialogController：其 DialogRequest.render 是 React 节点，
//   与 next 渲染不兼容，且会引入 ink/react 依赖与模块环；gate 为其非 React 等价复刻。
// - Ctrl+C：createCtrlCGuard（忙时取消 / 空闲 2s 窗口双击退出，退出码 130）——对齐 Composer。
//   Ctrl+D：按 2026-09-12 keymap 裁决 = 半页下滚（chat-controller 内置消费），**不退出**——
//   退出只走 Ctrl+C 双击与 /exit（Ink Composer 的空草稿 Ctrl+D 退出语义不带入 next 层）。
// - 退出：createShutdown + bindShutdownSignals（SIGTERM/SIGHUP 同一幂等路径）；raw mode 由
//   本层管理（screen.start 后 setRawMode(true)，退出还原）；SIGINT 不绑定（Ctrl+C 走键盘
//   协议，raw mode 下内核不投递 SIGINT，与 Ink 行为一致）。另有 process 'exit' 兜底还原
//   （bindEmergencyExitRestore：exit 回调内只能同步写，见函数注释）。
// - notifier / steer 观察 / resize（screen.resize + resizeChat + 强制全量重投影）/ DECSET
//   1004 焦点上报（parser 产出 focus 事件 → focused 标记，notifier 策略自然生效）均已接。
//
// next 模式暂缺项（对齐 Ink 的差距，诚实登记、不伪造）：
//   1. 斜杠命令仅 /help /? /exit /quit；/mode /sessions /undo /redo /new /resume /fork
//      /context /compact /reasoning /tasks 未接（提示暂不支持，不静默吞掉）。
//   2. 队列面板（Ctrl+X 取消排队条目）与 RetryPanel（重试预算展示）未接。
//   3. 工具卡 output/子会话入口的磁盘补齐（enrichSubagentResults）未接：live 流不带 output，
//      工具结果行只有状态无输出摘要；子会话只读浮层（Ctrl+J/K）未接。
//   4. 工具卡/推理块仍为纯文本行近似（无边框/反色）；逐行前景色已落地（P3-A：
//      projection fg → Scrollback 行对象 fg → drawScrollback 逐行绘制，单 fg 兜底保留）。
//   5. 软折行视觉行内 ↑↓ 移动（Infinity 宽度逻辑行移动）、候选补全（matchCommands）未接。
//
// P3-A 键位（2026-09-12 keymap-parity 裁决落地，next 层）：
//   - Tab = 输入框/滚动区双态焦点（候选可见时 Tab 仍是接受候选，dispatcher 候选优先）；
//     滚动区焦点下 h/l/e/E 生效（块折叠键族），其余字母键自动回到输入框照常插入
//     （grok simple 模式语义）；指示器显示 'scrollback'。
//   - e = 展开全部块 / E = 折叠全部块（collapsed 覆盖集全量重置：e = 收录全部可折叠
//     item 下标，E = 清空集）；h/l = 折叠/展开最近一次工具/推理 item（next 无块光标，
//     取最近可折叠 item，对齐旧 Ctrl+O 定位策略；grok 是选中块导航，差异登记 keymap 文档）。
//   - Ctrl+O = always-approve 切换（grok YOLO）：UI 开关自动代答 'a'——新审批 ask 时经
//     gate.choose('a') 走 gate 的 resolve 路径，**不绕过 core 审批队列**（红线 6）；开关
//     开启瞬间已挂起的审批不自动代答（当次仍手动回答）；底边指示器显示 'always-approve'。
//     旧 Ctrl+O 折叠语义由 e/E/h/l 接管。
import type { ChatOptions } from '../../legacy-chat.js';
import {
  ASK_CANCELLED,
  setupChatSession,
  type ChatRuntime,
  type StreamEvent,
  type TurnResult,
  type TurnStreamHandler,
} from '../../chat-setup.js';
import { HELP_TEXT, parseCommand } from '../../commands.js';
import { expandContextRefs, hasContextRefs } from '../../context-ref.js';
import { createInputParser, type InputParser } from '../../input/parser.js';
import { createInputDispatcher, type InputDispatcher, type InputLayer } from '../../input/dispatcher.js';
import type { InputEvent } from '../../input/types.js';
import { summarizeArgs, turnSummaryLine } from '../../render.js';
import { describeSteerResult } from '../../steer.js';
import { createUiScheduler, type UiScheduler } from '../scheduler.js';
import {
  bindShutdownSignals,
  createCtrlCGuard,
  createShutdown,
  type ExitReason,
  type ShutdownController,
} from '../shutdown.js';
import { createNotifier, stderrSink, type Notifier } from '../notify.js';
import { emptyTranscript, transcriptReducer, type TranscriptEvent, type TranscriptItem } from '../transcript.js';
import type { WriteTarget } from '../renderer/diff-presenter.js';
import { ALT_SCREEN_EXIT, MOUSE_OFF, SHOW_CURSOR } from '../renderer/ansi.js';
import { Screen } from '../renderer/screen.js';
import { renderChat, resizeChat, type ChatScreenState } from './chat-screen.js';
import { projectTranscript, type ProjectionLine } from './projection.js';
import { Scrollback } from './scrollback.js';
import {
  attachInput,
  createChatController,
  createComposerLayer,
  type AttachedInput,
  type ChatController,
} from './chat-controller.js';
import { terminalEvent } from '../useTurnStream.js';

/** next 渲染开关（runInkChat 入口分支用；默认关闭 → legacy ink 不变） */
export function shouldUseNextRenderer(env: Record<string, string | undefined>): boolean {
  return env.HARNESS2_RENDERER === 'next';
}

// —— 常量（对齐既有装配的口径）——
const CTRL_C_WINDOW_MS = 2000; // Composer.CTRL_C_WINDOW_MS
const LIVE_FLUSH_MS = 50; // useTurnStream.FLUSH_MS
const IDLE_FLUSH_MS = 50; // chat-controller 文件头建议的空闲冲刷周期
const HINT_CLEAR_MS = 2000; // Composer 瞬时提示展示时长
const BRACKETED_PASTE_ON = '\x1b[?2004h'; // ansi.ts 无此常量（既有文件只读），本层自定义
const BRACKETED_PASTE_OFF = '\x1b[?2004l';
const FOCUS_REPORT_ON = '\x1b[?1004h'; // DECSET 1004 焦点上报（ansi.ts 无现成常量，同上自定义）
const FOCUS_REPORT_OFF = '\x1b[?1004l';

const SHORTCUTS: readonly string[] = ['Enter 发送', 'Shift+Enter 换行', 'Esc 停止', 'Ctrl+C 退出', 'PgUp/PgDn 滚动'];

const APPROVAL_ITEMS: readonly string[] = ['y 允许（本次）', 'a 总是允许（本会话）', 'n 拒绝'];
const APPROVAL_ANSWERS: readonly string[] = ['y', 'a', 'n'];

// —— 审批 gate（createDialogController 的非 React 等价，见文件头取舍说明）——

export interface ApprovalGate {
  /** 审批提问：resolve 值为 'y' | 'a' | 'n' | ASK_CANCELLED（与 setupChatSession 契约一致） */
  ask(query: string): Promise<string>;
  /** 用户选择（数字/Enter 路径）；未挂起时 no-op */
  choose(answer: 'y' | 'a' | 'n'): void;
  /** 取消（Esc / Ctrl-C / 新提问挤占）；未挂起时 no-op */
  cancel(): void;
  /** 当前挂起的提问（null = 无） */
  pending(): string | null;
}

export interface ApprovalGateBindings {
  /** ask() 挂起时回调（装配层据此打开 overlay） */
  onOpen(query: string): void;
  /** ask() 结算（选择/取消/挤占）后回调（装配层据此关闭 overlay） */
  onSettled(): void;
}

/** 创建审批 gate；bind 由装配层在创建 harness 时调用（ask 可先于 bind 发生，事件不回放） */
export function createApprovalGate(): ApprovalGate & { bind(bindings: ApprovalGateBindings): void } {
  let bindings: ApprovalGateBindings | null = null;
  let current: { query: string; resolve: (answer: string) => void } | null = null;

  function settle(answer: string): void {
    const c = current;
    if (c === null) return;
    current = null;
    bindings?.onSettled();
    c.resolve(answer);
  }

  return {
    ask(query) {
      if (current !== null) settle(ASK_CANCELLED); // 新提问挤占旧挂起（对齐 dialog.open 的 pending.resolve）
      return new Promise<string>((resolve) => {
        current = { query, resolve };
        bindings?.onOpen(query);
      });
    },
    choose(answer) {
      settle(answer);
    },
    cancel() {
      settle(ASK_CANCELLED);
    },
    pending: () => (current !== null ? current.query : null),
    bind(b) {
      bindings = b;
    },
  };
}

// —— turn 流桥（useTurnStream 的非 React 等价复刻；terminalEvent 纯函数直接复用）——

interface TurnStreamBridge {
  handler: TurnStreamHandler;
  /** turn 结束：清 timer 并产出终态事件（final/partial/empty；与 useTurnStream.finalize 同语义） */
  finalize(result: TurnResult | undefined): TranscriptEvent | null;
  reset(): void;
  dispose(): void;
}

/**
 * 差异说明（与 useTurnStream 对照）：Ink 的 live 快照只驱动 React 重渲、不产生转录项；
 * next 的 Scrollback 无法原地更新，live 文本以 assistant/step（turnId+stepIndex 稳定 id）
 * 承载——50ms flush 用当前 stepIndex 原地替换（reducer put 幂等），工具边界 flushStep
 * 递增 stepIndex 另起新段。终态 turn-final 与末段 step 文本重复时由装配层去重跳过
 * （否则 assistant:<turnId> 与 step:N 会显示两份相同正文）。
 */
function createTurnStreamBridge(onEvent: (event: TranscriptEvent) => void): TurnStreamBridge {
  let buffer: { turnId: string | undefined; text: string; reasoning: string } = {
    turnId: undefined,
    text: '',
    reasoning: '',
  };
  let stepIndex = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** 50ms live flush：把当前累积作为 step 项原地替换（有正文/推理才发，避免空气泡） */
  function flushLive(): void {
    timer = null;
    emitStep();
  }

  function emitStep(): boolean {
    const hasText = buffer.text.trim().length > 0;
    const hasReasoning = buffer.reasoning.trim().length > 0;
    if (!hasText && !hasReasoning) return false;
    onEvent({
      type: 'assistant/step',
      ...(buffer.turnId !== undefined ? { turnId: buffer.turnId } : {}),
      stepIndex,
      text: hasText ? buffer.text : '',
      ...(hasReasoning ? { reasoning: buffer.reasoning } : {}),
    });
    return true;
  }

  /** 工具边界 flushStep（对齐 useTurnStream：发了才递增 stepIndex 并清空缓冲） */
  function flushStep(): void {
    clearTimer();
    if (emitStep()) {
      stepIndex += 1;
      buffer = { turnId: buffer.turnId, text: '', reasoning: '' };
    }
  }

  function scheduleFlush(): void {
    if (timer !== null) return;
    timer = setTimeout(flushLive, LIVE_FLUSH_MS);
  }

  const handler: TurnStreamHandler = (event: StreamEvent) => {
    if (event.type === 'text-delta') {
      buffer.turnId = event.turnId;
      buffer.text += event.text;
      scheduleFlush();
      return;
    }
    if (event.type === 'reasoning-delta') {
      buffer.turnId = event.turnId;
      buffer.reasoning += event.text;
      scheduleFlush();
      return;
    }
    if (event.type === 'tool-call') {
      buffer.turnId = event.turnId;
      flushStep(); // 顺序保真：先落本 step 正文，再落工具项（后续文本另起一段）
      onEvent({
        type: 'tool/call',
        seq: 0,
        callId: event.call.id,
        tool: event.call.name,
        args: event.call.arguments,
        summary: summarizeArgs(event.call.arguments),
        turnId: event.turnId,
      });
      return;
    }
    // tool-result
    buffer.turnId = event.turnId;
    onEvent({
      type: 'tool/result',
      callId: event.callId,
      ok: event.ok,
      ...(event.error !== undefined ? { error: event.error } : {}),
      turnId: event.turnId,
    });
  };

  return {
    handler,
    finalize(result) {
      clearTimer();
      return terminalEvent(result, {
        turnId: buffer.turnId,
        text: buffer.text,
        reasoning: buffer.reasoning,
      });
    },
    reset() {
      clearTimer();
      stepIndex = 0;
      buffer = { turnId: undefined, text: '', reasoning: '' };
    },
    dispose() {
      clearTimer();
    },
  };
}

// —— 装配层依赖（测试注入缝；runNextChat 传真终端）——

export interface NextChatHarnessDeps {
  /** 渲染输出（Screen 的 WriteTarget；columns/rows 提供初始尺寸） */
  out: WriteTarget & { columns?: number; rows?: number };
  /** 装配期启动行（setupChatSession 的 line 钩子收集） */
  bootLines?: readonly string[];
  /** 环境变量（notifier 策略等；缺省 {} —— 测试确定性） */
  env?: Record<string, string | undefined>;
  /** 提醒 sink（缺省 stderrSink） */
  notifyWrite?: (s: string) => void;
  /** 审批 gate（runNextChat 先创建再传给 setupChatSession.askApproval） */
  gate: ApprovalGate & { bind?: (b: ApprovalGateBindings) => void };
  /** shutdown.finish 内的终端还原（runNextChat：拆屏/还原 raw mode/runtime.finish） */
  cleanup?: () => void | Promise<void>;
  /** 退出码出口（缺省 no-op；测试捕获，runNextChat 写 process.exitCode） */
  exit?: (code: number) => void;
  /** 外部已 start 的 Screen（runNextChat 自管启动序列时传入；缺省内部创建并 start） */
  screen?: Screen;
}

export interface NextChatHarness {
  /** Chat 整帧状态（滚动区/草稿/浮层/状态行——测试断言面） */
  readonly state: ChatScreenState;
  /** 喂原始输入字节（parser→dispatcher→controller 全链；有事件则渲染） */
  feed(bytes: Uint8Array | string): number;
  /** 空闲冲刷（孤立 ESC / 断流 paste 兜底）；真实路径由 50ms 定时器驱动 */
  flushIdle(now?: number): number;
  /** 立即排空 UI 调度器并渲染（测试确定性缝） */
  flushUi(): void;
  /** 终端尺寸变化（screen.resize + scrollback cols 契约同步） */
  resize(cols: number, rows: number): void;
  /** 提交入口（对齐 InkShell.submit：忙时入队、空闲执行；命令/turn 同一入口） */
  submit(text: string): void;
  /** Ctrl+C 语义入口（guard 协议；测试可直调，键盘路径经 controller.onInterrupt） */
  interrupt(): void;
  /** 退出请求（忙时先 abort、收尾后收敛；对齐 InkShell commandIo.requestExit） */
  requestExit(reason?: ExitReason): void;
  /** 审批选择/取消（编程入口；键盘路径经 approval 层） */
  approve(answer: 'y' | 'a' | 'n'): void;
  cancelApproval(): void;
  pendingApproval(): string | null;
  /** scrollback 逻辑行快照（测试断言用；wrap 段拼回 = 原逻辑行） */
  logicalLines(): string[];
  isBusy(): boolean;
  queueSnapshot(): readonly string[];
  awaitDone(): Promise<number>;
  /** 仅清理 timers（不触发退出；测试 afterEach 用） */
  dispose(): void;
}

export function createNextChatHarness(runtime: ChatRuntime, deps: NextChatHarnessDeps): NextChatHarness {
  const env = deps.env ?? {};
  const screen =
    deps.screen ??
    (() => {
      const s = new Screen(deps.out, Math.max(1, deps.out.columns ?? 80), Math.max(1, deps.out.rows ?? 24));
      s.start({ mouse: env.HARNESS2_MOUSE !== '0' });
      return s;
    })();

  // DECSET 1004 焦点上报（审查 P2）：与 screen.start 同一写出目标补写开启序列（幂等，
  // 重复写无害）；关闭序列在 runNextChat 的 cleanup 随 screen.stop 一并写出。开启后
  // parser 产出 focus 事件 → dispatcher 兜底更新 focused → notifier 策略自然生效。
  deps.out.write(FOCUS_REPORT_ON);

  // —— 状态 ——
  let transcript = emptyTranscript();
  const bootLines = deps.bootLines ?? [];
  bootLines.forEach((text, i) => {
    transcript = transcriptReducer(transcript, { type: 'system', id: `boot:${i}`, text });
  });
  const state: ChatScreenState = {
    scrollback: new Scrollback([], Math.max(1, screen.cols - 1)),
    draft: '',
    cursor: 0,
    candidates: null,
    overlays: [],
    shortcuts: SHORTCUTS,
    statusline: '',
    indicators: [],
  };

  let busy = false;
  let exitRequested = false;
  let pendingExitReason: ExitReason = 'exit';
  let userSeq = 0;
  let sysSeq = 0;
  let steerSeq = 0;
  let hint: string | null = null;
  let hintTimer: ReturnType<typeof setTimeout> | null = null;
  let focused = true; // DECSET 1004 焦点（缺省聚焦；unfocused 策略下不响，保守处理）
  const queue: string[] = [];
  let collapsed = new Set<number>(); // 折叠覆盖标记集（itemIndex 取反默认折叠态）
  let alwaysApprove = false; // Ctrl+O always-approve 开关（UI 层代答，见文件头红线 6 说明）
  let scrollbackFocus = false; // Tab 双态焦点：false = 输入框（默认），true = 滚动区（折叠键族生效）

  const contentCols = (): number => Math.max(1, screen.cols - 1);

  // —— 投影同步（增量追加 / 全量重建，见文件头取舍） ——
  let syncedItems: readonly TranscriptItem[] = [];
  let syncedLineCount = 0;

  function projectLines(): ProjectionLine[] {
    return projectTranscript(transcript.items, { cols: contentCols(), collapsed });
  }

  function rebuildScrollback(lines: readonly ProjectionLine[]): void {
    const old = state.scrollback;
    // 行对象直传（text + fg）：projection 的逐行配色随行进入 scrollback（P3-A 配色落地）
    const sb = new Scrollback(lines, contentCols());
    if (!old.follow) {
      // anchor 模式尽力保留视口：绝对 scrollTop 平移（新 maxScroll 钳制；取舍：重建即丢
      // wrap 缓存，anchor 语义以物理行数近似保持）
      sb.goToTop();
      if (old.scrollTopRow > 0) sb.scrollBy(old.scrollTopRow);
    }
    state.scrollback = sb;
  }

  function syncProjection(): void {
    const lines = projectLines();
    const items = transcript.items;
    let appendable = items.length >= syncedItems.length;
    if (appendable) {
      for (let i = 0; i < syncedItems.length; i += 1) {
        if (items[i] !== syncedItems[i]) {
          appendable = false;
          break;
        }
      }
    }
    if (appendable && items.length === syncedItems.length && lines.length === syncedLineCount) return; // 无变化
    if (appendable) {
      const added = lines.slice(syncedLineCount);
      if (added.length > 0) state.scrollback.appendLines(added); // ProjectionLine 直传（text + fg）
    } else {
      rebuildScrollback(lines);
    }
    syncedItems = [...items];
    syncedLineCount = lines.length;
  }

  /** 折叠/强制全量重投影（折叠变化时整体重建，见任务规格取舍） */
  function reprojectAll(): void {
    const lines = projectLines();
    rebuildScrollback(lines);
    syncedItems = [...transcript.items];
    syncedLineCount = lines.length;
    invalidate();
  }

  // —— 渲染与 chrome ——
  function refreshChrome(): void {
    const parts = [String(runtime.mode()), `provider ${runtime.provider.name}`];
    if (busy) parts.push('⏺ 运行中…');
    if (queue.length > 0) parts.push(`已排队 ${queue.length}`);
    state.statusline = parts.join(' · ');
    // 底边指示：always-approve（Ctrl+O 开关）/ scrollback（Tab 焦点）常驻，hint 瞬时叠加
    const ind: string[] = [];
    if (alwaysApprove) ind.push('always-approve');
    if (scrollbackFocus) ind.push('scrollback');
    if (hint !== null) ind.push(hint);
    state.indicators = ind;
  }

  function invalidate(): void {
    refreshChrome();
    renderChat(screen, state);
  }

  // —— UI 调度器（T4 有界合并，对齐 InkShell 的 16ms/64 批）——
  const scheduler: UiScheduler<TranscriptEvent> = createUiScheduler<TranscriptEvent>({
    flushMs: 16,
    maxBatch: 64,
    onFlush: (batch) => {
      transcript = batch.reduce(transcriptReducer, transcript);
      syncProjection();
      invalidate();
    },
  });

  function dispatch(event: TranscriptEvent): void {
    scheduler.push(event);
  }

  function flushUi(): void {
    scheduler.flushNow();
  }

  function sendSystem(text: string): void {
    sysSeq += 1;
    dispatch({ type: 'system', id: `sys:${sysSeq}`, text });
    flushUi(); // 低频：立即落定可见（对齐 InkShell 命令输出的即时性）
  }

  // —— 提示（Ctrl+C 协议瞬时提示；绝不写入草稿）——
  function clearHint(): void {
    if (hintTimer !== null) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
    if (hint !== null) {
      hint = null;
      invalidate();
    }
  }

  function showHint(msg: string): void {
    clearHint();
    hint = msg;
    hintTimer = setTimeout(() => {
      hintTimer = null;
      hint = null;
      invalidate();
    }, HINT_CLEAR_MS);
    invalidate();
  }

  // —— 审批 overlay ——
  let approvalActiveIndex = 0;

  function openApproval(query: string): void {
    // 问题全文放标题行（drawOverlay 按宽裁剪）；选项固定 y/a/n——对齐 Ink ConfirmDialog 的
    // 「问题 + 选择列表」语义（近似：无独立问题行，标题承载）
    approvalActiveIndex = 0;
    state.overlays = [{ title: `Approval · ${query}`, items: APPROVAL_ITEMS, activeIndex: 0 }];
    controller.blur(); // overlay 互斥接管键盘（对齐 InkShell 的 overlayOpen 语义）
    invalidate();
  }

  function closeApproval(): void {
    state.overlays = [];
    controller.focus();
    invalidate();
  }

  function syncApprovalOverlay(): void {
    const overlay = state.overlays[0];
    if (overlay !== undefined) state.overlays = [{ ...overlay, activeIndex: approvalActiveIndex }];
  }

  function chooseApproval(index: number): void {
    const answer = APPROVAL_ANSWERS[index];
    if (answer === undefined) return;
    gate.choose(answer as 'y' | 'a' | 'n');
  }

  // —— Ctrl+O always-approve（UI 开关；开关态只影响**新**审批的代答，见文件头红线 6）——
  function toggleAlwaysApprove(): void {
    alwaysApprove = !alwaysApprove;
    invalidate();
  }

  const gate = deps.gate;
  gate.bind?.({
    onOpen: (query) => {
      openApproval(query);
      // always-approve 开启时自动代答 'a'：经 gate.choose 走 resolve 路径（红线 6：
      // 不绕过 core 审批队列）；切换瞬间已挂起的审批不在此路径（onOpen 只对新 ask 触发）
      if (alwaysApprove) gate.choose('a');
    },
    onSettled: () => closeApproval(),
  });

  // —— Ctrl+C 协议（对齐 Composer）——
  const ctrlCGuard = createCtrlCGuard({ windowMs: CTRL_C_WINDOW_MS });

  function abortCurrentTurn(): void {
    if (!busy) return;
    sendSystem('^C（正在取消当前 turn…）');
    runtime.abortTurn();
  }

  function interrupt(): void {
    if (gate.pending() !== null) {
      gate.cancel(); // 审批挂起时 Ctrl+C = 取消审批（对齐 Ink 的 Esc/Ctrl+C 便利取消）
      return;
    }
    const verdict = ctrlCGuard.press({ busy });
    if (verdict === 'cancel') {
      clearHint();
      abortCurrentTurn();
      return;
    }
    if (verdict === 'confirm') {
      clearHint();
      requestExit('sigint');
      return;
    }
    showHint('（再按一次 Ctrl+C 退出）');
  }

  // —— 退出（createShutdown 幂等路径；忙时先 abort、收尾后收敛）——
  const shutdown: ShutdownController = createShutdown({
    finish: async () => {
      attached.detach();
      clearTimers();
      await deps.cleanup?.();
    },
    exit: (code) => {
      deps.exit?.(code);
    },
  });

  function requestExit(reason: ExitReason = 'exit'): void {
    if (shutdown.isShuttingDown()) return;
    if (busy) {
      // turn 进行中：先取消，等本轮收尾后由 finally 触发退出（对齐 InkShell requestExit）
      exitRequested = true;
      pendingExitReason = reason;
      runtime.abortTurn();
      return;
    }
    shutdown.request(reason);
  }

  // —— 提交 / 队列（对齐 InkShell.submit 的 FIFO 队列语义）——
  function enqueue(text: string): void {
    queue.push(text);
    invalidate();
  }

  function drainQueue(): void {
    if (shutdown.isShuttingDown()) return;
    const next = queue.shift();
    if (next === undefined) return;
    invalidate();
    void handleUserText(next);
  }

  function submit(text: string): void {
    if (text.trim().length === 0) return;
    if (busy) {
      enqueue(text);
      return;
    }
    void handleUserText(text);
  }

  async function runTurnText(text: string): Promise<void> {
    bridge.reset();
    busy = true;
    userSeq += 1;
    // 输入优先：user 回显立即落定（对齐 InkShell dispatchInputNow）
    scheduler.setInputPriority(true);
    scheduler.push({ type: 'user/message', seq: 0, id: `user:live:${userSeq}`, text });
    scheduler.flushNow();
    scheduler.setInputPriority(false);
    invalidate();
    let result: TurnResult | undefined;
    try {
      // @file/@dir 引用解析（对齐 InkShell：发送前预处理，回显保持原文）
      let sendText = text;
      if (hasContextRefs(text)) {
        const ref = expandContextRefs(text, { cwd: runtime.root, root: runtime.root });
        if (ref.hasRefs && ref.header.length > 0) sendText = `${ref.header}\n\n${text}`;
      }
      result = await runtime.runUserTurn(sendText, bridge.handler);
      const terminal = bridge.finalize(result);
      if (terminal !== null && !isDuplicateFinal(terminal)) dispatch(terminal);
      if (result !== undefined) {
        dispatch({ type: 'status', id: `status:${userSeq}`, text: turnSummaryLine(result) });
      }
    } catch (e) {
      sendSystem(`error: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      bridge.reset();
      busy = false;
      scheduler.flushNow(); // final flush：终态/状态行立即落定
      invalidate();
      // 回合结束提醒（cancelled 不发；退出中不发；异常结束照发——对齐 InkShell）
      if (!shutdown.isShuttingDown()) {
        notifier.onTurnComplete({ focused, cancelled: result?.stopReason === 'cancelled' });
      }
      if (exitRequested && !shutdown.isShuttingDown()) {
        exitRequested = false;
        shutdown.request(pendingExitReason);
      } else {
        drainQueue();
      }
    }
  }

  // —— 命令（next 模式最小集，见文件头暂缺项）——
  function handleUserText(text: string): void {
    const parsed = parseCommand(text);
    if (parsed !== null) {
      sysSeq += 1;
      scheduler.setInputPriority(true);
      scheduler.push({ type: 'system', id: `echo:${sysSeq}`, text: `> ${text}` });
      scheduler.flushNow();
      scheduler.setInputPriority(false);
      handleCommand(parsed);
      return;
    }
    void runTurnText(text);
  }

  function handleCommand(parsed: { name: string; rest: string }): void {
    switch (parsed.name) {
      case '/help':
      case '/?':
        sendSystem(HELP_TEXT);
        return;
      case '/exit':
      case '/quit':
        requestExit('exit');
        return;
      default:
        sendSystem(`next 渲染层暂不支持命令 ${parsed.name}（当前支持 /help /exit /quit；其余请用缺省 ink 路径）`);
    }
  }

  // —— turn 流桥与终态去重 ——
  let lastStep: { turnId: string | undefined; text: string } | null = null;
  const bridge = createTurnStreamBridge((event) => {
    if (event.type === 'assistant/step') lastStep = { turnId: event.turnId, text: event.text };
    dispatch(event);
  });

  /** turn-final 与末段 step 文本重复时跳过（避免同正文显示两份，见 bridge 差异说明） */
  function isDuplicateFinal(event: TranscriptEvent): boolean {
    if (event.type !== 'turn-final') return false;
    return (
      lastStep !== null &&
      event.text === lastStep.text &&
      (lastStep.turnId === undefined || event.turnId === undefined || event.turnId === lastStep.turnId)
    );
  }

  // —— 折叠键族（P3-A，keymap 裁决：旧 Ctrl+O 折叠语义迁移至 e/E/h/l）——
  // collapsed 覆盖集语义（见 projection.ts）：在集 = 与该 item 默认折叠态取反；
  // 工具/推理 item 的默认态都是折叠 → 全量展开 = 收录全部可折叠下标，全量折叠 = 清空集。
  function isCollapsibleItem(item: TranscriptItem | undefined): boolean {
    return item !== undefined && (item.kind === 'tool' || (item.kind === 'assistant' && item.reasoning !== undefined));
  }

  /** 最近一次工具/推理 item 下标（next 无块光标，h/l 取最近可折叠 item，对齐旧 Ctrl+O 定位） */
  function lastCollapsibleIndex(): number {
    for (let i = transcript.items.length - 1; i >= 0; i -= 1) {
      if (isCollapsibleItem(transcript.items[i])) return i;
    }
    return -1;
  }

  /** e：展开全部块（覆盖集 = 全部可折叠 item 下标 + 全量重投影） */
  function expandAllBlocks(): void {
    const next = new Set<number>();
    transcript.items.forEach((item, i) => {
      if (isCollapsibleItem(item)) next.add(i);
    });
    collapsed = next;
    reprojectAll();
  }

  /** E：折叠全部块（覆盖集清空 = 纯默认态，全量重投影） */
  function collapseAllBlocks(): void {
    collapsed = new Set<number>();
    reprojectAll();
  }

  /** h/l：折叠（false）/ 展开（true）最近一次工具/推理块 */
  function setNearestBlockExpanded(expand: boolean): void {
    const idx = lastCollapsibleIndex();
    if (idx < 0) return;
    const next = new Set(collapsed);
    if (expand) next.add(idx);
    else next.delete(idx);
    collapsed = next;
    reprojectAll();
  }

  // —— 输入装配（parser → dispatcher（approval > composer）→ 兜底）——
  const approvalLayer: InputLayer = {
    name: 'approval',
    handle: (event: InputEvent): boolean => {
      if (gate.pending() === null) return false;
      if (event.type !== 'key') return false;
      const ev = event;
      const n = APPROVAL_ITEMS.length;
      if (ev.key === 'up' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        approvalActiveIndex = (approvalActiveIndex - 1 + n) % n;
        syncApprovalOverlay();
        invalidate();
        return true;
      }
      if (ev.key === 'down' && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        approvalActiveIndex = (approvalActiveIndex + 1) % n;
        syncApprovalOverlay();
        invalidate();
        return true;
      }
      if (ev.key === 'enter' && !ev.modifiers.ctrl && !ev.modifiers.alt && !ev.modifiers.shift) {
        chooseApproval(approvalActiveIndex);
        return true;
      }
      if (!ev.modifiers.ctrl && !ev.modifiers.alt) {
        const idx = ['1', '2', '3'].indexOf(ev.key);
        if (idx >= 0) {
          chooseApproval(idx);
          return true;
        }
      }
      if (ev.key === 'escape') {
        gate.cancel();
        return true;
      }
      if (ev.modifiers.ctrl && ev.key === 'c') {
        gate.cancel();
        return true;
      }
      // Ctrl+O 在审批卡上切换 always-approve（grok 卡片键位）：只动开关，**不代答当次**
      if (ev.modifiers.ctrl && ev.key === 'o') {
        toggleAlwaysApprove();
        return true;
      }
      return false;
    },
  };

  const controller: ChatController = createChatController(state, {
    onSubmit: (text) => submit(text),
    onInterrupt: () => interrupt(),
    extraKeyHandler: (ev) => {
      if (ev.modifiers.ctrl && ev.key === 'c') return 'ignored'; // 让内置 onInterrupt（guard 协议）处理
      // 其余任意按键重置退出协议（对齐 Composer：非 Ctrl+C 按键清窗口与提示）
      ctrlCGuard.reset();
      clearHint();
      // Ctrl+D 不在此拦截：keymap 裁决 = 半页下滚，由 chat-controller 内置消费（半页滚动
      // 与退出语义不冲突——退出只走 Ctrl+C 双击与 /exit，见文件头裁决说明）
      if (ev.key === 'escape') {
        if (busy) {
          abortCurrentTurn(); // 忙时 Esc：停止当前 turn（不清草稿，对齐 Composer）
          return 'consumed';
        }
        state.draft = '';
        state.cursor = 0;
        return 'consumed';
      }
      // Ctrl+O = always-approve 切换（keymap 裁决；旧折叠语义迁移 e/E/h/l，见文件头）
      if (ev.modifiers.ctrl && ev.key === 'o') {
        toggleAlwaysApprove();
        return 'consumed';
      }
      // Tab = 输入框/滚动区双态焦点（keymap 裁决采纳）。候选可见时不在本层切换：
      // 条件短路返回 'ignored'，Tab 落到 controller 内置裁决 = 接受候选（优先级保持）
      if (
        ev.key === 'tab' &&
        !ev.modifiers.ctrl &&
        !ev.modifiers.alt &&
        !ev.modifiers.shift &&
        state.candidates === null
      ) {
        scrollbackFocus = !scrollbackFocus;
        invalidate();
        return 'consumed';
      }
      // 滚动区焦点下的块折叠键族（仅无 Ctrl/Alt 修饰；grok 为选中块导航，此处 h/l 取
      // 最近工具/推理 item，差异已登记 keymap 文档）
      if (scrollbackFocus && !ev.modifiers.ctrl && !ev.modifiers.alt) {
        if (ev.key === 'e') {
          expandAllBlocks();
          return 'consumed';
        }
        if (ev.key === 'E') {
          collapseAllBlocks();
          return 'consumed';
        }
        if (ev.key === 'h') {
          setNearestBlockExpanded(false);
          return 'consumed';
        }
        if (ev.key === 'l') {
          setNearestBlockExpanded(true);
          return 'consumed';
        }
        if (ev.text !== undefined && ev.text.length > 0) {
          // 其余字母键自动回到输入框（grok simple 模式语义），字符照常走内置插入
          scrollbackFocus = false;
          invalidate();
          return 'ignored';
        }
      }
      return 'ignored';
    },
  });

  const dispatcher: InputDispatcher = createInputDispatcher({
    layers: [approvalLayer, createComposerLayer(controller)],
    fallback: (event) => {
      if (event.type === 'focus') {
        focused = event.direction === 'in';
        invalidate();
      }
    },
  });

  const parser: InputParser = createInputParser();
  const attached: AttachedInput = attachInput(parser, controller, dispatcher);

  function feed(bytes: Uint8Array | string): number {
    const n = attached.feed(bytes);
    if (n > 0) invalidate();
    return n;
  }

  function flushIdle(now?: number): number {
    const n = attached.flushIdle(now);
    if (n > 0) invalidate();
    return n;
  }

  // 空闲冲刷定时器（孤立 ESC → Esc 键、断流 paste 兜底；见 chat-controller 文件头）
  const idleTimer = setInterval(() => {
    flushIdle();
  }, IDLE_FLUSH_MS);

  function clearTimers(): void {
    clearInterval(idleTimer);
    scheduler.dispose();
    bridge.dispose();
    if (hintTimer !== null) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
  }

  // —— steer 观察（T5：回帧 → 转录报告，对齐 InkShell）——
  runtime.observeSteer((result) => {
    steerSeq += 1;
    const { line } = describeSteerResult(result);
    sysSeq += 1;
    dispatch({ type: 'system', id: `steer:${steerSeq}`, text: line });
    flushUi();
  });

  // —— notifier（T4：回合结束提醒；sink 注入便于测试）——
  const notifier: Notifier = createNotifier(env, deps.notifyWrite ?? stderrSink());

  // 初始帧
  syncProjection();
  invalidate();

  return {
    state,
    feed,
    flushIdle,
    flushUi,
    resize(cols, rows) {
      const prevCols = screen.cols;
      resizeChat(screen, state, cols, rows);
      if (Math.max(1, cols) !== prevCols) {
        // 宽度变化：截断/摘要行按新宽度重排——强制全量重投影（审查 P2；只调 rows 不重投影）
        reprojectAll();
      } else {
        invalidate();
      }
    },
    submit,
    interrupt,
    requestExit,
    approve(answer) {
      gate.choose(answer);
    },
    cancelApproval() {
      gate.cancel();
    },
    pendingApproval: () => gate.pending(),
    logicalLines() {
      const sb = state.scrollback;
      const out: string[] = [];
      for (let i = 0; i < sb.lineCount; i += 1) out.push(sb.rowOf(i).join(''));
      return out;
    },
    isBusy: () => busy,
    queueSnapshot: () => [...queue],
    awaitDone: () => shutdown.awaitDone(),
    dispose() {
      clearTimers();
    },
  };
}

// —— 真机装配（HARNESS2_RENDERER=next 分支入口；由 runInkChat.tsx 调用）——

/**
 * 进程退出兜底还原（审查 P1）：同步写出关鼠标上报 + 显示光标 + 退 alt-screen 到 stdout，
 * 并尝试复位 stdin raw mode。序列天然幂等——正常退出路径 screen.stop 已还原过，重复写无害。
 * 只能在 process 'exit' 回调内同步调用（异步操作不执行）；流已销毁时吞错，绝不阻塞退出。
 */
export function emergencyTerminalRestore(
  out: Pick<WriteTarget, 'write'>,
  stdin: { setRawMode?: (mode: boolean) => void } | undefined,
): void {
  try {
    out.write(MOUSE_OFF + SHOW_CURSOR + ALT_SCREEN_EXIT);
  } catch {
    // 流已销毁：兜底写出失败不阻塞退出
  }
  try {
    stdin?.setRawMode?.(false);
  } catch {
    // 流已销毁：还原失败不阻塞退出
  }
}

/**
 * 挂 process 'exit' 监听兜底还原终端：异常退出（未捕获异常、异步还原路径被跳过等）下，
 * 进程退出前同步恢复终端状态。返回解绑函数（shutdown 收敛后调用；proc 可注入供
 * headless 测试验证注册/解绑与兜底写出序列）。
 */
export function bindEmergencyExitRestore(
  out: Pick<WriteTarget, 'write'>,
  stdin: { setRawMode?: (mode: boolean) => void } | undefined,
  proc: Pick<NodeJS.Process, 'on' | 'off'> = process,
): () => void {
  const onExit = (): void => emergencyTerminalRestore(out, stdin);
  proc.on('exit', onExit);
  return () => {
    proc.off('exit', onExit);
  };
}

/**
 * next 渲染层的 chat 入口：setupChatSession（与 legacy/ink 共用）→ Screen 全屏帧循环。
 * 终端生命周期：进 alt-screen（Screen.start，含鼠标上报）→ DECSET 1004 焦点上报 →
 * bracketed paste 开启 → stdin raw mode；退出经 createShutdown.finish 统一还原（拆屏 /
 * 焦点上报关闭 / paste 关闭 / raw mode 还原 / runtime.finish），SIGTERM/SIGHUP 走
 * bindShutdownSignals 同一幂等路径；process 'exit' 另有同步兜底（bindEmergencyExitRestore）。
 */
export async function runNextChat(options: ChatOptions = {}): Promise<void> {
  const bootLines: string[] = [];
  const gate = createApprovalGate();
  const runtime = await setupChatSession(options, {
    line: (t) => bootLines.push(t),
    // 审批弹窗：经 gate 打开 overlay，选择后 resolve；挤占/取消 resolve 为 ASK_CANCELLED
    askApproval: (query) => gate.ask(query),
  });

  const stdout = process.stdout as NodeJS.WriteStream & { columns?: number; rows?: number };
  const stdin = process.stdin;
  const env = process.env;
  const canRaw = stdin.isTTY === true && typeof stdin.setRawMode === 'function';
  const mouseEnabled = env.HARNESS2_MOUSE !== '0';

  const screen = new Screen(stdout, Math.max(1, stdout.columns ?? 80), Math.max(1, stdout.rows ?? 24));
  screen.start({ mouse: mouseEnabled });
  // DECSET 1004 由 createNextChatHarness 装配时补写（本函数传入的正是同一 stdout，单次写出）
  stdout.write(BRACKETED_PASTE_ON); // ink usePaste 由 ink 自动开启；next 路径自行开关（parser 只负责解析）
  if (canRaw) stdin.setRawMode(true);

  // 审查 P1：进程退出兜底（'exit' 回调内同步还原终端；正常路径已还原，序列幂等无副作用）
  const detachExitRestore = bindEmergencyExitRestore(stdout, canRaw ? stdin : undefined);

  const harness = createNextChatHarness(runtime, {
    out: stdout,
    bootLines,
    env,
    gate,
    screen,
    cleanup: async () => {
      screen.stop(); // 关鼠标上报 + 显示光标 + 退 alt-screen（幂等）
      stdout.write(FOCUS_REPORT_OFF); // 关焦点上报（与 1004h 成对；重复写无害）
      stdout.write(BRACKETED_PASTE_OFF);
      if (canRaw) {
        try {
          stdin.setRawMode(false);
        } catch {
          // 流已销毁：还原失败不阻塞退出
        }
      }
      await runtime.finish({ destroyInput: () => stdin.destroy() });
    },
    exit: (code) => {
      process.exitCode = code; // 不 abrupt process.exit，让拆屏与锁释放完成（对齐 runInkChat）
    },
  });

  const onResize = (): void => {
    harness.resize(Math.max(1, stdout.columns ?? 80), Math.max(1, stdout.rows ?? 24));
  };
  stdout.on('resize', onResize);
  const onData = (chunk: string | Buffer): void => {
    harness.feed(chunk); // Buffer 是 Uint8Array，parser 直接消化
  };
  stdin.on('data', onData);

  // 审查 P2 同口径：SIGTERM（kill）/SIGHUP（终端关闭）复用幂等退出路径，收敛后解绑
  const detachSignals = bindShutdownSignals((reason) => harness.requestExit(reason));

  await harness.awaitDone();
  detachSignals();
  detachExitRestore(); // 正常收敛后解绑 exit 兜底监听（无残留监听；异常路径由兜底已覆盖）
  stdout.off('resize', onResize);
  stdin.off('data', onData);
}
