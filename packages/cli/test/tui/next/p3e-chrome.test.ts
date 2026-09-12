// P3-E 状态行/快捷键条上下文化 + 队列取消面板（Ctrl+X）+ 重试信息（headless 单测）：
// - 状态行：cwd(短化 ~) · model · ctx 占用% · 模式(非 normal) · 重试标记 · 运行中标记（数据驱动纯函数）
// - 快捷键条：shortcutsFor(state) 纯函数四态（审批接管 > 子视图 > busy > 空闲），互斥由单一返回保证
// - 队列取消面板：busy 且队列非空时 Ctrl+X 打开浮层（Queue · N 项），↑↓/j/k 走行，
//   Ctrl+X/x 取消高亮项（FIFO 移除 + 「已取消排队」system 行），q/Esc 关闭
// - 重试信息：turn 收尾 retryBudget 快照有活动（usedAttempts>0 或 stopReason≠none）→
//   转录 system 行（formatRetryBudget，对齐 ink RetryPanel 信息量）+ 状态行「重试 used/max」标记
// 红绿流程：先于实现落盘（红），实现后转绿（日志存 Temp/p3e-evidence）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnySessionEvent, SteerResult, TurnResult } from '@harness2/core';
import type { ChatRuntime } from '../../../src/chat-setup.js';
import { shortcutsFor, statusLineFor, shortenCwd, queueEntryPreview } from '../../../src/tui/next/chat-screen.js';
import {
  formatRetryBudget,
  retryBudgetHasActivity,
  createApprovalGate,
  createNextChatHarness,
  type ApprovalGate,
  type NextChatHarness,
  type SubagentEventSink,
} from '../../../src/tui/next/next-shell.js';

const ESC = '\x1b';
const TAB = '\t';
const CTRL_X = '\x18'; // Ctrl+X
const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';

class FakeOut {
  buffer = '';
  columns = 100;
  rows = 30;
  write(s: string): unknown {
    this.buffer += s;
    return s.length;
  }
}

function result(finalText: string, overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    stopReason: 'end_turn',
    steps: 1,
    toolCalls: 0,
    durationMs: 1,
    turnId: 't1',
    textOutcome: 'final',
    finalText,
    ...overrides,
  };
}

function makeRuntime(overrides: Partial<ChatRuntime> = {}): ChatRuntime {
  const steerObservers = new Set<(r: SteerResult) => void>();
  return {
    provider: { name: 'mock' } as ChatRuntime['provider'],
    approval: undefined,
    tools: {} as ChatRuntime['tools'],
    skillsStore: {} as ChatRuntime['skillsStore'],
    sessionManager: { list: () => [], locate: () => undefined } as unknown as ChatRuntime['sessionManager'],
    root: '/tmp/harness2-p3e-test',
    getCurrent: () => null,
    switchSession: () => undefined,
    fork: () => undefined,
    runUserTurn: async (text: string) => result(`收到：${text}`),
    abortTurn: () => undefined,
    closeCurrent: () => undefined,
    clearAlwaysAllowed: () => undefined,
    mode: () => 'default',
    setMode: (m) => m,
    reasoning: () => false,
    setReasoning: (on) => on,
    noteCrash: () => undefined,
    submitSteer: () => ({ state: 'unknown', reason: '测试 stub', draftKept: true, message: 'stub' }),
    currentTurnId: () => undefined,
    observeSteer: (fn) => {
      steerObservers.add(fn);
      return () => {
        steerObservers.delete(fn);
      };
    },
    finish: async () => undefined,
    ...overrides,
  };
}

function makeSink(): { sink: SubagentEventSink; emit: (sessionId: string, event: AnySessionEvent) => void } {
  let handler: ((sessionId: string, event: AnySessionEvent) => void) | null = null;
  return {
    sink: {
      set(fn) {
        handler = fn;
      },
    },
    emit: (sessionId, event) => handler?.(sessionId, event),
  };
}

