// W2 chat-controller 单测（headless）：统一输入层事件 → ChatScreenState 变更。
// 原则：主路径全部用**原始字节**喂 createInputParser 再走 attachInput（parser→controller 全链）；
// 另设一组直达单测（直接调 handleKey/handlePaste/handleMouse）钉住返回值语义
// （'consumed'|'ignored'）与 focus 门控。滚动断言基于 Scrollback 的 follow/scrollTopRow 状态。
import { describe, expect, it } from 'vitest';
import { createInputParser, type InputParser } from '../../../src/input/parser.js';
import { createInputDispatcher, type InputLayer } from '../../../src/input/dispatcher.js';
import { noModifiers, type InputEvent, type KeyEvent } from '../../../src/input/types.js';
import {
  attachInput,
  createChatController,
  createComposerLayer,
  type AttachedInput,
  type ChatController,
} from '../../../src/tui/next/chat-controller.js';
import { Scrollback } from '../../../src/tui/next/scrollback.js';
import type { ChatScreenState } from '../../../src/tui/next/chat-screen.js';

// —— 常用原始字节序列（终端标准编码）——
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const HOME = '\x1b[H';
const END = '\x1b[F';
const DELETE = '\x1b[3~';
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const CTRL_LEFT = '\x1b[1;5D';
const SHIFT_ENTER = '\x1b[13;2u'; // kitty CSI-u：Shift+Enter
const WHEEL_UP = '\x1b[<64;10;5M'; // SGR 滚轮上（cb=64）
const WHEEL_DOWN = '\x1b[<65;10;5M'; // SGR 滚轮下（cb=65）
const MOUSE_DOWN = '\x1b[<0;10;5M'; // SGR 左键按下（非滚轮）
const pasteOf = (s: string): string => `\x1b[200~${s}\x1b[201~`; // bracketed paste 包裹

// —— 装配 ——
interface Harness {
  state: ChatScreenState;
  ctrl: ChatController;
  parser: InputParser;
  attached: AttachedInput;
  submitted: string[];
  interrupted: number[];
  clock: { now: number };
}

function makeState(lines: readonly string[] = [], draft = '', cursor = draft.length): ChatScreenState {
  return {
    scrollback: new Scrollback(lines, 40),
    draft,
    cursor,
    candidates: null,
    overlays: [],
    shortcuts: [],
  };
}

function makeHarness(
  lines: readonly string[] = [],
  opts: { history?: readonly string[]; draft?: string; cursor?: number } | string = {},
): Harness {
  const draft = typeof opts === 'string' ? opts : (opts.draft ?? '');
  const cursor = typeof opts === 'string' ? draft.length : (opts.cursor ?? draft.length);
  const history = typeof opts === 'string' ? undefined : opts.history;
  const submitted: string[] = [];
  const interrupted: number[] = [];
  const clock = { now: 1_000_000 };
  const state = makeState(lines, draft, cursor);
  const ctrl = createChatController(state, {
    history,
    onSubmit: (t) => submitted.push(t),
    onInterrupt: () => interrupted.push(1),
  });
  const parser = createInputParser({ now: () => clock.now, escTimeoutMs: 50, pasteIdleTimeoutMs: 1500 });
  const attached = attachInput(parser, ctrl);
  return { state, ctrl, parser, attached, submitted, interrupted, clock };
}

/** 直达单测用 KeyEvent 构造（模拟 parser 产出口径） */
function keyEvent(key: string, text?: string, modifiers = noModifiers()): KeyEvent {
  return { type: 'key', key, modifiers, ...(text !== undefined ? { text } : {}), consumed: false };
}
const CTRL = { shift: false, alt: false, ctrl: true } as const;

const HUNDRED_LINES = Array.from({ length: 100 }, (_, i) => `line${i}`);

