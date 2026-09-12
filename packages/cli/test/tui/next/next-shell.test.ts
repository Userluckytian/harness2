// W3 next-shell 单测（headless）：next 渲染层接入 chat 命令的装配层（伪 stdout + 原始字节 stdin）。
// 原则：主路径用原始字节喂 harness.feed（parser→dispatcher→controller 全链）；runtime 用
// 内存 mock（流式 text-delta / tool-call / 审批 gate.ask），断言基于 scrollback 逻辑行、
// ChatScreenState（overlays/statusline/indicators）与 mock runtime 的调用记录。
// 红绿流程：先于 next-shell.ts 实现落盘（红），实现后转绿（日志存 Temp/p2w3-evidence）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SteerResult, TurnResult } from '@harness2/core';
import type { ChatRuntime } from '../../../src/chat-setup.js';
import {
  bindEmergencyExitRestore,
  createApprovalGate,
  createNextChatHarness,
  emergencyTerminalRestore,
  shouldUseNextRenderer,
  type ApprovalGate,
  type NextChatHarness,
} from '../../../src/tui/next/next-shell.js';

const ASK_CANCELLED = '\u0000ask-cancelled';

// —— 常用原始字节序列（终端标准编码，与 chat-controller.test.ts 同源）——
const ENTER = '\r';
const ESC = '\x1b';
const CTRL_C = '\x03';
const CTRL_O = '\x0f';
const SHIFT_ENTER = '\x1b[13;2u'; // kitty CSI-u：Shift+Enter
const WHEEL_UP = '\x1b[<64;10;5M'; // SGR 滚轮上
const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const pasteOf = (s: string): string => `\x1b[200~${s}\x1b[201~`;

// —— 伪输出目标（headless Screen）——
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