interface Fixture {
  h: NextChatHarness;
  out: FakeOut;
  gate: ApprovalGate;
  runtime: ChatRuntime;
  sink?: { emit: (sessionId: string, event: AnySessionEvent) => void };
}

function makeHarness(
  runtime: ChatRuntime = makeRuntime(),
  opts: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    home?: string;
    withSink?: boolean;
  } = {},
): Fixture {
  const out = new FakeOut();
  const gate = createApprovalGate();
  const bridge = makeSink();
  const h = createNextChatHarness(runtime, {
    out,
    bootLines: [],
    env: opts.env ?? {},
    gate,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(opts.withSink === false ? {} : { subagentEventSink: bridge.sink }),
    exit: () => undefined,
  });
  return { h, out, gate, runtime, sink: { emit: bridge.emit } };
}

async function settle(h: NextChatHarness, ms = 80): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  h.flushUi();
}

function linesOf(h: NextChatHarness): string[] {
  return h.logicalLines();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// —— 纯函数：shortcutsFor（四态 + 互斥）——
describe('shortcutsFor 四态', () => {
  it('空闲（缺省）：/ 命令 · Tab 焦点 · Ctrl+C 退出', () => {
    expect(shortcutsFor({ busy: false, queueCount: 0, approvalActive: false, subviewOpen: false })).toEqual([
      '/ 命令',
      'Tab 焦点',
      'Ctrl+C 退出',
    ]);
  });

  it('busy 且队列空：只显示 Ctrl+C 取消', () => {
    expect(shortcutsFor({ busy: true, queueCount: 0, approvalActive: false, subviewOpen: false })).toEqual([
      'Ctrl+C 取消',
    ]);
  });

  it('busy 且队列非空：Ctrl+C 取消 · Ctrl+X 队列(N)', () => {
    expect(shortcutsFor({ busy: true, queueCount: 3, approvalActive: false, subviewOpen: false })).toEqual([
      'Ctrl+C 取消',
      'Ctrl+X 队列(3)',
    ]);
  });

  it('审批接管：↑↓ 选择 · Enter 确认 · Ctrl+F 展开 · Esc 寄放', () => {
    expect(shortcutsFor({ busy: true, queueCount: 2, approvalActive: true, subviewOpen: false })).toEqual([
      '↑↓ 选择',
      'Enter 确认',
      'Ctrl+F 展开',
      'Esc 寄放',
    ]);
  });

  it('子视图：q 返回 · PgUp/PgDn 滚动', () => {
    expect(shortcutsFor({ busy: true, queueCount: 1, approvalActive: false, subviewOpen: true })).toEqual([
      'q 返回',
      'PgUp/PgDn 滚动',
    ]);
  });

  it('互斥：审批接管优先于 busy/子视图（单一键位组，无混排）', () => {
    const s = shortcutsFor({ busy: true, queueCount: 1, approvalActive: true, subviewOpen: true });
    expect(s).toEqual(['↑↓ 选择', 'Enter 确认', 'Ctrl+F 展开', 'Esc 寄放']);
  });

  it('互斥：子视图优先于 busy；空闲态不显示队列段（队列段只在 busy 态）', () => {
    const sub = shortcutsFor({ busy: true, queueCount: 2, approvalActive: false, subviewOpen: true });
    expect(sub).toEqual(['q 返回', 'PgUp/PgDn 滚动']);
    const idleWithQueue = shortcutsFor({ busy: false, queueCount: 2, approvalActive: false, subviewOpen: false });
    expect(idleWithQueue.join(' ')).not.toContain('Ctrl+X');
  });
});

// —— 纯函数：shortenCwd / statusLineFor / queueEntryPreview ——
describe('shortenCwd（~ 短化）', () => {
  it('cwd == home → ~', () => {
    expect(shortenCwd('/home/me', '/home/me')).toBe('~');
  });

  it('home 前缀（unix /）→ ~/rest', () => {
    expect(shortenCwd('/home/me/proj', '/home/me')).toBe('~/proj');
  });

  it('home 前缀（win \\）→ ~\\rest', () => {
    expect(shortenCwd('C:\\Users\\me\\proj', 'C:\\Users\\me')).toBe('~\\proj');
  });

  it('非 home 前缀原样返回', () => {
    expect(shortenCwd('/opt/data', '/home/me')).toBe('/opt/data');
    expect(shortenCwd('C:\\Other\\x', 'C:\\Users\\me')).toBe('C:\\Other\\x');
  });
});

describe('statusLineFor（状态行纯函数）', () => {
  it('基础序：cwd(~) · model · ctx N%', () => {
    expect(statusLineFor({ cwd: '/home/me/proj', home: '/home/me', model: 'gpt-x', usage: 0.424 })).toBe(
      '~/proj · gpt-x · ctx 42%',
    );
  });

  it('usage 未知 → ctx —（不伪造数值）', () => {
    expect(statusLineFor({ cwd: '/w', home: '/home/me', model: 'm', usage: undefined })).toBe('/w · m · ctx —');
  });

  it('normal/缺省模式省略；非 normal 模式追加在 ctx 之后', () => {
    expect(statusLineFor({ cwd: '/w', home: '/home', model: 'm', usage: 0.1, mode: 'normal' })).not.toContain('normal');
    expect(statusLineFor({ cwd: '/w', home: '/home', model: 'm', usage: 0.1, mode: 'plan' })).toBe(
      '/w · m · ctx 10% · plan',
    );
  });

  it('重试标记（重试 used/max）与运行中标记追加其后', () => {
    const s = statusLineFor({
      cwd: '/w',
      home: '/home',
      model: 'm',
      usage: 0.1,
      mode: 'auto',
      retry: { used: 2, max: 6 },
      busy: true,
    });
    expect(s).toBe('/w · m · ctx 10% · auto · 重试 2/6 · ⏺ 运行中…');
  });

  it('空闲无重试：无重试/运行中段', () => {
    const s = statusLineFor({ cwd: '/w', home: '/home', model: 'm', usage: 0.1 });
    expect(s).not.toContain('重试');
    expect(s).not.toContain('运行中');
  });
});

describe('queueEntryPreview（队列条目预览，对齐 ink queuePreview）', () => {
  it('多行折成单行并去首尾空白', () => {
    expect(queueEntryPreview('  a\nb\tc  ')).toBe('a b c');
  });

  it('超长截断加省略号（42 列）', () => {
    const long = 'x'.repeat(50);
    expect(queueEntryPreview(long)).toBe(`${'x'.repeat(42)}…`);
  });

  it('短文本原样', () => {
    expect(queueEntryPreview('hello')).toBe('hello');
  });
});

// —— 纯函数：retryBudget 快照（对齐 ink retry-panel 的信息量）——
describe('retryBudget 快照纯函数', () => {
  const active: NonNullable<TurnResult['retryBudget']> = {
    usedAttempts: 2,
    remainingAttempts: 4,
    waitMs: 3000,
    remainingWaitMs: 0,
    maxExtraAttempts: 6,
    maxWaitMs: 120000,
    stopReason: 'none',
  };

  it('有活动：usedAttempts>0 或 stopReason≠none；无活动：双零', () => {
    expect(retryBudgetHasActivity(active)).toBe(true);
    expect(retryBudgetHasActivity({ ...active, usedAttempts: 0, stopReason: 'budget-exhausted' })).toBe(true);
    expect(retryBudgetHasActivity({ ...active, usedAttempts: 0 })).toBe(false);
  });

  it('formatRetryBudget：已用/剩余/等待/停因（对齐 ink formatRetryBudget 文案）', () => {
    expect(formatRetryBudget(active)).toBe('重试 已用 2/6 · 剩余 4 次 · 等待 3s/120s · 停因 未停');
    expect(
      formatRetryBudget({ ...active, usedAttempts: 6, remainingAttempts: 0, stopReason: 'budget-exhausted' }),
    ).toContain('停因 次数预算耗尽');
  });
});

// —— 装配层集成：状态行 / 快捷键条 ——
describe('P3-E 状态行（harness 集成）', () => {
  it('初始状态行：cwd(~ 短化) · model · ctx —（无活动会话不伪造数值）', () => {
    const { h } = makeHarness(undefined, { cwd: 'C:\\Users\\me\\proj', home: 'C:\\Users\\me' });
    expect(h.state.statusline).toBe('~\\proj · mock · ctx —');
    h.dispose();
  });

  it('busy 时状态行追加运行中标记，收尾后消失', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async () => {
          await blocker;
          return result('done');
        },
      }),
    );
    h.submit('跑');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.statusline).toContain('⏺ 运行中…');
    release();
    await settle(h);
    expect(h.state.statusline).not.toContain('运行中');
    h.dispose();
  });

  it('有重试史的 turn 收尾：状态行出现「重试 used/max」标记；下一 turn 开始清除', async () => {
    let calls = 0;
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async () => {
          calls += 1;
          const budget: NonNullable<TurnResult['retryBudget']> = {
            usedAttempts: 1,
            remainingAttempts: 5,
            waitMs: 0,
            remainingWaitMs: 120000,
            maxExtraAttempts: 6,
            maxWaitMs: 120000,
            stopReason: 'none',
          };
          return calls === 1 ? result('done', { retryBudget: budget }) : result('done');
        },
      }),
    );
    h.submit('第一次');
    await settle(h);
    expect(h.state.statusline).toContain('重试 1/6');
    h.submit('第二次');
    await settle(h);
    expect(h.state.statusline).not.toContain('重试');
    h.dispose();
  });
});

