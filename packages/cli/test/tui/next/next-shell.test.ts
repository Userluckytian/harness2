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
import { FG } from '../../../src/tui/next/projection.js';

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
  opts: {
    env?: Record<string, string | undefined>;
    notifyWrite?: (s: string) => void;
    bootLines?: string[];
    cwd?: string;
    home?: string;
  } = {},
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
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.home !== undefined ? { home: opts.home } : {}),
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

  it('statusline 上下文化（P3-E）：cwd(~ 短化) · model · ctx 占用', () => {
    const { h } = makeHarness(undefined, { cwd: '/tmp/harness2-next-test', home: '/tmp' });
    // model = provider.name（写入 assistant/message.model 的同一标识）；无活动会话 → ctx —
    expect(h.state.statusline).toBe('~/harness2-next-test · mock · ctx —');
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

// —— 折叠键族（P3-A：Tab 滚动区焦点 + e/E/h/l；旧 Ctrl+O 折叠语义迁移至此）——
const TAB = '\t';

/** 产出 write 工具（可展开 diff）的 runtime */
function foldRuntime(): ChatRuntime {
  return makeRuntime({
    runUserTurn: async (_text, onStream) => {
      onStream({
        type: 'tool-call',
        call: {
          id: 'cf',
          name: 'write',
          arguments: JSON.stringify({ file_path: 'a.txt', content: 'one\ntwo' }),
        },
        turnId: 't1',
      });
      onStream({ type: 'tool-result', callId: 'cf', ok: true, turnId: 't1' });
      return result('done');
    },
  });
}

async function submitFoldTurn(h: NextChatHarness): Promise<void> {
  h.submit('写');
  await settle(h);
}

describe('Tab 滚动区焦点（双态，keymap 裁决采纳）', () => {
  it('Tab 切换焦点：指示器出现/消失', () => {
    const { h } = makeHarness();
    expect((h.state.indicators ?? []).join(' ')).not.toContain('scrollback');
    h.feed(TAB);
    expect((h.state.indicators ?? []).join(' ')).toContain('scrollback');
    h.feed(TAB);
    expect((h.state.indicators ?? []).join(' ')).not.toContain('scrollback');
    h.dispose();
  });
});

describe('折叠键族（e/E/h/l，仅滚动区焦点下生效）', () => {
  it('e = 展开全部块：write diff 与推理块都展开', async () => {
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({ type: 'reasoning-delta', text: '想一步\n想二步', turnId: 't1' });
          await vi.advanceTimersByTimeAsync(60); // live flush 落 assistant/step（含 reasoning）
          onStream({
            type: 'tool-call',
            call: {
              id: 'cf',
              name: 'write',
              arguments: JSON.stringify({ file_path: 'a.txt', content: 'one\ntwo' }),
            },
            turnId: 't1',
          });
          onStream({ type: 'tool-result', callId: 'cf', ok: true, turnId: 't1' });
          return result('done');
        },
      }),
    );
    await submitFoldTurn(h);
    const baseline = linesOf(h).join('\n');
    expect(baseline).toContain('▸ 思考…'); // 推理默认折叠
    expect(baseline).not.toContain('+ one'); // diff 默认折叠
    h.feed(TAB);
    h.feed('e');
    const expanded = linesOf(h).join('\n');
    expect(expanded).toContain('+ one'); // diff 展开
    expect(expanded).toContain('│ 想一步'); // 推理展开
    h.dispose();
  });

  it('E = 折叠全部块：展开态回到默认折叠（行数回落基线）', async () => {
    const { h } = makeHarness(foldRuntime());
    await submitFoldTurn(h);
    const baseline = linesOf(h).length;
    h.feed(TAB);
    h.feed('e');
    expect(linesOf(h).length).toBeGreaterThan(baseline);
    h.feed('E');
    expect(linesOf(h).length).toBe(baseline);
    expect(linesOf(h).join('\n')).not.toContain('+ one');
    h.dispose();
  });

  it('l = 展开最近一次工具/推理块（对齐旧 Ctrl+O 的定位策略）', async () => {
    const { h } = makeHarness(foldRuntime());
    await submitFoldTurn(h);
    expect(linesOf(h).join('\n')).not.toContain('+ one');
    h.feed(TAB);
    h.feed('l');
    expect(linesOf(h).join('\n')).toContain('+ one');
    h.dispose();
  });

  it('h = 折叠最近块：l 展开后一键收回', async () => {
    const { h } = makeHarness(foldRuntime());
    await submitFoldTurn(h);
    h.feed(TAB);
    h.feed('l');
    expect(linesOf(h).join('\n')).toContain('+ one');
    h.feed('h');
    expect(linesOf(h).join('\n')).not.toContain('+ one');
    h.dispose();
  });

  it('非滚动区焦点：e/h/l 照常进草稿不触发折叠；焦点下其余字母自动回到输入框', async () => {
    const { h } = makeHarness(foldRuntime());
    await submitFoldTurn(h);
    h.feed('he'); // 非焦点：逐字母插入草稿，不触发折叠
    expect(h.state.draft).toBe('he');
    expect(linesOf(h).join('\n')).not.toContain('+ one');
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120); // 孤立 ESC 空闲超时（≥50ms，跨 idle 周期相位）→ Esc 清草稿
    expect(h.state.draft).toBe('');
    h.feed(TAB); // 进入滚动区焦点
    h.feed('x'); // 其余字母键：自动回到输入框（grok simple 语义）并照常插入
    expect(h.state.draft).toBe('x');
    expect((h.state.indicators ?? []).join(' ')).not.toContain('scrollback'); // 焦点已回
    h.dispose();
  });
});

