// P3-C+D 独立审查修复回归（P1-1 / P2-1 / P2-2 / P2-3，headless 单测）：
// - P1-1：审批结算（closeApproval）/寄放（parkApproval）感知子视图态——子视图打开时不抢
//   回 composer（杜绝「隐形输入进不绘制的草稿」）；picker 被审批挤占后恢复显示并保持其
//   键盘接管（方案 a，取舍见 next-shell closeApproval 注释）；subagentLayer 对非消费键
//   返回 consumed（视图层完全接管）。
// - P2-1：会话切换（/fork /new /resume）触发重投影时清空子会话瞬时状态；/resume 后磁盘
//   重投影仍可重建子会话入口（转录 item 自带 childSessionId）。
// - P2-2：磁盘 ∪ live 幂等合并唯一性守卫（同 seq 事件同 id 去重，变异下必红）。
// - P2-3：turn 异常中止后 subagentStarts 清空——残留条目会在下个 turn 给 spinner 续命
//   （busy && size>0），用 fake timers 断言行不再变化（定时器不空转）。
// 红绿流程：先于修复落盘（红），修复后转绿（日志存 Temp/p3cd-fix-evidence）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnySessionEvent, SteerResult, TurnResult } from '@harness2/core';
import type { ChatRuntime } from '../../../src/chat-setup.js';
import {
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  createApprovalGate,
  createNextChatHarness,
  type ApprovalGate,
  type NextChatHarness,
  type SubagentEventSink,
} from '../../../src/tui/next/next-shell.js';

const ENTER = '\r';
const ESC = '\x1b';
const TAB = '\t';
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
    root: '/tmp/harness2-p3cd-test',
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

/** 带会话切换状态的 runtime（P2-1：getCurrent/switchSession/fork 可变；dir 供磁盘重投影） */
function sessionRuntime(opts: {
  dirFor?: (id: string) => string | undefined;
  locate?: (id: string) => string | undefined;
}): ChatRuntime {
  let current: { id: string; dir: string } | null = { id: 's1', dir: '/nonexistent-s1' };
  return makeRuntime({
    getCurrent: (() => current) as unknown as ChatRuntime['getCurrent'],
    switchSession: ((id: string | null) => {
      current = id === null ? null : { id, dir: opts.dirFor?.(id) ?? '/nonexistent' };
    }) as unknown as ChatRuntime['switchSession'],
    fork: (() => {
      current = { id: 's-forked', dir: opts.dirFor?.('s-forked') ?? '/nonexistent' };
    }) as unknown as ChatRuntime['fork'],
    sessionManager: {
      list: () => [],
      locate: opts.locate ?? (() => undefined),
    } as unknown as ChatRuntime['sessionManager'],
  });
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
  sink: { emit: (sessionId: string, event: AnySessionEvent) => void };
}