// —— 直达单测（不经 parser，钉返回值与 focus 门控）——
describe('chat-controller 直达单测', () => {
  it('可打印字符插入光标处并返回 consumed', () => {
    const h = makeHarness();
    expect(h.ctrl.handleKey(keyEvent('a', 'a'))).toBe('consumed');
    expect(h.state.draft).toBe('a');
    expect(h.state.cursor).toBe(1);
  });

  it('Backspace 一次删除整个 grapheme（中文）', () => {
    const h = makeHarness([], '你好');
    expect(h.ctrl.handleKey(keyEvent('backspace'))).toBe('consumed');
    expect(h.state.draft).toBe('你');
    expect(h.state.cursor).toBe(1);
  });

  it('Ctrl+C 每次上报 onInterrupt（双击窗口留给装配层）', () => {
    const h = makeHarness();
    expect(h.ctrl.handleKey(keyEvent('c', undefined, CTRL))).toBe('consumed');
    expect(h.ctrl.handleKey(keyEvent('c', undefined, CTRL))).toBe('consumed');
    expect(h.interrupted.length).toBe(2);
    expect(h.submitted.length).toBe(0);
  });

  it('未识别键（f1）返回 ignored 且不改状态', () => {
    const h = makeHarness([], 'abc');
    expect(h.ctrl.handleKey(keyEvent('f1'))).toBe('ignored');
    expect(h.state.draft).toBe('abc');
    expect(h.state.cursor).toBe(3);
  });

  it('blur 后全部 ignored，focus() 恢复', () => {
    const h = makeHarness();
    h.ctrl.blur();
    expect(h.ctrl.isFocused()).toBe(false);
    expect(h.ctrl.handleKey(keyEvent('a', 'a'))).toBe('ignored');
    expect(h.state.draft).toBe('');
    h.ctrl.focus();
    expect(h.ctrl.handleKey(keyEvent('a', 'a'))).toBe('consumed');
    expect(h.state.draft).toBe('a');
  });

  it('setCandidates 设置候选并钳制 activeIndex；clearCandidates 置 null', () => {
    const h = makeHarness();
    h.ctrl.setCandidates(['/a', '/b', '/c'], 99);
    expect(h.state.candidates).toEqual({ items: ['/a', '/b', '/c'], activeIndex: 2 });
    h.ctrl.setCandidates([], 0);
    expect(h.state.candidates).toBeNull();
    h.ctrl.setCandidates(['/x'], 0);
    h.ctrl.clearCandidates();
    expect(h.state.candidates).toBeNull();
  });

  it('pushHistory 后 ↑ 直达回溯到该条目', () => {
    const h = makeHarness();
    h.ctrl.pushHistory('old-entry');
    expect(h.ctrl.handleKey(keyEvent('up'))).toBe('consumed');
    expect(h.state.draft).toBe('old-entry');
  });
});

// —— 原始字节 → parser → attachInput：插入 / 删除 ——
describe('原始字节链路：插入与删除', () => {
  it('ASCII 连续插入', () => {
    const h = makeHarness();
    h.attached.feed('hello');
    expect(h.state.draft).toBe('hello');
    expect(h.state.cursor).toBe(5);
  });

  it('中文多字节跨 feed 不撕裂（流式 UTF-8）', () => {
    const h = makeHarness();
    h.attached.feed('你');
    h.attached.feed('好世界');
    expect(h.state.draft).toBe('你好世界');
    expect(h.state.cursor).toBe(4);
  });

  it('Backspace（0x7f）删一个汉字', () => {
    const h = makeHarness([], '你好');
    h.attached.feed('\x7f');
    expect(h.state.draft).toBe('你');
    expect(h.state.cursor).toBe(1);
  });

  it('Delete 键删光标处字符（光标不动）', () => {
    const h = makeHarness([], { draft: 'abc', cursor: 1 });
    h.attached.feed(DELETE);
    expect(h.state.draft).toBe('ac');
    expect(h.state.cursor).toBe(1);
  });

  it('光标中间插入：ab ← X → aXb', () => {
    const h = makeHarness();
    h.attached.feed('ab');
    h.attached.feed(LEFT);
    h.attached.feed('X');
    expect(h.state.draft).toBe('aXb');
    expect(h.state.cursor).toBe(2);
  });

  it('emoji 代理对：插入整体、Backspace 整体删除（不残留半码元）', () => {
    const h = makeHarness();
    h.attached.feed('👍');
    expect(h.state.draft).toBe('👍');
    expect(h.state.cursor).toBe(2);
    h.attached.feed('\x7f');
    expect(h.state.draft).toBe('');
    expect(h.state.cursor).toBe(0);
  });
});

// —— 光标移动 ——
describe('光标移动', () => {
  it('←← 跨代理对不劈码元（a👍b 从末尾左移两次落点 1 而非 2）', () => {
    const h = makeHarness([], { draft: 'a👍b', cursor: 4 });
    h.attached.feed(LEFT);
    h.attached.feed(LEFT);
    expect(h.state.cursor).toBe(1);
  });

  it('→ 跨代理对同样安全（从 0 右移两次到 b 前）', () => {
    const h = makeHarness([], { draft: 'a👍b', cursor: 0 });
    h.attached.feed(RIGHT);
    h.attached.feed(RIGHT);
    expect(h.state.cursor).toBe(3);
  });

  it('HOME 行首 / END 行尾', () => {
    const h = makeHarness([], 'abc');
    h.attached.feed(HOME);
    expect(h.state.cursor).toBe(0);
    h.attached.feed(END);
    expect(h.state.cursor).toBe(3);
  });

  it('多行草稿 HOME 移到当前逻辑行行首', () => {
    const h = makeHarness([], 'ab\ncd');
    h.attached.feed(HOME);
    expect(h.state.cursor).toBe(3);
  });

  it('Ctrl+← 词移动', () => {
    const h = makeHarness([], 'one two');
    h.attached.feed(CTRL_LEFT);
    expect(h.state.cursor).toBe(4);
  });
});