// —— Ctrl+O always-approve（keymap 裁决迁移；UI 开关经 gate resolve 代答 'a'，红线 6）——
describe('Ctrl+O always-approve 切换', () => {
  it('开启：指示器出现；其后审批自动代答 a（gate resolve 路径，overlay 不残留）', async () => {
    const { h, gate } = makeHarness();
    h.feed(CTRL_O);
    expect((h.state.indicators ?? []).join(' ')).toContain('always-approve');
    const answer = await gate.ask('允许执行 write?');
    expect(answer).toBe('a');
    expect(h.pendingApproval()).toBeNull();
    expect(h.state.overlays.length).toBe(0);
    h.feed(CTRL_O); // 再按关闭
    expect((h.state.indicators ?? []).join(' ')).not.toContain('always-approve');
    h.dispose();
  });

  it('关闭（缺省）：审批正常等待，手动回答生效', async () => {
    const { h, gate } = makeHarness();
    let answer: string | null = null;
    const p = gate.ask('允许执行 write?').then((a) => {
      answer = a;
    });
    expect(h.pendingApproval()).toBe('允许执行 write?'); // 挂起等待（未自动代答）
    expect(answer).toBeNull();
    h.approve('y');
    await p;
    expect(answer).toBe('y');
    h.dispose();
  });

  it('挂起审批时切换：当次不自动代答、overlay 保留；下一次审批才自动 a', async () => {
    const { h, gate } = makeHarness();
    let first: string | null = null;
    const p1 = gate.ask('第一次?').then((a) => {
      first = a;
    });
    expect(h.pendingApproval()).toBe('第一次?');
    h.feed(CTRL_O); // 审批卡接管键盘：Ctrl+O 切换开关（grok 卡片键位）
    expect((h.state.indicators ?? []).join(' ')).toContain('always-approve');
    expect(h.pendingApproval()).toBe('第一次?'); // 当次不受影响
    expect(first).toBeNull(); // 未被自动代答
    expect(h.state.overlays.length).toBe(1); // overlay 保留等待手动回答
    h.approve('y');
    await p1;
    expect(first).toBe('y');
    const second = await gate.ask('第二次?'); // 开关已开 → 新审批自动代答
    expect(second).toBe('a');
    h.dispose();
  });

  it('Ctrl+O 不再折叠工具卡（旧语义已迁移到 e/E/h/l）', async () => {
    const { h } = makeHarness(foldRuntime());
    await submitFoldTurn(h);
    const before = linesOf(h).length;
    h.feed(CTRL_O);
    expect(linesOf(h).length).toBe(before); // 行数不变（不再展开 diff）
    h.dispose();
  });
});