function makeHarness(
  runtime: ChatRuntime = makeRuntime(),
  opts: { env?: Record<string, string | undefined> } = {},
): Fixture {
  const out = new FakeOut();
  const gate = createApprovalGate();
  const bridge = makeSink();
  const h = createNextChatHarness(runtime, {
    out,
    bootLines: [],
    env: opts.env ?? {},
    gate,
    subagentEventSink: bridge.sink,
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

function subviewLinesOf(h: NextChatHarness): string[] | null {
  return h.subagentViewLines();
}

function enterScrollbackFocus(h: NextChatHarness): void {
  h.feed(TAB); // 焦点 → 滚动区
}

/** 写一个合法子会话日志目录（session.v1.jsonl）：header + user + 2 行 assistant */
function fixtureChildDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'h2-p3cd-child-'));
  const lines = [
    { v: 1, seq: 1, ts: '2026-01-01T00:00:00.000Z', type: 'session/header', payload: { sessionId: 'child-1' } },
    {
      v: 1,
      seq: 2,
      ts: '2026-01-01T00:00:00.000Z',
      type: 'user/message',
      payload: { text: '子任务指令', turnId: 't1' },
    },
    {
      v: 1,
      seq: 3,
      ts: '2026-01-01T00:00:00.000Z',
      type: 'assistant/message',
      payload: { text: '子会话结果第 1 行。', turnId: 't1' },
    },
    {
      v: 1,
      seq: 4,
      ts: '2026-01-01T00:00:00.000Z',
      type: 'assistant/message',
      payload: { text: '子会话结果第 2 行。', turnId: 't1' },
    },
  ];
  writeFileSync(join(dir, 'session.v1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return dir;
}

/** 写一个父会话日志目录：含 subagent tool/call + tool/result（output 带 childSessionId） */
function fixtureParentDir(childId: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'h2-p3cd-parent-'));
  const lines = [
    { v: 1, seq: 1, ts: '2026-01-01T00:00:00.000Z', type: 'session/header', payload: { sessionId: 'parent' } },
    {
      v: 1,
      seq: 2,
      ts: '2026-01-01T00:00:00.000Z',
      type: 'user/message',
      payload: { text: '父会话消息', turnId: 't1' },
    },
    {
      v: 1,
      seq: 3,
      ts: '2026-01-01T00:00:00.000Z',
      type: 'tool/call',
      payload: { callId: 'sa1', tool: 'subagent_start', args: { description: '任务', prompt: 'p' }, turnId: 't1' },
    },
    {
      v: 1,
      seq: 4,
      ts: '2026-01-01T00:00:00.000Z',
      type: 'tool/result',
      payload: {
        callId: 'sa1',
        tool: 'subagent_start',
        ok: true,
        output: `{"childSessionId":"${childId}"}`,
        turnId: 't1',
      },
    },
  ];
  writeFileSync(join(dir, 'session.v1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return dir;
}

function cleanupDirs(...dirs: string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// —— P1-1：审批结算 × 子视图/picker 焦点竞态 ——
describe('P1-1 审批结算感知子视图态', () => {
  it('① busy 中 v 打开子视图 → 审批到达并回答 → 仍处子视图（composer 不聚焦、无隐形输入、Enter 不产生排队）', async () => {
    let release: (() => void) | undefined;
    const turnGate = new Promise<void>((r) => {
      release = r;
    });
    const childDir = fixtureChildDir();
    const { h, gate, sink } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({
            type: 'tool-call',
            turnId: 't1',
            call: { id: 'sa1', name: 'subagent_start', arguments: '{"description":"任务"}' },
          });
          await turnGate;
          return result('done', { toolCalls: 1 });
        },
        sessionManager: {
          list: () => [],
          locate: (id: string) => (id === 'child-1' ? childDir : undefined),
        } as unknown as ChatRuntime['sessionManager'],
      }),
    );
    // 登记子会话（onChildEvent 桥）→ busy 中打开子视图
    sink.emit('child-1', {
      type: 'user/message',
      seq: 2,
      payload: { text: '子任务指令', turnId: 't1' },
    } as unknown as AnySessionEvent);
    h.submit('跑个子任务');
    await settle(h); // busy + tool-call 落定
    expect(h.isBusy()).toBe(true);
    enterScrollbackFocus(h);
    h.feed('v'); // 1 个候选 → 直开视图
    expect(h.state.subagentView).toBeDefined();
    expect(subviewLinesOf(h)).toContain('❯ 子任务指令');

    // 审批到达（挤占）：gate.ask → openApproval
    void gate.ask('需要审批吗？');
    expect(h.state.overlays[0]?.title).toContain('Approval');
    h.approve('y'); // 结算 → closeApproval

    // 断言：仍处子视图，composer 未聚焦
    expect(h.state.subagentView).toBeDefined();
    expect(h.state.draft).toBe('');
    // 防御：任意字母不进草稿（视图层接管）；Enter 不产生排队（隐形提交）
    h.feed('x');
    expect(h.state.draft).toBe('');
    h.feed(ENTER);
    expect(h.queueSnapshot()).toHaveLength(0);
    // 子视图键仍可用：q 返回
    h.feed('q');
    expect(h.state.subagentView ?? null).toBeNull();

    release?.();
    await settle(h);
    expect(h.isBusy()).toBe(false);
    h.dispose();
    cleanupDirs(childDir);
  });

  it('② picker 被审批挤占 → 回答后 picker 恢复显示且键盘一致（审批期间无隐形改选）', async () => {
    const { h, gate, sink } = makeHarness();
    sink.emit('child-a', {
      type: 'user/message',
      seq: 1,
      payload: { text: '任务 A', turnId: 't1' },
    } as unknown as AnySessionEvent);
    sink.emit('child-b', {
      type: 'user/message',
      seq: 1,
      payload: { text: '任务 B', turnId: 't1' },
    } as unknown as AnySessionEvent);
    enterScrollbackFocus(h);
    h.feed('v'); // 2 个候选 → 选择列表
    expect(h.state.overlays[0]?.title).toContain('选择子会话');
    expect(h.state.draft).toBe('');

    // 审批到达（挤占浮层）：approval 层接管
    void gate.ask('需要审批吗？');
    expect(h.state.overlays[0]?.title).toContain('Approval');
    // 审批接管期间：j 不应隐形改选下层不可见 picker
    h.feed('j');
    h.approve('y'); // 结算 → closeApproval

    // 断言：picker 恢复显示（方案 a），选择进度未被隐形劫持，composer 未聚焦
    expect(h.state.overlays).toHaveLength(1);
    expect(h.state.overlays[0]?.title).toContain('选择子会话');
    expect(h.state.overlays[0]?.activeIndex).toBe(0);
    expect(h.state.draft).toBe('');
    // picker 键盘接管恢复：↓ + Enter 打开第二项
    h.feed(ARROW_DOWN);
    expect(h.state.overlays[0]?.activeIndex).toBe(1);
    h.feed(ENTER);
    expect(h.state.subagentView?.hint).toContain('child-b');
    h.feed('q');
    expect(h.state.subagentView ?? null).toBeNull();
    h.dispose();
  });

  it('③ 寄放（Esc park）在子视图打开时同样不抢 composer 焦点', async () => {
    const childDir = fixtureChildDir();
    const { h, gate, sink } = makeHarness(
      makeRuntime({
        sessionManager: {
          list: () => [],
          locate: (id: string) => (id === 'child-1' ? childDir : undefined),
        } as unknown as ChatRuntime['sessionManager'],
      }),
    );
    sink.emit('child-1', {
      type: 'user/message',
      seq: 2,
      payload: { text: '子任务指令', turnId: 't1' },
    } as unknown as AnySessionEvent);
    enterScrollbackFocus(h);
    h.feed('v');
    expect(h.state.subagentView).toBeDefined();
    void gate.ask('需要审批吗？');
    expect(h.state.overlays[0]?.title).toContain('Approval');
    h.feed(ESC); // 审批卡上 Esc = 寄放
    await vi.advanceTimersByTimeAsync(60); // 孤立 ESC 空闲超时后 parser 才产出 Esc 键
    // 寄放态：卡片仍显示、审批仍挂起；子视图打开 → 键盘不回 composer
    expect(h.pendingApproval()).toBe('需要审批吗？');
    expect(h.state.draft).toBe('');
    h.feed('x');
    expect(h.state.draft).toBe('');
    // 收尾：取消审批并退出视图
    h.cancelApproval();
    expect(h.state.overlays).toHaveLength(0);
    h.feed('q');
    expect(h.state.subagentView ?? null).toBeNull();
    h.dispose();
    cleanupDirs(childDir);
  });
});