/** 内存 mock runtime（只实现 next-shell 消费的面；未消费成员为无害 stub） */
function makeRuntime(overrides: Partial<ChatRuntime> = {}): ChatRuntime {
  const steerObservers = new Set<(r: SteerResult) => void>();
  const runtime: ChatRuntime = {
    provider: { name: 'mock' } as ChatRuntime['provider'],
    approval: undefined,
    tools: {} as ChatRuntime['tools'],
    skillsStore: {} as ChatRuntime['skillsStore'],
    sessionManager: { list: () => [], locate: () => undefined } as unknown as ChatRuntime['sessionManager'],
    root: '/tmp/harness2-next-test',
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
  // 观察者引用（steer 测试用）：挂到对象上便于取出
  (runtime as unknown as { __steerObservers: Set<(r: SteerResult) => void> }).__steerObservers = steerObservers;
  return runtime;
}

interface Fixture {
  h: NextChatHarness;
  out: FakeOut;
  exitCodes: number[];
  gate: ApprovalGate;
  runtime: ChatRuntime;
}

function makeHarness(
  runtime: ChatRuntime = makeRuntime(),
  opts: { env?: Record<string, string | undefined>; notifyWrite?: (s: string) => void; bootLines?: string[] } = {},
): Fixture {
  const out = new FakeOut();
  const exitCodes: number[] = [];
  const gate = createApprovalGate();
  const h = createNextChatHarness(runtime, {
    out,
    bootLines: opts.bootLines ?? [],
    env: opts.env ?? {},
    gate,
    ...(opts.notifyWrite !== undefined ? { notifyWrite: opts.notifyWrite } : {}),
    exit: (code) => exitCodes.push(code),
  });
  return { h, out, exitCodes, gate, runtime };
}

/** 推进 timers 并让 microtask 落定（50ms live flush + 16ms scheduler flush 都收敛） */
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

// —— 开关分支 ——
describe('HARNESS2_RENDERER 开关', () => {
  it('HARNESS2_RENDERER=next 时启用 next 渲染路径', () => {
    expect(shouldUseNextRenderer({ HARNESS2_RENDERER: 'next' })).toBe(true);
  });

  it('未设置或其他值时保持 legacy ink 路径（开关默认关闭）', () => {
    expect(shouldUseNextRenderer({})).toBe(false);
    expect(shouldUseNextRenderer({ HARNESS2_RENDERER: 'ink' })).toBe(false);
    expect(shouldUseNextRenderer({ HARNESS2_RENDERER: 'NEXT' })).toBe(false);
  });
});

// —— 生命周期与初始帧 ——
describe('初始帧与 bootLines', () => {
  it('创建即渲染初始帧（alt-screen 进入序列已写出）', () => {
    const { h, out } = makeHarness();
    expect(out.buffer).toContain('\x1b[?1049h');
    expect(h.state.draft).toBe('');
    h.dispose();
  });

  it('bootLines 以 system 条目进入 scrollback', () => {
    const { h } = makeHarness(undefined, { bootLines: ['会话: s1（新建）'] });
    expect(linesOf(h)[0]).toBe('会话: s1（新建）');
    h.dispose();
  });

  it('statusline 展示模式与 provider', () => {
    const { h } = makeHarness();
    expect(h.state.statusline).toContain('default');
    expect(h.state.statusline).toContain('mock');
    h.dispose();
  });
});

// —— 转录投影 ——
describe('转录流式投影到 scrollback', () => {
  it('Enter 提交调用 runtime.runUserTurn，user 行进入 scrollback', async () => {
    const calls: string[] = [];
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (text: string) => {
          calls.push(text);
          return result(`收到：${text}`);
        },
      }),
    );
    h.feed('hi');
    expect(h.state.draft).toBe('hi');
    h.feed(ENTER);
    expect(calls).toEqual(['hi']);
    expect(h.state.draft).toBe('');
    expect(linesOf(h)).toContain('❯ hi');
    await settle(h);
    h.dispose();
  });

  it('空草稿 Enter 消费但不提交', () => {
    const calls: string[] = [];
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (text: string) => {
          calls.push(text);
          return result('x');
        },
      }),
    );
    h.feed(ENTER);
    expect(calls).toEqual([]);
    h.dispose();
  });

  it('流式 text-delta 经 50ms flush 出现为 assistant 行（assistant/step 投影）', async () => {
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({ type: 'text-delta', text: '第一段', turnId: 't1' });
          await vi.advanceTimersByTimeAsync(60); // 流式间隔 > 50ms：live flush 先落一条 step
          return result('终稿');
        },
      }),
    );
    h.submit('开始');
    await vi.advanceTimersByTimeAsync(60); // 50ms live flush
    expect(linesOf(h).join('\n')).toContain('第一段');
    await settle(h);
    h.dispose();
  });

  it('turn-final 落定为 assistant 行', async () => {
    const { h } = makeHarness();
    h.submit('你好');
    await settle(h);
    expect(linesOf(h)).toContain('收到：你好');
    h.dispose();
  });

  it('final 与末段 step 文本重复时去重（只出现一次）', async () => {
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({ type: 'text-delta', text: '同样的话', turnId: 't1' });
          await vi.advanceTimersByTimeAsync(60); // live flush 已把同文本落成 step 项
          return result('同样的话');
        },
      }),
    );
    h.submit('问');
    await settle(h);
    const n = linesOf(h).filter((l) => l === '同样的话').length;
    expect(n).toBe(1);
    h.dispose();
  });

  it('同 step 二次增长：原地替换不残留旧行（增量投影回归防护）', async () => {
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({ type: 'text-delta', text: '第一截', turnId: 't1' });
          await vi.advanceTimersByTimeAsync(60); // 第一次 live flush：step（t1, step0）text='第一截'
          onStream({ type: 'text-delta', text: '第二截', turnId: 't1' });
          await vi.advanceTimersByTimeAsync(60); // 第二次 live flush：同 turnId+stepIndex 增长替换
          return result('第一截第二截');
        },
      }),
    );
    h.submit('问');
    await settle(h);
    const lines = linesOf(h);
    // 完整文本只出现一份；第一次 flush 的旧截不得滞留为独立行
    expect(lines.filter((l) => l === '第一截第二截')).toHaveLength(1);
    expect(lines).not.toContain('第一截');
    expect(lines).not.toContain('第二截');
    h.dispose();
  });

  it('tool-call/tool-result 投影为工具行（pending → ok 摘要）', async () => {
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({
            type: 'tool-call',
            call: { id: 'c1', name: 'write', arguments: JSON.stringify({ file_path: 'a.txt' }) },
            turnId: 't1',
          });
          onStream({ type: 'tool-result', callId: 'c1', ok: true, turnId: 't1' });
          return result('完成');
        },
      }),
    );
    h.submit('写文件');
    await settle(h);
    const joined = linesOf(h).join('\n');
    expect(joined).toContain('⏺ write(');
    expect(joined).toContain('a.txt');
    expect(joined).toContain('└ ✓');
    h.dispose();
  });

  it('失败工具结果投影 ✗ 行', async () => {
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({
            type: 'tool-call',
            call: { id: 'c2', name: 'bash', arguments: '{"command":"nope"}' },
            turnId: 't1',
          });
          onStream({ type: 'tool-result', callId: 'c2', ok: false, error: '命令不存在', turnId: 't1' });
          return result('', { stopReason: 'error', textOutcome: 'empty', finalText: undefined });
        },
      }),
    );
    h.submit('跑命令');
    await settle(h);
    const joined = linesOf(h).join('\n');
    expect(joined).toContain('└ ✗');
    expect(joined).toContain('命令不存在');
    h.dispose();
  });

  it('turn 结束追加 status 摘要行', async () => {
    const { h } = makeHarness();
    h.submit('你好');
    await settle(h);
    expect(linesOf(h).some((l) => l.includes('[end_turn'))).toBe(true);
    h.dispose();
  });
});