// —— 投影 fg → scrollback 物理 fg（P3-A 配色落地集成）——
describe('投影 fg 落进 scrollback 物理行', () => {
  it('ok 工具调用行绿色', async () => {
    const { h } = makeHarness(foldRuntime());
    await submitFoldTurn(h);
    const win = h.state.scrollback.visibleWindow(24);
    const call = win.rows.find((r) => r.text.startsWith('⏺ write('));
    expect(call?.fg).toBe(FG.green);
  });

  it('失败工具调用行红色', async () => {
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({
            type: 'tool-call',
            call: { id: 'cx', name: 'bash', arguments: '{"command":"nope"}' },
            turnId: 't1',
          });
          onStream({ type: 'tool-result', callId: 'cx', ok: false, error: '命令不存在', turnId: 't1' });
          return result('', { stopReason: 'error', textOutcome: 'empty', finalText: undefined });
        },
      }),
    );
    h.submit('跑');
    await settle(h);
    const win = h.state.scrollback.visibleWindow(24);
    const row = win.rows.find((r) => r.text.startsWith('⏺ bash('));
    expect(row?.fg).toBe(FG.red);
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

  it('未知命令走共享「未知命令」文案（P3-C 全集接齐后不再有 next 层暂不支持分支）', () => {
    const { h } = makeHarness();
    h.feed('/frobnicate\r');
    expect(linesOf(h).join('\n')).toContain('未知命令 /frobnicate');
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

  it('Esc = 寄放焦点：不回答不关闭（P3-B grok 语义；取消只走 Ctrl+C / cancelApproval）', async () => {
    let answer: string | undefined;
    const { h, gate } = makeHarness();
    const p = gate.ask('允许执行 write?').then((a) => {
      answer = a;
    });
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60); // 孤立 ESC 空闲超时后产出 Esc 键 → 寄放（不取消）
    expect(answer).toBeUndefined(); // 未被回答
    expect(h.pendingApproval()).toBe('允许执行 write?'); // 审批仍挂起
    expect(h.state.overlays.length).toBe(1); // 卡片仍显示
    h.cancelApproval(); // 显式取消仍是取消
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

// =====================================================================
// P3-B：审批 blocking card（grok 键位）+ 模式循环（Shift+Tab）+ /plan /auto
// /always-approve + 底边模式指示。红线 6：审批不得弱化——mode/always-approve
// 都只是审批 gate 的 UI 决策路径，最终仍经 gate resolve（'a'=allow-always），
// plan/auto 为声明态绝不自动回答审批。
// =====================================================================
const SHIFT_TAB = '\x1b[Z'; // parser：CSI Z → tab + shift
const CTRL_F = '\x06';

// —— 审批 blocking card 键位（grok permission prompt 契约）——
describe('P3-B 审批 blocking card：Tab/Shift+Tab 走行', () => {
  it('Tab 正向循环走行（末项回绕首项）', () => {
    const { h, gate } = makeHarness();
    void gate.ask('允许执行 write?');
    h.feed(TAB);
    expect(h.state.overlays[0]?.activeIndex).toBe(1);
    h.feed(TAB);
    h.feed(TAB);
    expect(h.state.overlays[0]?.activeIndex).toBe(0); // 2 → 回绕 0
    h.cancelApproval();
    h.dispose();
  });

  it('Shift+Tab 反向循环走行（首项回绕末项）', () => {
    const { h, gate } = makeHarness();
    void gate.ask('允许执行 write?');
    h.feed(SHIFT_TAB);
    expect(h.state.overlays[0]?.activeIndex).toBe(2); // 0 → 回绕末项
    h.feed(SHIFT_TAB);
    expect(h.state.overlays[0]?.activeIndex).toBe(1);
    h.cancelApproval();
    h.dispose();
  });

  it('数字直选 1/3 → resolve y/n（2 → a 由既有用例覆盖）', async () => {
    let answer: string | null = null;
    const { h, gate } = makeHarness();
    const p = gate.ask('允许执行 write?').then((a) => {
      answer = a;
    });
    h.feed('3');
    await p;
    expect(answer).toBe('n');
    h.dispose();
    const { h: h2, gate: gate2 } = makeHarness();
    let answer2: string | null = null;
    const p2 = gate2.ask('允许执行 write?').then((a) => {
      answer2 = a;
    });
    h2.feed('1');
    await p2;
    expect(answer2).toBe('y');
    h2.dispose();
  });

  it('Enter 确认走行后的高亮项（Tab 到第 2 项再 Enter → a）', async () => {
    let answer: string | null = null;
    const { h, gate } = makeHarness();
    const p = gate.ask('允许执行 write?').then((a) => {
      answer = a;
    });
    h.feed(TAB);
    h.feed(ENTER);
    await p;
    expect(answer).toBe('a');
    h.dispose();
  });
});

describe('P3-B 审批 blocking card：Ctrl+F 参数全文展开', () => {
  const LONG_QUERY =
    '允许执行 write? [y]本次 [a]本会话总是（该工具后续所有调用不再询问） [n]拒绝 这是一段很长的说明文本用于验证展开折行';

  it('Ctrl+F 展开：审批 query 全文按显示宽度折行进 items（收起态只有 3 个选项）', () => {
    const { h, gate } = makeHarness();
    void gate.ask(LONG_QUERY);
    expect(h.state.overlays[0]?.items).toHaveLength(3); // 收起：仅选项
    h.feed(CTRL_F);
    const items = h.state.overlays[0]?.items ?? [];
    expect(items.length).toBeGreaterThan(3); // 全文行 + 选项
    const joined = items
      .map((it) => (typeof it === 'string' ? it : it.label))
      .join('\n')
      .replace(/\s+/g, '');
    expect(joined).toContain(LONG_QUERY.replace(/\s+/g, '')); // 全文可见（不被标题行裁剪）
    h.cancelApproval();
    h.dispose();
  });

  it('Ctrl+F 再按收起：恢复 3 选项结构', () => {
    const { h, gate } = makeHarness();
    void gate.ask(LONG_QUERY);
    h.feed(CTRL_F);
    h.feed(CTRL_F);
    expect(h.state.overlays[0]?.items).toHaveLength(3);
    h.cancelApproval();
    h.dispose();
  });

  it('展开态 Tab 走行仍只在 3 个选项间循环（高亮只落在选项行）', () => {
    const { h, gate } = makeHarness();
    void gate.ask(LONG_QUERY);
    h.feed(CTRL_F);
    const items = h.state.overlays[0]?.items ?? [];
    const queryRows = items.length - 3;
    h.feed(TAB);
    expect(h.state.overlays[0]?.activeIndex).toBe(queryRows + 1); // 显示高亮 = 全文行数 + 选项下标
    h.feed(TAB);
    h.feed(TAB);
    expect(h.state.overlays[0]?.activeIndex).toBe(queryRows + 0); // 循环回第一选项
    h.cancelApproval();
    h.dispose();
  });

  it('展开态数字直选仍直接回答（不受全文行影响）', async () => {
    let answer: string | null = null;
    const { h, gate } = makeHarness();
    const p = gate.ask(LONG_QUERY).then((a) => {
      answer = a;
    });
    h.feed(CTRL_F);
    h.feed('2');
    await p;
    expect(answer).toBe('a');
    h.dispose();
  });

  it('resize 重建展开视图（新宽度重排全文行）', () => {
    const { h, gate } = makeHarness();
    void gate.ask(LONG_QUERY);
    h.feed(CTRL_F);
    const narrowCount = (h.state.overlays[0]?.items ?? []).length;
    h.resize(40, 24);
    const items = h.state.overlays[0]?.items ?? [];
    expect(items.length - 3).toBeGreaterThanOrEqual(narrowCount - 3); // 变窄 → 全文行数不减
    h.cancelApproval();
    h.dispose();
  });
});

describe('P3-B 审批 blocking card：Esc 寄放焦点', () => {
  it('Esc 寄放：卡片仍显示、审批仍挂起、键盘回 composer（可输入草稿）', async () => {
    const { h, gate } = makeHarness();
    void gate.ask('允许执行 write?');
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60); // 孤立 ESC 空闲超时 → Esc 键
    expect(h.state.overlays.length).toBe(1); // 卡片保持显示
    expect(h.pendingApproval()).toBe('允许执行 write?'); // 审批挂起
    h.feed('x');
    expect(h.state.draft).toBe('x'); // 键盘已回 composer
    h.dispose();
  });

  it('寄放后 Tab 显式回卡：键盘重新被卡接管，数字直选可回答', async () => {
    let answer: string | null = null;
    const { h, gate } = makeHarness();
    const p = gate.ask('允许执行 write?').then((a) => {
      answer = a;
    });
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60);
    h.feed('x'); // 寄放态打草稿
    h.feed(TAB); // 回卡
    h.feed('2'); // 数字直选落在卡上（不进草稿）
    await p;
    expect(answer).toBe('a');
    expect(h.state.draft).toBe('x'); // '2' 未进草稿
    expect(h.state.overlays.length).toBe(0); // 回答后卡片关闭
    h.dispose();
  });

  it('寄放后审批仍可被编程回答（approve/cancelApproval 路径不受寄放影响）', async () => {
    let answer: string | null = null;
    const { h, gate } = makeHarness();
    const p = gate.ask('允许执行 write?').then((a) => {
      answer = a;
    });
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60);
    h.approve('y');
    await p;
    expect(answer).toBe('y');
    expect(h.state.overlays.length).toBe(0);
    h.feed('a');
    expect(h.state.draft).toBe('a'); // 关卡后键盘在 composer
    h.dispose();
  });

  it('寄放后 Ctrl+C 取消审批 → ASK_CANCELLED（卡片内 Ctrl+C 语义）', async () => {
    let answer: string | undefined;
    const { h, gate } = makeHarness();
    const p = gate.ask('允许执行 write?').then((a) => {
      answer = a;
    });
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60);
    h.feed(CTRL_C);
    await p;
    expect(answer).toBe(ASK_CANCELLED);
    expect(h.state.overlays.length).toBe(0);
    h.dispose();
  });

  it('寄放态指示器提示审批待答与回卡路径', async () => {
    const { h, gate } = makeHarness();
    void gate.ask('允许执行 write?');
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60);
    expect((h.state.indicators ?? []).join(' ')).toContain('审批待答');
    expect((h.state.indicators ?? []).join(' ')).toContain('Tab');
    h.dispose();
  });

  it('寄放后新审批（gate.ask）重新接管键盘并复位寄放态', async () => {
    const { h, gate } = makeHarness();
    void gate.ask('第一次?');
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60);
    expect(h.state.overlays.length).toBe(1); // 第一张卡寄放显示
    void gate.ask('第二次?'); // 新提问挤占旧挂起
    expect(h.state.overlays[0]?.title).toContain('第二次?');
    h.feed('x');
    expect(h.state.draft).toBe(''); // 键盘已被新卡接管（不下穿）
    h.cancelApproval();
    h.dispose();
  });
});