// —— 多行草稿与 Shift+Enter ——
describe('多行草稿 ↑↓ 与 Shift+Enter', () => {
  it('Shift+Enter（kitty \\x1b[13;2u）插入硬换行，不提交', () => {
    const h = makeHarness();
    h.attached.feed(SHIFT_ENTER);
    h.attached.feed('ok');
    expect(h.state.draft).toBe('\nok');
    expect(h.submitted.length).toBe(0);
  });

  it('多行草稿 ↑↓ 在逻辑行间移动（列记忆）', () => {
    const h = makeHarness([], 'ab\ncd\nef');
    h.attached.feed(UP);
    expect(h.state.cursor).toBe(5); // 'cd' 行尾
    h.attached.feed(UP);
    expect(h.state.cursor).toBe(2); // 'ab' 行尾
    h.attached.feed(DOWN);
    expect(h.state.cursor).toBe(5);
  });

  it('单行草稿 ↑：无历史时不改草稿但仍消费', () => {
    const h = makeHarness();
    h.attached.feed('abc');
    h.attached.feed(UP);
    expect(h.state.draft).toBe('abc');
    expect(h.state.cursor).toBe(3);
  });
});

// —— 历史回溯 ——
describe('历史回溯与提交', () => {
  it('Enter 提交：onSubmit 收到文本、草稿清空、入历史', () => {
    const h = makeHarness();
    h.attached.feed('one');
    h.attached.feed('\r');
    expect(h.submitted).toEqual(['one']);
    expect(h.state.draft).toBe('');
    expect(h.state.cursor).toBe(0);
    h.attached.feed(UP);
    expect(h.state.draft).toBe('one');
  });

  it('空白草稿 Enter：消费但不提交、不入历史（↑ 边界不动作、草稿原样保留）', () => {
    const h = makeHarness();
    h.attached.feed('   ');
    h.attached.feed('\r');
    expect(h.submitted.length).toBe(0);
    h.attached.feed(UP);
    expect(h.state.draft).toBe('   ');
  });

  it('↑↓ 往返历史：two → one → two → 恢复原草稿', () => {
    const h = makeHarness();
    h.attached.feed('one\r');
    h.attached.feed('two\r');
    h.attached.feed(UP);
    expect(h.state.draft).toBe('two');
    h.attached.feed(UP);
    expect(h.state.draft).toBe('one');
    h.attached.feed(DOWN);
    expect(h.state.draft).toBe('two');
    h.attached.feed(DOWN);
    expect(h.state.draft).toBe('');
  });

  it('历史往返恢复进入前的原草稿（含光标）', () => {
    const h = makeHarness();
    h.attached.feed('one\r');
    h.attached.feed('abc');
    h.attached.feed(LEFT); // cursor 2
    h.attached.feed(UP);
    expect(h.state.draft).toBe('one');
    h.attached.feed(DOWN);
    expect(h.state.draft).toBe('abc');
    expect(h.state.cursor).toBe(2);
  });

  it('opts.history 作为种子：首次 ↑ 回溯到种子最后一条', () => {
    const h = makeHarness([], { history: ['old1', 'old2'] });
    h.attached.feed(UP);
    expect(h.state.draft).toBe('old2');
    h.attached.feed(UP);
    expect(h.state.draft).toBe('old1');
  });
});