// —— 折叠（Ctrl+O）——
describe('Ctrl+O 折叠切换', () => {
  it('展开最近工具卡（write 的 diff 块出现，行数增加）', async () => {
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({
            type: 'tool-call',
            call: {
              id: 'c3',
              name: 'write',
              arguments: JSON.stringify({ file_path: 'a.txt', content: 'one\ntwo' }),
            },
            turnId: 't1',
          });
          onStream({ type: 'tool-result', callId: 'c3', ok: true, turnId: 't1' });
          return result('done');
        },
      }),
    );
    h.submit('写');
    await settle(h);
    const before = linesOf(h).length;
    h.feed(CTRL_O);
    const after = linesOf(h).length;
    expect(after).toBeGreaterThan(before);
    expect(linesOf(h).join('\n')).toContain('+ one');
    h.dispose();
  });
});

// —— 忙时排队 ——
describe('忙时 FIFO 排队', () => {
  it('忙时 Enter 入队，turn 收尾后 drain 执行', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (text: string) => {
          calls.push(text);
          await blocker;
          return result('done');
        },
      }),
    );
    h.submit('first');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.isBusy()).toBe(true);
    h.submit('second');
    expect(h.queueSnapshot()).toEqual(['second']);
    release();
    await settle(h);
    expect(calls).toEqual(['first', 'second']);
    expect(h.queueSnapshot()).toEqual([]);
    expect(h.isBusy()).toBe(false);
    h.dispose();
  });
});

// —— Ctrl+C 协议 ——
describe('Ctrl+C 双击退出协议', () => {
  it('空闲首按：提示出现、不退出', () => {
    const { h } = makeHarness();
    h.feed(CTRL_C);
    expect((h.state.indicators ?? []).join(' ')).toContain('再按一次');
    h.dispose();
  });

  it('窗口内二按：退出码 130（sigint）', async () => {
    const { h, exitCodes } = makeHarness();
    const done = h.awaitDone();
    h.feed(CTRL_C);
    h.feed(CTRL_C);
    await done;
    expect(exitCodes).toEqual([130]);
    h.dispose();
  });

  it('窗口过期（2s）后二按仍为 pending，不退出', async () => {
    const { h, exitCodes } = makeHarness();
    h.feed(CTRL_C);
    await vi.advanceTimersByTimeAsync(2100);
    h.feed(CTRL_C);
    expect(exitCodes).toEqual([]);
    h.dispose();
  });

  it('忙时 Ctrl+C：取消当前 turn（abortTurn），不退出', async () => {
    let aborted = 0;
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    const { h, exitCodes } = makeHarness(
      makeRuntime({
        runUserTurn: async () => {
          await blocker;
          return result('done');
        },
        abortTurn: () => {
          aborted += 1;
        },
      }),
    );
    h.submit('长任务');
    await vi.advanceTimersByTimeAsync(0);
    h.feed(CTRL_C);
    expect(aborted).toBe(1);
    expect(exitCodes).toEqual([]);
    release();
    await settle(h);
    h.dispose();
  });
});

// —— Ctrl+D 语义（keymap 裁决：半页下滚，不再是空草稿退出）——
describe('Ctrl+D 语义（keymap 裁决）', () => {
  const CTRL_D = '\x04';

  it('空草稿 Ctrl+D 不退出，走半页下滚（退出只走 Ctrl+C 双击与 /exit）', async () => {
    const boot = Array.from({ length: 60 }, (_, i) => `历史行 ${i}`);
    const { h, exitCodes } = makeHarness(undefined, { bootLines: boot });
    h.feed(WHEEL_UP); // 脱开 follow，便于观察滚动位移
    const before = h.state.scrollback.scrollTopRow;
    h.feed(CTRL_D);
    expect(exitCodes).toEqual([]); // 不退出
    expect(h.state.scrollback.scrollTopRow).toBeGreaterThan(before); // 半页下滚生效
    h.dispose();
  });

  it('非空草稿 Ctrl+D 同样不退出、不动草稿', async () => {
    const { h, exitCodes } = makeHarness();
    h.feed('草稿中');
    h.feed(CTRL_D);
    expect(exitCodes).toEqual([]);
    expect(h.state.draft).toBe('草稿中');
    h.dispose();
  });
});