// —— P2-1：跨会话状态清理 ——
describe('P2-1 会话切换清空子会话瞬时状态', () => {
  it('/fork 与 /new 触发重投影时清空 childSessions（v 不再打开视图）', () => {
    const { h, sink } = makeHarness(sessionRuntime({}));
    sink.emit('ghost', {
      type: 'user/message',
      seq: 1,
      payload: { text: '幽灵任务', turnId: 't1' },
    } as unknown as AnySessionEvent);
    enterScrollbackFocus(h);
    h.feed('v'); // 1 个候选 → 直开
    expect(h.state.subagentView).toBeDefined();
    h.feed('q');
    expect(h.state.subagentView ?? null).toBeNull();

    h.submit('/fork'); // 会话切换 s1 → s-forked → 清空
    h.feed('v');
    expect(h.state.subagentView ?? null).toBeNull();
    expect((h.state.indicators ?? []).some((i) => i.includes('无可打开的子会话'))).toBe(true);

    h.submit('/new'); // 会话切换 s-forked → null → 清空（幂等）
    h.feed('v');
    expect(h.state.subagentView ?? null).toBeNull();
    h.dispose();
  });

  it('/resume 后磁盘重投影重建子会话入口（live 登记已清，入口来自磁盘转录 item）', () => {
    const childDir = fixtureChildDir();
    const parentDir = fixtureParentDir('child-1');
    const { h, sink } = makeHarness(
      sessionRuntime({
        dirFor: (id) => (id === 's2' ? parentDir : undefined),
        locate: (id) => (id === 'child-1' ? childDir : undefined),
      }),
    );
    sink.emit('ghost', {
      type: 'user/message',
      seq: 1,
      payload: { text: '幽灵任务', turnId: 't1' },
    } as unknown as AnySessionEvent);
    h.submit('/resume s2');
    // 磁盘重投影：父会话转录 item 自带 childSessionId=child-1；ghost 登记已清
    expect(linesOf(h).some((l) => l.includes('Subagent "任务"'))).toBe(true);
    enterScrollbackFocus(h);
    h.feed('v'); // 仅 child-1 一个候选 → 直开（若 ghost 未清会是选择列表）
    expect(h.state.subagentView).toBeDefined();
    expect(h.state.subagentView?.hint).toContain('child-1');
    expect(subviewLinesOf(h)).toContain('❯ 子任务指令'); // 磁盘重放内容
    h.feed('q');
    expect(h.state.subagentView ?? null).toBeNull();
    h.dispose();
    cleanupDirs(childDir, parentDir);
  });
});