// —— 模式循环（Shift+Tab 四态）——
describe('P3-B 模式循环（Shift+Tab）', () => {
  it('Normal→Plan→Auto→Always-approve→Normal 循环（底边指示）', () => {
    const { h } = makeHarness();
    const ind = (): string => (h.state.indicators ?? []).join(' ');
    expect(ind()).not.toContain('plan');
    h.feed(SHIFT_TAB);
    expect(ind()).toContain('plan');
    h.feed(SHIFT_TAB);
    expect(ind()).toContain('auto');
    h.feed(SHIFT_TAB);
    expect(ind()).toContain('always-approve');
    h.feed(SHIFT_TAB);
    expect(ind()).not.toContain('plan');
    expect(ind()).not.toContain('auto');
    expect(ind()).not.toContain('always-approve');
    h.dispose();
  });

  it('always-approve 态与 Ctrl+O 共享同一状态：循环到该态后新审批自动代答 a，切回 normal 恢复手动', async () => {
    const { h, gate } = makeHarness();
    h.feed(SHIFT_TAB);
    h.feed(SHIFT_TAB);
    h.feed(SHIFT_TAB); // → always-approve
    const answer = await gate.ask('第一次?');
    expect(answer).toBe('a'); // 经 gate.choose('a') resolve 路径（红线 6）
    h.feed(SHIFT_TAB); // → normal
    let manual: string | null = null;
    const p = gate.ask('第二次?').then((a) => {
      manual = a;
    });
    expect(h.pendingApproval()).toBe('第二次?'); // 不再代答
    h.approve('y');
    await p;
    expect(manual).toBe('y');
    h.dispose();
  });

  it('Ctrl+O 在非 normal 态切换：off 回 normal（开关与模式共享单态）', () => {
    const { h } = makeHarness();
    h.feed(SHIFT_TAB); // plan
    h.feed(CTRL_O); // → always-approve
    expect((h.state.indicators ?? []).join(' ')).toContain('always-approve');
    expect((h.state.indicators ?? []).join(' ')).not.toContain('plan');
    h.feed(CTRL_O); // → normal
    expect((h.state.indicators ?? []).join(' ')).not.toContain('always-approve');
    h.dispose();
  });

  it('审批卡焦点下 Shift+Tab = 反向走行而非模式切换（dispatcher 层级区分）', () => {
    const { h, gate } = makeHarness();
    void gate.ask('允许执行 write?');
    h.feed(SHIFT_TAB);
    expect(h.state.overlays[0]?.activeIndex).toBe(2); // 走行生效
    expect((h.state.indicators ?? []).join(' ')).not.toContain('plan'); // 模式未变
    h.cancelApproval();
    h.dispose();
  });

  it('寄放态 Shift+Tab = 模式循环（键盘在 composer）', async () => {
    const { h, gate } = makeHarness();
    void gate.ask('允许执行 write?');
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60); // 寄放
    h.feed(SHIFT_TAB);
    expect((h.state.indicators ?? []).join(' ')).toContain('plan'); // 模式已切
    expect(h.state.overlays.length).toBe(1); // 卡片仍寄放显示
    h.cancelApproval();
    h.dispose();
  });
});

