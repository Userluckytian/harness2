// P4-1 选择与复制（OSC52）+ 超链接（OSC8）装配层单测：鼠标拖选 → Ctrl+C 优先复制 /
// Esc 清除 / y 复制 / 单击清除；HARNESS2_SELECT / HARNESS2_OSC8 开关旁路；
// 候选区/面板点击语义优先级不变。
// 红绿流程：先于实现落盘（红），实现后转绿（日志存 Temp/p4a-evidence）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnResult } from '@harness2/core';
import type { ChatRuntime } from '../../../src/chat-setup.js';
import { createNextChatHarness, type ApprovalGate, type NextChatHarness } from '../../../src/tui/next/next-shell.js';
import { createApprovalGate } from '../../../src/tui/next/next-shell.js';
import { layoutChat } from '../../../src/tui/next/chat-screen.js';

const CTRL_C = '\x03';
const ESC = '\x1b';
const TAB = '\t';

// —— SGR 鼠标序列（1 基坐标；0=左键 down/up，32=移动，m=释放）——
const mouseDown = (col: number, row: number): string => `\x1b[<0;${col + 1};${row + 1}M`;
const mouseMove = (col: number, row: number): string => `\x1b[<32;${col + 1};${row + 1}M`;
const mouseUp = (col: number, row: number): string => `\x1b[<0;${col + 1};${row + 1}m`;

class FakeOut {
  buffer = '';
  columns = 100;
  rows = 30;
  write(s: string): unknown {
    this.buffer += s;
    return s.length;
  }
}

function makeRuntime(): ChatRuntime {
  const runtime: ChatRuntime = {
    provider: { name: 'mock' } as ChatRuntime['provider'],
    approval: undefined,
    tools: {} as ChatRuntime['tools'],
    skillsStore: {} as ChatRuntime['skillsStore'],
    sessionManager: { list: () => [], locate: () => undefined } as unknown as ChatRuntime['sessionManager'],
    root: '/tmp/harness2-p4-test',
    getCurrent: () => null,
    switchSession: () => undefined,
    fork: () => undefined,
    runUserTurn: async (text: string) =>
      ({
        stopReason: 'end_turn',
        steps: 1,
        toolCalls: 0,
        durationMs: 1,
        turnId: 't1',
        textOutcome: 'final',
        finalText: `收到：${text}`,
      }) as TurnResult,
    abortTurn: () => undefined,
    closeCurrent: () => undefined,
    clearAlwaysAllowed: () => undefined,
    mode: () => 'default',
    setMode: (m: string) => m,
    reasoning: () => false,
    setReasoning: (on: boolean) => on,
    noteCrash: () => undefined,
    submitSteer: () => ({ state: 'unknown', reason: 'stub', draftKept: true, message: 'stub' }),
    currentTurnId: () => undefined,
    observeSteer: () => () => undefined,
    finish: async () => undefined,
  } as unknown as ChatRuntime;
  return runtime;
}

interface Fixture {
  h: NextChatHarness;
  out: FakeOut;
  gate: ApprovalGate;
}