// —— 候选 ——
describe('候选导航与接受', () => {
  it('↑↓ 循环改选（含回绕）', () => {
    const h = makeHarness();
    h.ctrl.setCandidates(['/help', '/quit', '/clear'], 0);
    h.attached.feed(DOWN);
    expect(h.state.candidates?.activeIndex).toBe(1);
    h.attached.feed(DOWN);
    expect(h.state.candidates?.activeIndex).toBe(2);
    h.attached.feed(DOWN);
    expect(h.state.candidates?.activeIndex).toBe(0); // 回绕
    h.attached.feed(UP);
    expect(h.state.candidates?.activeIndex).toBe(2); // 反向回绕
  });

  it('Tab 接受高亮候选进草稿（光标到行尾），不提交', () => {
    const h = makeHarness();
    h.ctrl.setCandidates(['/help', '/quit'], 1);
    h.attached.feed('\t');
    expect(h.state.draft).toBe('/quit');
    expect(h.state.cursor).toBe(5);
    expect(h.submitted.length).toBe(0);
  });

  it('Enter 接受高亮候选并提交：onSubmit(chosen)、清草稿、候选清除', () => {
    const h = makeHarness();
    h.ctrl.setCandidates(['/help', '/quit'], 1);
    h.attached.feed('\r');
    expect(h.submitted).toEqual(['/quit']);
    expect(h.state.draft).toBe('');
    expect(h.state.candidates).toBeNull();
  });

  it('候选可见时可打印字符照常插入（候选只接管 ↑↓/Tab/Enter）', () => {
    const h = makeHarness([], '/he');
    h.ctrl.setCandidates(['/help'], 0);
    h.attached.feed('x');
    expect(h.state.draft).toBe('/hex');
  });

  it('Shift+Tab 候选可见时不消费（反向补全留 P3）', () => {
    const h = makeHarness();
    h.ctrl.setCandidates(['/help'], 0);
    h.attached.feed('\x1b[Z'); // CSI Z = Shift+Tab
    expect(h.state.draft).toBe('');
    expect(h.state.candidates?.activeIndex).toBe(0);
  });
});

// —— scrollback 滚动 ——
describe('scrollback 滚动键', () => {
  function scrollHarness(): Harness {
    const h = makeHarness(HUNDRED_LINES);
    h.state.scrollback.visibleWindow(10); // viewportRows = 10 → maxScroll = 90
    return h;
  }

  it('PageUp 脱离 follow（90 → 80）', () => {
    const h = scrollHarness();
    h.attached.feed(PAGE_UP);
    expect(h.state.scrollback.follow).toBe(false);
    expect(h.state.scrollback.scrollTopRow).toBe(80);
  });

  it('PageDown 回到底部恢复 follow', () => {
    const h = scrollHarness();
    h.attached.feed(PAGE_UP);
    h.attached.feed(PAGE_DOWN);
    expect(h.state.scrollback.follow).toBe(true);
    expect(h.state.scrollback.scrollTopRow).toBe(90);
  });

  it('Ctrl+U 半页上滚（90 → 85）', () => {
    const h = scrollHarness();
    h.attached.feed('\x15');
    expect(h.state.scrollback.follow).toBe(false);
    expect(h.state.scrollback.scrollTopRow).toBe(85);
  });

  it('Ctrl+D 半页下滚回底（85 → 90，follow 恢复）', () => {
    const h = scrollHarness();
    h.attached.feed('\x15');
    h.attached.feed('\x04');
    expect(h.state.scrollback.follow).toBe(true);
    expect(h.state.scrollback.scrollTopRow).toBe(90);
  });

  it('Ctrl+G 跟随回底（PageUp 后一键复位）', () => {
    const h = scrollHarness();
    h.attached.feed(PAGE_UP);
    h.attached.feed('\x07');
    expect(h.state.scrollback.follow).toBe(true);
    expect(h.state.scrollback.scrollTopRow).toBe(90);
  });

  it('滚轮上一次 = 上滚 3 物理行（90 → 87）', () => {
    const h = scrollHarness();
    h.attached.feed(WHEEL_UP);
    expect(h.state.scrollback.follow).toBe(false);
    expect(h.state.scrollback.scrollTopRow).toBe(87);
  });

  it('滚轮下三次回底恢复 follow', () => {
    const h = scrollHarness();
    h.attached.feed(WHEEL_UP);
    h.attached.feed(WHEEL_DOWN);
    h.attached.feed(WHEEL_DOWN);
    h.attached.feed(WHEEL_DOWN);
    expect(h.state.scrollback.follow).toBe(true);
    expect(h.state.scrollback.scrollTopRow).toBe(90);
  });

  it('非滚轮鼠标事件（按下）不消费、不影响滚动', () => {
    const h = scrollHarness();
    h.attached.feed(MOUSE_DOWN);
    expect(h.state.scrollback.follow).toBe(true);
    expect(h.state.scrollback.scrollTopRow).toBe(90);
  });
});