// —— plan / auto 声明态（红线 6 负例）——
describe('P3-B plan / auto 声明态（红线 6：审批不得自动放行）', () => {
  it('plan 态提交消息：转录打 [plan mode] 提示行，turn 照常执行', async () => {
    const { h } = makeHarness();
    h.feed(SHIFT_TAB); // plan
    h.submit('做功能');
    await settle(h);
    const all = linesOf(h).join('\n');
    expect(all).toContain('[plan mode]');
    expect(all).toContain('收到：做功能'); // turn 照常执行（声明态不改执行）
    h.dispose();
  });

  it('plan 态审批仍需人工回答（不自动放行——红线 6 负例）', async () => {
    let answer: string | null = null;
    let resolved = false;
    const { h, gate } = makeHarness();
    h.feed(SHIFT_TAB); // plan
    const p = gate.ask('允许执行 write?').then((a) => {
      resolved = true;
      answer = a;
    });
    await vi.advanceTimersByTimeAsync(120); // 给任何「自动代答」留出机会
    expect(resolved).toBe(false); // 未被自动回答
    expect(h.pendingApproval()).toBe('允许执行 write?');
    expect(h.state.overlays.length).toBe(1);
    h.approve('n');
    await p;
    expect(answer).toBe('n');
    h.dispose();
  });

  it('auto 态为声明态：不代答、不改默认高亮（红线 6 负例）', async () => {
    let answer: string | null = null;
    const { h, gate } = makeHarness();
    h.feed(SHIFT_TAB);
    h.feed(SHIFT_TAB); // auto
    const p = gate.ask('允许执行 write?').then((a) => {
      answer = a;
    });
    await vi.advanceTimersByTimeAsync(120);
    expect(answer).toBeNull(); // 未自动放行
    expect(h.state.overlays[0]?.activeIndex).toBe(0); // 默认高亮未变（不诱导一键放行）
    h.approve('y');
    await p;
    expect(answer).toBe('y');
    h.dispose();
  });
});