function makeHarness(opts: { env?: Record<string, string | undefined>; bootLines?: string[] } = {}): Fixture {
  const out = new FakeOut();
  const gate = createApprovalGate();
  const h = createNextChatHarness(makeRuntime(), {
    out,
    bootLines: opts.bootLines ?? [],
    env: opts.env ?? {},
    gate,
    exit: () => undefined,
  });
  return { h, out, gate };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 滚动区布局矩形（与渲染同一 layoutChat 数据源） */
function scrollbackRect(h: NextChatHarness): { top: number; height: number } {
  return layoutChat(30, 100, h.state).scrollback;
}

describe('鼠标拖选与复制（OSC52）', () => {
  it('拖选单行：selectedText = 首行按列切片', () => {
    const { h } = makeHarness({ bootLines: ['alpha beta gamma delta'] });
    const rect = scrollbackRect(h);
    h.feed(mouseDown(0, rect.top));
    h.feed(mouseMove(9, rect.top)); // 1 基 10 → 0 基 col 9
    h.feed(mouseUp(9, rect.top));
    expect(h.hasSelection()).toBe(true);
    expect(h.selectedText()).toBe('alpha bet'); // 首行 cols [0,9)
    h.dispose();
  });

  it('反向拖选（先右后左）：与正向同文本（方向无关）', () => {
    const { h } = makeHarness({ bootLines: ['alpha beta gamma delta'] });
    const rect = scrollbackRect(h);
    h.feed(mouseDown(9, rect.top));
    h.feed(mouseMove(0, rect.top));
    h.feed(mouseUp(0, rect.top));
    expect(h.selectedText()).toBe('alpha bet');
    h.dispose();
  });

  it('跨行拖选：\n 连接两行文本', () => {
    const { h } = makeHarness({ bootLines: ['first line', 'second line'] });
    const rect = scrollbackRect(h);
    h.feed(mouseDown(0, rect.top));
    h.feed(mouseMove(5, rect.top + 1));
    h.feed(mouseUp(5, rect.top + 1));
    expect(h.selectedText()).toBe('first line\nsecon');
    h.dispose();
  });

  it('Ctrl+C 有选择：优先复制（OSC52 写出 + hint + 选择清除），不走 guard 协议', () => {
    const { h, out } = makeHarness({ bootLines: ['alpha beta gamma delta'] });
    const rect = scrollbackRect(h);
    h.feed(mouseDown(0, rect.top));
    h.feed(mouseMove(9, rect.top));
    h.feed(mouseUp(9, rect.top));
    out.buffer = '';
    h.feed(CTRL_C);
    const b64 = Buffer.from('alpha bet', 'utf8').toString('base64');
    expect(out.buffer).toContain(`\x1b]52;c;${b64}\x1b\\`);
    expect(h.hasSelection()).toBe(false); // 复制后清除
    expect((h.state.indicators ?? []).some((i) => i.includes('已复制 9 字符'))).toBe(true);
    expect((h.state.indicators ?? []).some((i) => i.includes('再按一次'))).toBe(false);
    h.dispose();
  });

  it('Ctrl+C 无选择：走既有 guard 协议（无 OSC52，提示再按一次）', () => {
    const { h, out } = makeHarness({ bootLines: ['alpha beta gamma delta'] });
    h.feed(CTRL_C);
    expect(out.buffer).not.toContain('\x1b]52;c;');
    expect((h.state.indicators ?? []).some((i) => i.includes('再按一次'))).toBe(true);
    h.dispose();
  });

  it('Escape 清除选择（不进草稿/不触发 abort）', async () => {
    const { h } = makeHarness({ bootLines: ['alpha beta gamma delta'] });
    const rect = scrollbackRect(h);
    h.feed(mouseDown(0, rect.top));
    h.feed(mouseMove(9, rect.top));
    h.feed(mouseUp(9, rect.top));
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60); // 孤立 ESC 空闲超时（50ms）后 parser 才产出 Esc 键
    expect(h.hasSelection()).toBe(false);
    h.dispose();
  });

  it('y（滚动区焦点）：复制同样生效（OSC52 + hint）', () => {
    const { h, out } = makeHarness({ bootLines: ['alpha beta gamma delta'] });
    const rect = scrollbackRect(h);
    h.feed(mouseDown(0, rect.top));
    h.feed(mouseMove(9, rect.top));
    h.feed(mouseUp(9, rect.top));
    h.feed(TAB); // 焦点切到滚动区
    out.buffer = '';
    h.feed('y');
    const b64 = Buffer.from('alpha bet', 'utf8').toString('base64');
    expect(out.buffer).toContain(`\x1b]52;c;${b64}\x1b\\`);
    expect((h.state.indicators ?? []).some((i) => i.includes('已复制 9 字符'))).toBe(true);
    h.dispose();
  });

  it('单击（down/up 无移动）：清除选择', () => {
    const { h } = makeHarness({ bootLines: ['alpha beta gamma delta'] });
    const rect = scrollbackRect(h);
    h.feed(mouseDown(0, rect.top));
    h.feed(mouseMove(9, rect.top));
    h.feed(mouseUp(9, rect.top));
    expect(h.hasSelection()).toBe(true);
    h.feed(mouseDown(3, rect.top));
    h.feed(mouseUp(3, rect.top));
    expect(h.hasSelection()).toBe(false);
    h.dispose();
  });
});

describe('开关旁路与优先级', () => {
  it('HARNESS2_SELECT=0：拖选不进入选择态；Ctrl+C 走 guard（完全旁路）', () => {
    const { h, out } = makeHarness({
      env: { HARNESS2_SELECT: '0' },
      bootLines: ['alpha beta gamma delta'],
    });
    const rect = scrollbackRect(h);
    h.feed(mouseDown(0, rect.top));
    h.feed(mouseMove(9, rect.top));
    h.feed(mouseUp(9, rect.top));
    expect(h.hasSelection()).toBe(false);
    expect(h.selectedText()).toBe('');
    h.feed(CTRL_C);
    expect(out.buffer).not.toContain('\x1b]52;c;');
    expect((h.state.indicators ?? []).some((i) => i.includes('再按一次'))).toBe(true);
    h.dispose();
  });

  it('HARNESS2_OSC8=0：URL 行零 OSC8 输出（完全旁路）', () => {
    const { out } = makeHarness({
      env: { HARNESS2_OSC8: '0' },
      bootLines: ['see https://example.com/x now'],
    });
    expect(out.buffer).not.toContain('\x1b]8;;');
    expect(out.buffer).toContain('https://example.com/x');
  });

  it('URL 行默认渲染：OSC8 包裹出现在帧输出中', () => {
    const { out } = makeHarness({ bootLines: ['see https://example.com/x now'] });
    expect(out.buffer).toContain('\x1b]8;;https://example.com/x\x1b\\');
    expect(out.buffer).toContain('\x1b]8;;\x1b\\');
  });

  it('候选区优先级不变：候选可见时移动仍改选候选；候选区按下不产生选择', () => {
    const { h } = makeHarness({ bootLines: ['alpha beta gamma delta'] });
    h.feed('/');
    expect(h.state.candidates).not.toBeNull();
    const layout = layoutChat(30, 100, h.state);
    const candRow = layout.composer.top + 2; // 候选第 3 行（窗口 6 行，activeIndex 0 → idx 2）
    // 候选区 move：改选候选（既有语义，candidateMouseLayer 先于选择层）
    h.feed(mouseMove(0, candRow));
    expect(h.state.candidates?.activeIndex).toBe(2);
    // 候选区 down/up：不产生选择（composer 区不在滚动区矩形内）
    h.feed(mouseDown(0, candRow));
    h.feed(mouseUp(0, candRow));
    expect(h.hasSelection()).toBe(false);
    // 滚动区拖选在候选可见时仍可用（非焦点可选拖）
    const rect = scrollbackRect(h);
    h.feed(mouseDown(0, rect.top));
    h.feed(mouseMove(9, rect.top));
    h.feed(mouseUp(9, rect.top));
    expect(h.hasSelection()).toBe(true);
    h.dispose();
  });
});