// —— P2-2：磁盘 ∪ live 幂等合并唯一性守卫 ——
describe('P2-2 磁盘 ∪ live 合并无重复行', () => {
  it('同 seq 事件（同源磁盘 + live 重放）合并后唯一；live 独有事件照常追加', () => {
    const dir = fixtureChildDir();
    const { h, sink } = makeHarness(
      makeRuntime({
        sessionManager: {
          list: () => [],
          locate: (id: string) => (id === 'child-1' ? dir : undefined),
        } as unknown as ChatRuntime['sessionManager'],
      }),
    );
    // live 侧重放与磁盘同源的三个事件（同 seq → 同派生 id）+ 一条 live 独有事件
    const emit = (seq: number, type: string, text: string): void => {
      sink.emit('child-1', { type, seq, payload: { text, turnId: 't1' } } as unknown as AnySessionEvent);
    };
    emit(2, 'user/message', '子任务指令');
    emit(3, 'assistant/message', '子会话结果第 1 行。');
    emit(4, 'assistant/message', '子会话结果第 2 行。');
    emit(5, 'assistant/message', 'live 独有行');
    enterScrollbackFocus(h);
    h.feed('v');
    const lines = subviewLinesOf(h) ?? [];
    // 唯一性断言：任一事件行不得出现两次（变异下去重失效 → 必红）
    const countOf = (t: string): number => lines.filter((l) => l === t).length;
    expect(countOf('❯ 子任务指令')).toBe(1);
    expect(countOf('子会话结果第 1 行。')).toBe(1);
    expect(countOf('子会话结果第 2 行。')).toBe(1);
    expect(countOf('live 独有行')).toBe(1);
    h.feed('q');
    h.dispose();
    cleanupDirs(dir);
  });
});

// —— P2-3：spinner 残留 ——
describe('P2-3 turn 收尾清空运行中子代理表', () => {
  it('异常中止后残留条目不给下个 turn 的 spinner 续命（定时器不空转）', async () => {
    let turn = 0;
    let release2: (() => void) | undefined;
    const turn2Gate = new Promise<void>((r) => {
      release2 = r;
    });
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          turn += 1;
          const call = (id: string): void => {
            onStream({
              type: 'tool-call',
              turnId: 't1',
              call: { id, name: 'subagent_start', arguments: '{"description":"任务"}' },
            });
          };
          if (turn === 1) {
            call('sa1');
            throw new Error('boom'); // 异常中止：tool/result 永不到达
          }
          call('sa2');
          onStream({ type: 'tool-result', callId: 'sa2', ok: true, turnId: 't1' });
          await turn2Gate; // 保持 busy，观察 spinner 是否被残留条目续命
          return result('ok2', { toolCalls: 1 });
        },
      }),
    );
    h.submit('第一条');
    await settle(h); // turn1 异常收尾（finally）
    expect(linesOf(h).some((l) => l.includes('error:'))).toBe(true);
    expect(h.isBusy()).toBe(false);

    h.submit('第二条');
    await settle(h); // turn2：sa2 起表 → 立即完成 → busy 挂起
    expect(h.isBusy()).toBe(true);

    // 推进 750ms（5 个 spinner 周期）：修复后 subagentStarts 已在 turn1 finally 清空，
    // sa2 完成后表空 → spinner 停表，转录行不再变化；修复前残留 sa1 使定时器持续空转
    const before = linesOf(h).join('\n');
    await vi.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 5);
    h.flushUi();
    const after = linesOf(h).join('\n');
    expect(after).toBe(before);
    expect(after.split('\n').some((l) => SPINNER_FRAMES.some((f) => l.startsWith(`${f} Subagent`)))).toBe(false);

    release2?.();
    await settle(h);
    expect(h.isBusy()).toBe(false);
    h.dispose();
  });
});