// —— 模式斜杠命令 ——
describe('P3-B 模式斜杠命令（/plan /auto /always-approve）', () => {
  it('/plan 设置 plan 态并落系统行', () => {
    const { h } = makeHarness();
    h.feed('/plan\r');
    expect((h.state.indicators ?? []).join(' ')).toContain('plan');
    expect(linesOf(h).join('\n')).toContain('plan');
    h.dispose();
  });

  it('/auto 设置 auto 态（声明态说明落系统行）', () => {
    const { h } = makeHarness();
    h.feed('/auto\r');
    expect((h.state.indicators ?? []).join(' ')).toContain('auto');
    h.dispose();
  });

  it('/always-approve 开启；再跑一次关闭（toggle，grok 语义）', () => {
    const { h } = makeHarness();
    h.feed('/always-approve\r');
    expect((h.state.indicators ?? []).join(' ')).toContain('always-approve');
    h.feed('/always-approve\r');
    expect((h.state.indicators ?? []).join(' ')).not.toContain('always-approve');
    h.dispose();
  });

  it('/plan 幂等：已在 plan 态再跑保持 plan', () => {
    const { h } = makeHarness();
    h.feed('/plan\r');
    h.feed('/plan\r');
    expect((h.state.indicators ?? []).join(' ')).toContain('plan');
    h.dispose();
  });
});