describe('P3-E 快捷键条（harness 集成）', () => {
  it('空闲态为 idle 键位组', () => {
    const { h } = makeHarness();
    expect(h.state.shortcuts).toEqual(['/ 命令', 'Tab 焦点', 'Ctrl+C 退出']);
    h.dispose();
  });

  it('busy 态切换为 busy 键位组；入队后出现 Ctrl+X 队列(N)', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (text: string) => {
          if (text === 'first') await blocker;
          return result('done');
        },
      }),
    );
    h.submit('first');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.shortcuts).toEqual(['Ctrl+C 取消']);
    h.submit('second');
    expect(h.state.shortcuts).toEqual(['Ctrl+C 取消', 'Ctrl+X 队列(1)']);
    release();
    await settle(h);
    expect(h.state.shortcuts).toEqual(['/ 命令', 'Tab 焦点', 'Ctrl+C 退出']);
    h.dispose();
  });

  it('审批挂起时快捷键条切换为审批键位组（dispatcher 最优先层一致）', async () => {
    const { h, gate } = makeHarness();
    void gate.ask('允许执行 write?');
    expect(h.pendingApproval()).toBe('允许执行 write?');
    expect(h.state.shortcuts).toEqual(['↑↓ 选择', 'Enter 确认', 'Ctrl+F 展开', 'Esc 寄放']);
    h.approve('y');
    expect(h.state.shortcuts).toEqual(['/ 命令', 'Tab 焦点', 'Ctrl+C 退出']);
    h.dispose();
  });

  it('子视图打开时快捷键条切换为子视图键位组；关闭还原', async () => {
    const { h, sink } = makeHarness();
    sink?.emit('child-1', {
      type: 'user/message',
      seq: 1,
      payload: { text: '子任务指令', turnId: 't1' },
    } as unknown as AnySessionEvent);
    h.feed(TAB); // 焦点 → 滚动区
    h.feed('v'); // 1 个子会话 → 直开
    expect(h.state.subagentView ?? null).not.toBeNull();
    expect(h.state.shortcuts).toEqual(['q 返回', 'PgUp/PgDn 滚动']);
    h.feed('q');
    expect(h.state.subagentView ?? null).toBeNull();
    expect(h.state.shortcuts).toEqual(['/ 命令', 'Tab 焦点', 'Ctrl+C 退出']);
    h.dispose();
  });
});