// —— Esc 语义 ——
describe('Esc 语义', () => {
  it('忙时 Esc 取消当前 turn', async () => {
    let aborted = 0;
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
        abortTurn: () => {
          aborted += 1;
        },
      }),
    );
    h.submit('长任务');
    await vi.advanceTimersByTimeAsync(0);
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60); // 孤立 ESC 空闲超时（50ms）后 parser 才产出 Esc 键
    expect(aborted).toBe(1);
    release();
    await settle(h);
    h.dispose();
  });

  it('空闲 Esc 清空草稿', async () => {
    const { h } = makeHarness();
    h.feed('abc');
    expect(h.state.draft).toBe('abc');
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60); // 孤立 ESC 空闲超时（50ms）后 parser 才产出 Esc 键
    expect(h.state.draft).toBe('');
    h.dispose();
  });
});

// —— 编辑键 ——
describe('编辑与粘贴', () => {
  it('Shift+Enter 换行（草稿多行）', () => {
    const { h } = makeHarness();
    h.feed('a');
    h.feed(SHIFT_ENTER);
    h.feed('b');
    expect(h.state.draft).toBe('a\nb');
    h.dispose();
  });

  it('bracketed paste：CRLF 归一为 LF 且绝不触发提交', () => {
    const calls: string[] = [];
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (text: string) => {
          calls.push(text);
          return result('x');
        },
      }),
    );
    h.feed(pasteOf('one\r\ntwo\rthree'));
    expect(h.state.draft).toBe('one\ntwo\nthree');
    expect(calls).toEqual([]);
    h.dispose();
  });
});

// —— 滚动 ——
describe('scrollback 滚动', () => {
  it('滚轮上滚脱开 follow', () => {
    const boot = Array.from({ length: 60 }, (_, i) => `历史行 ${i}`);
    const { h } = makeHarness(undefined, { bootLines: boot });
    expect(h.state.scrollback.follow).toBe(true);
    h.feed(WHEEL_UP);
    expect(h.state.scrollback.follow).toBe(false);
    h.dispose();
  });
});

// —— resize ——
describe('终端 resize', () => {
  it('resize 更新 screen 尺寸并保持内容区宽契约（cols-1）', () => {
    const { h } = makeHarness(undefined, { bootLines: ['一', '二', '三'] });
    h.resize(60, 20);
    expect(h.state.scrollback.cols).toBe(59);
    expect(linesOf(h)).toContain('一');
    h.dispose();
  });

  it('宽度变化触发全量重投影：截断行按新宽度重排（行宽自洽），加宽后恢复全文', async () => {
    const { displayWidth } = await import('../../../src/tui/input.js');
    const longPath = 'a'.repeat(200);
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({
            type: 'tool-call',
            call: { id: 'cw', name: 'write', arguments: JSON.stringify({ file_path: longPath }) },
            turnId: 't1',
          });
          onStream({ type: 'tool-result', callId: 'cw', ok: true, turnId: 't1' });
          return result('done');
        },
      }),
    );
    h.submit('写长文件');
    await settle(h);
    const fullLine = `⏺ write(${longPath})`;
    // 初始 cols=100 → 内容区 99：投影截断 ≤99 宽
    const initial = linesOf(h).find((l) => l.startsWith('⏺ write('));
    expect(initial).toBeDefined();
    expect(displayWidth(initial ?? '')).toBeLessThanOrEqual(99);
    // 窄化到 40 → 内容区 39：重投影后调用行按新宽度重排（旧 99 宽截断不得滞留）
    h.resize(40, 20);
    const narrowed = linesOf(h).find((l) => l.startsWith('⏺ write('));
    expect(narrowed).toBeDefined();
    expect(displayWidth(narrowed ?? '')).toBeLessThanOrEqual(39);
    expect(narrowed?.endsWith('…')).toBe(true);
    // 加宽到 300 → 内容区 299：全文恢复（不再截断）
    h.resize(300, 30);
    expect(linesOf(h)).toContain(fullLine);
    h.dispose();
  });
});