// —— 底边模式指示 ——
describe('P3-B 底边模式指示（模式 · 焦点 · 其他）', () => {
  it('模式指示在焦点指示之前：plan + scrollback → [plan, scrollback]', () => {
    const { h } = makeHarness();
    h.feed('/plan\r');
    h.feed(TAB); // scrollback 焦点
    expect(h.state.indicators).toEqual(['plan', 'scrollback']);
    h.dispose();
  });

  it('always-approve 与 scrollback 共存且顺序正确', () => {
    const { h } = makeHarness();
    h.feed('/always-approve\r');
    h.feed(TAB);
    expect(h.state.indicators).toEqual(['always-approve', 'scrollback']);
    h.dispose();
  });

  it('normal 态不显示模式指示（缺省无模式）', () => {
    const { h } = makeHarness();
    h.feed(TAB);
    expect(h.state.indicators).toEqual(['scrollback']);
    h.dispose();
  });
});

// —— 审查 P2 补强：数字序号视觉提示 + 审批结算焦点复位 ——
describe('审批卡数字序号与焦点复位', () => {
  it('审批挂起时 spec 带 showNumbers（数字直选的视觉提示，审查 P2-3）', async () => {
    const { h, gate } = makeHarness();
    const p = gate.ask('允许执行 write?');
    expect(h.pendingApproval()).toBe('允许执行 write?');
    expect(h.state.overlays[0]?.showNumbers).toBe(true);
    h.approve('n');
    await p;
    h.dispose();
  });

  it('审批结算后滚动区焦点指示复位（审查 P2-1：scrollbackFocus 不残留）', async () => {
    const { h, gate } = makeHarness();
    h.feed(TAB); // 先切到滚动区焦点
    expect((h.state.indicators ?? []).join(' ')).toContain('scrollback');
    const p = gate.ask('允许执行 write?'); // 卡弹出（openApproval 复位焦点语义）
    await vi.advanceTimersByTimeAsync(80);
    h.approve('y'); // 结算（closeApproval 回 composer 焦点）
    await p;
    await vi.advanceTimersByTimeAsync(80);
    h.flushUi();
    expect((h.state.indicators ?? []).join(' ')).not.toContain('scrollback');
    h.dispose();
  });
});