// —— 队列取消面板（Ctrl+X）——
describe('P3-E 队列取消面板', () => {
  function blockedHarness(): { f: Fixture; release: () => void } {
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    const f = makeHarness(
      makeRuntime({
        runUserTurn: async (text: string) => {
          if (text === 'first') await blocker;
          return result('done');
        },
      }),
    );
    f.h.submit('first'); // 立即执行（占用 busy）
    f.h.submit('second message\n多行内容'); // 入队
    f.h.submit('third'); // 入队
    return { f, release };
  }

  it('busy 且队列非空：Ctrl+X 打开浮层（标题 Queue · N 项，条目=预览，高亮 0）', async () => {
    const { f, release } = blockedHarness();
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed(CTRL_X);
    expect(f.h.state.overlays).toHaveLength(1);
    expect(f.h.state.overlays[0]?.title).toBe('Queue · 2 项');
    expect(f.h.state.overlays[0]?.items).toEqual(['second message 多行内容', 'third']);
    expect(f.h.state.overlays[0]?.activeIndex).toBe(0);
    release();
    await settle(f.h);
    f.h.dispose();
  });

  it('Ctrl+X 在空闲或队列空时不开面板（瞬时提示）', async () => {
    const { h } = makeHarness();
    h.feed(CTRL_X);
    expect(h.state.overlays).toHaveLength(0);
    expect((h.state.indicators ?? []).join(' ')).toContain('队列为空');
    h.dispose();
  });

  it('↑↓/j/k 走行移动高亮（循环）', async () => {
    const { f, release } = blockedHarness();
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed(CTRL_X);
    f.h.feed(ARROW_DOWN);
    expect(f.h.state.overlays[0]?.activeIndex).toBe(1);
    f.h.feed('j');
    expect(f.h.state.overlays[0]?.activeIndex).toBe(0); // 循环回队首
    f.h.feed(ARROW_UP);
    expect(f.h.state.overlays[0]?.activeIndex).toBe(1); // 反向循环
    f.h.feed('k');
    expect(f.h.state.overlays[0]?.activeIndex).toBe(0);
    release();
    await settle(f.h);
    f.h.dispose();
  });

  it('x 取消高亮项：FIFO 移除 + 「已取消排队」system 行 + 面板刷新', async () => {
    const { f, release } = blockedHarness();
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed(CTRL_X);
    f.h.feed(ARROW_DOWN); // 高亮第 2 项
    f.h.feed('x');
    expect(f.h.queueSnapshot()).toEqual(['second message\n多行内容']); // 第 2 项被移除
    expect(linesOf(f.h)).toContain('已取消排队: third');
    expect(f.h.state.overlays[0]?.title).toBe('Queue · 1 项');
    expect(f.h.state.overlays[0]?.items).toEqual(['second message 多行内容']);
    release();
    await settle(f.h);
    f.h.dispose();
  });

  it('Ctrl+X 在面板打开时同样取消高亮项', async () => {
    const { f, release } = blockedHarness();
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed(CTRL_X);
    f.h.feed(CTRL_X); // 取消高亮（队首）
    expect(f.h.queueSnapshot()).toEqual(['third']);
    expect(linesOf(f.h)).toContain('已取消排队: second message 多行内容');
    release();
    await settle(f.h);
    f.h.dispose();
  });

  it('取消全部条目后面板自动关闭', async () => {
    const { f, release } = blockedHarness();
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed(CTRL_X);
    f.h.feed('x');
    f.h.feed('x');
    expect(f.h.queueSnapshot()).toEqual([]);
    expect(f.h.state.overlays).toHaveLength(0);
    release();
    await settle(f.h);
    f.h.dispose();
  });

  it('q / Esc 关闭面板不取消任何条目', async () => {
    const { f, release } = blockedHarness();
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed(CTRL_X);
    f.h.feed('q');
    expect(f.h.queueSnapshot()).toEqual(['second message\n多行内容', 'third']);
    expect(f.h.state.overlays).toHaveLength(0);
    f.h.feed(CTRL_X);
    f.h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60); // 孤立 ESC 空闲超时（50ms）后 parser 才产出 Esc 键
    expect(f.h.queueSnapshot()).toEqual(['second message\n多行内容', 'third']);
    expect(f.h.state.overlays).toHaveLength(0);
    release();
    await settle(f.h);
    f.h.dispose();
  });

  it('面板打开期间键盘被接管：字母不进草稿（P1-1 同款防御）', async () => {
    const { f, release } = blockedHarness();
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed(CTRL_X);
    f.h.feed('abc'); // 'a' 若透传会进草稿
    expect(f.h.state.draft).toBe('');
    release();
    await settle(f.h);
    f.h.dispose();
  });

  it('turn 收尾自动关闭面板，队列继续 drain', async () => {
    const { f, release } = blockedHarness();
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed(CTRL_X);
    expect(f.h.state.overlays).toHaveLength(1);
    release();
    await settle(f.h);
    expect(f.h.state.overlays).toHaveLength(0);
    expect(linesOf(f.h).join('\n')).toContain('❯ second message'); // drain 继续
    f.h.dispose();
  });

  it('审批挂起挤占队列面板：面板关闭、审批键位接管；结算后不复活', async () => {
    const { f, release } = blockedHarness();
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed(CTRL_X);
    expect(f.h.state.overlays[0]?.title).toBe('Queue · 2 项');
    void f.gate.ask('允许执行 write?');
    expect(f.h.state.overlays[0]?.title).toContain('Approval');
    expect(f.h.state.shortcuts).toEqual(['↑↓ 选择', 'Enter 确认', 'Ctrl+F 展开', 'Esc 寄放']);
    f.h.approve('y');
    expect(f.h.state.overlays).toHaveLength(0);
    expect(f.h.queueSnapshot()).toEqual(['second message\n多行内容', 'third']); // 队列未被面板关闭动过
    release();
    await settle(f.h);
    f.h.dispose();
  });
});