// —— steer ——
describe('steer 观察', () => {
  it('observeSteer 回帧写入 system 行', async () => {
    const { h, runtime } = makeHarness();
    h.submit('主任务');
    await settle(h);
    const observers = (runtime as unknown as { __steerObservers: Set<(r: SteerResult) => void> }).__steerObservers;
    expect(observers.size).toBeGreaterThan(0);
    for (const fn of observers) fn({ state: 'accepted' } as SteerResult);
    h.flushUi();
    expect(linesOf(h).join('\n')).toContain('steer 已接受');
    h.dispose();
  });
});

// —— 命令 ——
describe('斜杠命令（next 模式最小集）', () => {
  it('/help 输出帮助文本进转录', () => {
    const { h } = makeHarness();
    h.feed('/help\r');
    expect(linesOf(h).join('\n')).toContain('命令：');
    h.dispose();
  });

  it('/exit 请求退出（退出码 0）', async () => {
    const { h, exitCodes } = makeHarness();
    const done = h.awaitDone();
    h.feed('/exit\r');
    await done;
    expect(exitCodes).toEqual([0]);
    h.dispose();
  });

  it('未知命令如实提示暂不支持', () => {
    const { h } = makeHarness();
    h.feed('/frobnicate\r');
    expect(linesOf(h).join('\n')).toContain('暂不支持');
    h.dispose();
  });
});

// —— 回合结束提醒 ——
describe('notifier 回合结束提醒', () => {
  it('HARNESS2_NOTIFY=always 时回合结束发 BEL', async () => {
    const bells: string[] = [];
    const { h } = makeHarness(undefined, {
      env: { HARNESS2_NOTIFY: 'always' },
      notifyWrite: (s) => bells.push(s),
    });
    h.submit('你好');
    await settle(h);
    expect(bells).toContain('\x07');
    h.dispose();
  });

  it('cancelled 回合不发提醒', async () => {
    const bells: string[] = [];
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async () => result('', { stopReason: 'cancelled', textOutcome: 'partial', partialText: '半截' }),
      }),
      { env: { HARNESS2_NOTIFY: 'always' }, notifyWrite: (s) => bells.push(s) },
    );
    h.submit('取消我');
    await settle(h);
    expect(bells).not.toContain('\x07');
    h.dispose();
  });
});

// —— 审批 overlay ——
describe('审批 overlay', () => {
  it('gate.ask 打开 overlay → 数字直选 2 → resolve a，overlay 关闭', async () => {
    let answer: string | null = null;
    const { h, gate } = makeHarness();
    const p = gate.ask('允许执行 write?').then((a) => {
      answer = a;
    });
    expect(h.pendingApproval()).toBe('允许执行 write?');
    expect(h.state.overlays.length).toBe(1);
    expect(h.state.overlays[0]?.title).toContain('Approval');
    expect(h.state.overlays[0]?.title).toContain('允许执行 write?');
    h.feed('2');
    await p;
    expect(answer).toBe('a');
    expect(h.pendingApproval()).toBeNull();
    expect(h.state.overlays.length).toBe(0);
    h.dispose();
  });

  it('↑↓ 循环改选高亮', () => {
    const { h, gate } = makeHarness();
    void gate.ask('允许执行 write?');
    h.feed(ARROW_DOWN);
    expect(h.state.overlays[0]?.activeIndex).toBe(1);
    h.feed(ARROW_UP);
    h.feed(ARROW_UP);
    expect(h.state.overlays[0]?.activeIndex).toBe(2); // 0 → 上滚循环到末项
    h.cancelApproval();
    h.dispose();
  });

  it('Enter 确认高亮项 → resolve y', async () => {
    let answer: string | null = null;
    const { h, gate } = makeHarness();
    const p = gate.ask('允许执行 write?').then((a) => {
      answer = a;
    });
    h.feed(ENTER);
    await p;
    expect(answer).toBe('y');
    h.dispose();
  });

  it('Esc 取消审批 → ASK_CANCELLED', async () => {
    let answer: string | undefined;
    const { h, gate } = makeHarness();
    const p = gate.ask('允许执行 write?').then((a) => {
      answer = a;
    });
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60); // 孤立 ESC 空闲超时后产出 Esc 键 → 审批取消
    await p;
    expect(answer).toBe(ASK_CANCELLED);
    h.dispose();
  });

  it('审批打开时草稿按键不下穿（composer blur）', () => {
    const { h, gate } = makeHarness();
    void gate.ask('允许执行 write?');
    h.feed('x');
    expect(h.state.draft).toBe('');
    h.cancelApproval();
    h.dispose();
  });
});