// —— 粘贴 ——
describe('bracketed paste', () => {
  it('CRLF 归一为 LF、多行入草稿、绝不触发提交', () => {
    const h = makeHarness();
    h.attached.feed(pasteOf('a\r\nb'));
    expect(h.state.draft).toBe('a\nb');
    expect(h.state.cursor).toBe(3);
    expect(h.submitted.length).toBe(0);
  });

  it('光标中间位置粘贴多行（光标随插入推进）', () => {
    const h = makeHarness([], { draft: 'ab', cursor: 2 });
    h.attached.feed(LEFT);
    h.attached.feed(pasteOf('X1\r\nY2'));
    expect(h.state.draft).toBe('aX1\nY2b');
    expect(h.state.cursor).toBe(6);
    expect(h.submitted.length).toBe(0);
  });

  it('裸 \\r 归一为 \\n', () => {
    const h = makeHarness();
    h.attached.feed(pasteOf('a\rb'));
    expect(h.state.draft).toBe('a\nb');
  });

  it('空粘贴（200~ 立即 201~）ignored、状态不变', () => {
    const h = makeHarness([], 'abc');
    h.attached.feed(pasteOf(''));
    expect(h.state.draft).toBe('abc');
    expect(h.state.cursor).toBe(3);
  });
});

// —— attachInput / dispatcher 集成 ——
describe('attachInput 与 dispatcher 集成', () => {
  it('overlay 层优先消费：composer 收不到被吃掉的键', () => {
    let overlayHits = 0;
    const overlay: InputLayer = {
      name: 'overlay',
      handle: (ev) => {
        if (ev.type === 'key' && ev.key === 'x') {
          overlayHits += 1;
          return true;
        }
        return false;
      },
    };
    const h = makeHarness();
    const parser = createInputParser({ now: () => h.clock.now });
    const dispatcher = createInputDispatcher({ layers: [overlay, createComposerLayer(h.ctrl)] });
    const attached = attachInput(parser, h.ctrl, dispatcher);
    attached.feed('x');
    attached.feed('a');
    expect(overlayHits).toBe(1);
    expect(h.state.draft).toBe('a');
  });

  it('dispatcher 含 createComposerLayer 时编辑链路照常工作', () => {
    const h = makeHarness();
    const parser = createInputParser({ now: () => h.clock.now });
    const dispatcher = createInputDispatcher({ layers: [createComposerLayer(h.ctrl)] });
    const attached = attachInput(parser, h.ctrl, dispatcher);
    attached.feed('hi');
    expect(h.state.draft).toBe('hi');
  });

  it('detach 后 feed 直接丢弃（不进 parser、不改状态）', () => {
    const h = makeHarness();
    h.attached.detach();
    expect(h.attached.feed('zz')).toBe(0);
    expect(h.parser.pendingLength()).toBe(0);
    expect(h.state.draft).toBe('');
  });

  it('flushIdle 空闲驱动孤立 ESC：产出 Esc 事件并路由（spy 层可见）', () => {
    const seen: InputEvent[] = [];
    const spy: InputLayer = { name: 'spy', handle: (ev) => (seen.push(ev), false) };
    const h = makeHarness();
    const parser = createInputParser({ now: () => h.clock.now, escTimeoutMs: 50 });
    const dispatcher = createInputDispatcher({ layers: [spy, createComposerLayer(h.ctrl)] });
    const attached = attachInput(parser, h.ctrl, dispatcher);
    h.attached.detach(); // 默认管线停用，避免 double-route 干扰 spy 计数
    attached.feed('\x1b'); // 半包 ESC 进本测试自己的 parser
    h.clock.now += 100;
    expect(attached.flushIdle(h.clock.now)).toBe(1);
    expect(seen.length).toBe(1);
    expect(seen[0]?.type).toBe('key');
    expect(parser.pendingLength()).toBe(0);
  });

  it('flushIdle 未达阈值：0 事件、缓冲保留', () => {
    const h = makeHarness();
    h.attached.feed('\x1b'); // 半包 ESC
    expect(h.attached.flushIdle(h.clock.now)).toBe(0);
    expect(h.parser.pendingLength()).toBe(1);
  });

  it('flush 无条件冲刷：残缺 paste 兜底产出 PasteEvent 并入草稿', () => {
    const h = makeHarness();
    h.attached.feed('\x1b[200~tail'); // 终止符永不到达
    expect(h.attached.flush()).toBe(1);
    expect(h.state.draft).toBe('tail');
  });
});

// —— 性能（宽松防 flaky）——
describe('性能', () => {
  it('单键处理平均 < 1ms（2000 次插入，草稿持续增长）', () => {
    const h = makeHarness();
    const ev = keyEvent('a', 'a');
    const start = performance.now();
    for (let i = 0; i < 2000; i += 1) h.ctrl.handleKey(ev);
    const avgMs = (performance.now() - start) / 2000;
    expect(avgMs).toBeLessThan(1);
    expect(h.state.draft.length).toBe(2000);
  });
});