// —— 重试信息展示 ——
describe('P3-E 重试信息（harness 集成）', () => {
  it('有重试史的 turn：转录 system 行展示已用/剩余/等待/停因', async () => {
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async () =>
          result('done', {
            retryBudget: {
              usedAttempts: 3,
              remainingAttempts: 3,
              waitMs: 8000,
              remainingWaitMs: 112000,
              maxExtraAttempts: 6,
              maxWaitMs: 120000,
              stopReason: 'none',
            },
          }),
      }),
    );
    h.submit('跑');
    await settle(h);
    expect(linesOf(h)).toContain('重试 已用 3/6 · 剩余 3 次 · 等待 8s/120s · 停因 未停');
    h.dispose();
  });

  it('无重试史（used=0 且 stopReason=none）：不产生重试行、无状态行标记', async () => {
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async () =>
          result('done', {
            retryBudget: {
              usedAttempts: 0,
              remainingAttempts: 6,
              waitMs: 0,
              remainingWaitMs: 120000,
              maxExtraAttempts: 6,
              maxWaitMs: 120000,
              stopReason: 'none',
            },
          }),
      }),
    );
    h.submit('跑');
    await settle(h);
    expect(linesOf(h).some((l) => l.startsWith('重试 '))).toBe(false);
    expect(h.state.statusline).not.toContain('重试');
    h.dispose();
  });

  it('stopReason 非 none（预算耗尽）即使 used=0 也展示（如实钉住停因）', async () => {
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async () =>
          result('done', {
            retryBudget: {
              usedAttempts: 0,
              remainingAttempts: 6,
              waitMs: 0,
              remainingWaitMs: 0,
              maxExtraAttempts: 6,
              maxWaitMs: 120000,
              stopReason: 'timeout',
            },
          }),
      }),
    );
    h.submit('跑');
    await settle(h);
    expect(linesOf(h).some((l) => l.includes('停因 等待预算耗尽'))).toBe(true);
    h.dispose();
  });
});