// —— 进程退出兜底（审查 P1）——
describe('process exit 兜底还原终端', () => {
  class FakeRawStdin {
    rawMode: boolean | null = null;
    setRawMode(mode: boolean): void {
      this.rawMode = mode;
    }
  }

  it('emergencyTerminalRestore 同步写出 MOUSE_OFF + SHOW_CURSOR + ALT_SCREEN_EXIT 并复位 raw mode', () => {
    const out = new FakeOut();
    const stdin = new FakeRawStdin();
    emergencyTerminalRestore(out, stdin);
    expect(out.buffer).toContain('\x1b[?1000;1002;1006l'); // MOUSE_OFF
    expect(out.buffer).toContain('\x1b[?25h'); // SHOW_CURSOR
    expect(out.buffer).toContain('\x1b[?1049l'); // ALT_SCREEN_EXIT
    expect(stdin.rawMode).toBe(false);
  });

  it('流已销毁（write/setRawMode 抛错）与未注入 stdin 时兜底不抛错（幂等无副作用）', () => {
    const out = new FakeOut();
    expect(() => emergencyTerminalRestore(out, undefined)).not.toThrow();
    const brokenOut = {
      write(): number {
        throw new Error('EPIPE');
      },
    };
    const brokenStdin = {
      setRawMode(): void {
        throw new Error('stream destroyed');
      },
    };
    expect(() => emergencyTerminalRestore(brokenOut, brokenStdin)).not.toThrow();
  });

  it('bindEmergencyExitRestore 注册 exit 监听 → 触发即兜底写出；解绑后监听移除、不再写出', () => {
    const out = new FakeOut();
    const stdin = new FakeRawStdin();
    const listeners = new Map<string | symbol, () => void>();
    const fakeProc = {
      on: (name: string | symbol, fn: () => void) => {
        listeners.set(name, fn);
        return fakeProc;
      },
      off: (name: string | symbol, fn: () => void) => {
        if (listeners.get(name) === fn) listeners.delete(name);
        return fakeProc;
      },
    } as unknown as Pick<NodeJS.Process, 'on' | 'off'>;
    const detach = bindEmergencyExitRestore(out, stdin, fakeProc);
    expect([...listeners.keys()].map(String)).toEqual(['exit']);
    const before = out.buffer.length;
    listeners.get('exit')?.();
    expect(out.buffer.length).toBeGreaterThan(before);
    expect(out.buffer).toContain('\x1b[?1049l');
    expect(stdin.rawMode).toBe(false);
    // 解绑：监听移除（exit 触发时不再有兜底回调可执行）
    detach();
    expect(listeners.has('exit')).toBe(false);
  });
});

// —— DECSET 1004 焦点上报 ——
describe('DECSET 1004 焦点上报', () => {
  it('创建即写出 1004h 开启序列（screen.start 后装配层补写）', () => {
    const { h, out } = makeHarness();
    expect(out.buffer).toContain('\x1b[?1004h');
    h.dispose();
  });

  it('focus out → 失焦发提醒；focus in → 恢复静默（unfocused 缺省策略，1004 开启后事件自然生效）', async () => {
    const bells: string[] = [];
    const { h } = makeHarness(undefined, { notifyWrite: (s) => bells.push(s) });
    h.submit('聚焦回合'); // 初始聚焦 → unfocused 策略不发
    await settle(h);
    expect(bells).not.toContain('\x07');
    h.feed('\x1b[O'); // focus out（parser 产出 FocusEvent → dispatcher 兜底 focused=false）
    h.submit('失焦回合');
    await settle(h);
    expect(bells).toContain('\x07');
    h.feed('\x1b[I'); // focus in
    h.submit('再聚焦回合');
    await settle(h);
    expect(bells).toHaveLength(1); // 只有失焦那一回合发过
    h.dispose();
  });
});

// —— 退出后行为 ——
describe('退出收敛', () => {
  it('awaitDone 后输入不再产生副作用、render 停止', async () => {
    const { h, out } = makeHarness();
    const done = h.awaitDone();
    h.feed(CTRL_C);
    h.feed(CTRL_C);
    await done;
    const lenBefore = out.buffer.length;
    h.feed('more');
    expect(out.buffer.length).toBe(lenBefore);
    h.dispose();
  });
});
