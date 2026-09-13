// P3-D 子代理块耗时/动画 + Enter 全屏子视图（headless 单测）：
// - 耗时：UI 层计时（turn 事件流间隔），tool/result 时结算 → 投影文案 `完成（43s）`（近似，如实登记）
// - 运行动画：busy 且存在运行中子代理块时 150ms 定时器循环 spinner；空闲停表
// - 全屏子视图：滚动区焦点 v 打开（键位差异已登记 keymap 文档；grok 为选中块 Enter/Ctrl+F）；
//   磁盘重放（projectSession）+ 运行中经 SubagentHooks.onChildEvent 实时追加
// - 多子代理：列表选择浮层（overlay 复用）；q/Esc 返回
// 红绿流程：先于实现落盘（红），实现后转绿（日志存 Temp/p3d-evidence）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnySessionEvent, SteerResult, TurnResult } from '@harness2/core';
import type { ChatRuntime } from '../../../src/chat-setup.js';
import { setupChatSession } from '../../../src/chat-setup.js';
import { layoutChat } from '../../../src/tui/next/chat-screen.js';
import {
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  SUBAGENT_VIEW_KEY,
  createApprovalGate,
  createNextChatHarness,
  type ApprovalGate,
  type NextChatHarness,
  type SubagentEventSink,
} from '../../../src/tui/next/next-shell.js';

const ENTER = '\r';
const ESC = '\x1b';
const TAB = '\t';
const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const PAGEUP = '\x1b[5~';
const WHEEL_UP = '\x1b[<64;10;5M'; // SGR 滚轮上

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
    root: '/tmp/harness2-p3d-test',
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

/** onChildEvent 缝（runNextChat 真机路径的测试替身：set 注册 handler，测试直接调用） */
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
  opts: { env?: Record<string, string | undefined>; withSink?: boolean } = {},
): Fixture {
  const out = new FakeOut();
  const gate = createApprovalGate();
  const bridge = makeSink();
  const h = createNextChatHarness(runtime, {
    out,
    bootLines: [],
    env: opts.env ?? {},
    gate,
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

function subviewLinesOf(h: NextChatHarness): string[] | null {
  return h.subagentViewLines();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// —— 耗时（P3-D 任务 1）——
describe('P3-D 子代理耗时文案', () => {
  it('subagent_start 43s 后完成 → `⏺ Subagent "任务" 完成（43s）`', async () => {
    // gate 受控挂起，由测试侧推进时钟（嵌套大步长 advanceTimersByTimeAsync 会悬挂，已验证）
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({
            type: 'tool-call',
            turnId: 't1',
            call: { id: 'sa1', name: 'subagent_start', arguments: '{"description":"任务","prompt":"p"}' },
          });
          await gate;
          onStream({ type: 'tool-result', callId: 'sa1', ok: true, turnId: 't1' });
          return result('done', { toolCalls: 1 });
        },
      }),
    );
    h.submit('跑个子任务');
    await settle(h); // tool-call 落定（起表）
    await vi.advanceTimersByTimeAsync(43_000); // 测试侧推时钟：spinner 停表前 UI 计时到 43s
    release?.();
    await settle(h);
    expect(linesOf(h)).toContain('⏺ Subagent "任务" 完成（43s）');
    h.dispose();
  });

  it('普通工具完成不显示耗时', async () => {
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({
            type: 'tool-call',
            turnId: 't1',
            call: { id: 'r1', name: 'read', arguments: '{"file_path":"a.txt"}' },
          });
          await vi.advanceTimersByTimeAsync(43_000);
          onStream({ type: 'tool-result', callId: 'r1', ok: true, turnId: 't1' });
          return result('done', { toolCalls: 1 });
        },
      }),
    );
    h.submit('读文件');
    await settle(h, 44_000);
    expect(linesOf(h).some((l) => l.includes('43s'))).toBe(false);
    h.dispose();
  });

  it('即时完成（<1s）：不显示耗时（避免 0s 噪音）', async () => {
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({
            type: 'tool-call',
            turnId: 't1',
            call: { id: 'sa1', name: 'subagent_start', arguments: '{"description":"任务"}' },
          });
          onStream({ type: 'tool-result', callId: 'sa1', ok: true, turnId: 't1' });
          return result('done', { toolCalls: 1 });
        },
      }),
    );
    h.submit('跑个子任务');
    await settle(h);
    expect(linesOf(h)).toContain('⏺ Subagent "任务" 完成');
    expect(linesOf(h).some((l) => l.startsWith('⏺ Subagent') && l.includes('（'))).toBe(false);
    h.dispose();
  });
});

// —— 运行动画（P3-D 任务 2）——
describe('P3-D 子代理运行动画（spinner）', () => {
  it('busy 且子代理运行中：150ms 推进指示字符（SPINNER_FRAMES 循环）', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({
            type: 'tool-call',
            turnId: 't1',
            call: { id: 'sa1', name: 'subagent_start', arguments: '{"description":"任务"}' },
          });
          await gate;
          onStream({ type: 'tool-result', callId: 'sa1', ok: true, turnId: 't1' });
          return result('done', { toolCalls: 1 });
        },
      }),
    );
    h.submit('跑个子任务');
    await settle(h);
    expect(linesOf(h)).toContain(`${SPINNER_FRAMES[0]} Subagent "任务" 运行中`);
    await vi.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS);
    h.flushUi();
    expect(linesOf(h)).toContain(`${SPINNER_FRAMES[1]} Subagent "任务" 运行中`);
    await vi.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * (SPINNER_FRAMES.length - 1));
    h.flushUi();
    // 循环回第 0 帧（帧序 = 总推进次数对长度取模）
    expect(linesOf(h)).toContain(`${SPINNER_FRAMES[0]} Subagent "任务" 运行中`);
    release?.();
    await settle(h);
    expect(linesOf(h).some((l) => l.startsWith('⏺ Subagent "任务" 完成（'))).toBe(true); // 耗时随挂起时长
    h.dispose();
  });

  it('空闲（turn 结束）→ spinner 停表（定时器清空，行不再变化）', async () => {
    const { h } = makeHarness();
    h.submit('普通消息');
    await settle(h);
    const before = linesOf(h).join('\n');
    await vi.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 5);
    h.flushUi();
    expect(linesOf(h).join('\n')).toBe(before);
    h.dispose();
  });

  it('busy 但无运行中子代理 → 行级 spinner 不转（普通工具行不变；状态行动画另测 P4-2）', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({
            type: 'tool-call',
            turnId: 't1',
            call: { id: 'r1', name: 'read', arguments: '{"file_path":"a.txt"}' },
          });
          await gate;
          onStream({ type: 'tool-result', callId: 'r1', ok: true, turnId: 't1' });
          return result('done', { toolCalls: 1 });
        },
      }),
    );
    h.submit('读文件');
    await settle(h);
    const before = linesOf(h).join('\n');
    await vi.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 3);
    h.flushUi();
    expect(linesOf(h).join('\n')).toBe(before);
    release?.();
    await settle(h);
    h.dispose();
  });
});

// —— 全屏子视图（P3-D 任务 3）——
/** 写一个合法子会话日志目录（session.v1.jsonl）；lineCount 控制行数（滚动测试用） */
function fixtureChildDir(lineCount = 2): string {
  const dir = mkdtempSync(join(tmpdir(), 'h2-p3d-child-'));
  const lines = [
    { v: 1, seq: 1, ts: '2026-01-01T00:00:00.000Z', type: 'session/header', payload: { sessionId: 'child-1' } },
    {
      v: 1,
      seq: 2,
      ts: '2026-01-01T00:00:00.000Z',
      type: 'user/message',
      payload: { text: '子任务指令', turnId: 't1' },
    },
  ];
  for (let i = 0; i < lineCount; i += 1) {
    lines.push({
      v: 1,
      seq: 3 + i,
      ts: '2026-01-01T00:00:00.000Z',
      type: 'assistant/message',
      payload: { text: `子会话结果第 ${i + 1} 行。`, turnId: 't1' },
    });
  }
  writeFileSync(join(dir, 'session.v1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return dir;
}

/** 让 runtime.locate 指向 fixture 目录（真实磁盘重放路径） */
function runtimeWithChild(dir: string | undefined): ChatRuntime {
  return makeRuntime({
    sessionManager: { list: () => [], locate: () => dir } as unknown as ChatRuntime['sessionManager'],
  });
}

/** 注册一个子会话进 sink（真实桥路径：onChildEvent → childSessions）；seq=2 与磁盘 fixture 同源（幂等合并） */
function registerChild(f: { sink: Fixture['sink'] }, childId: string, prompt = '子任务指令'): void {
  f.sink.emit(childId, {
    type: 'user/message',
    seq: 2,
    payload: { text: prompt, turnId: 't1' },
  } as unknown as AnySessionEvent);
}

function enterScrollbackFocus(h: NextChatHarness): void {
  h.feed(TAB); // 焦点 → 滚动区
}

describe('P3-D 全屏子视图：打开/返回', () => {
  it(`键位常量：SUBAGENT_VIEW_KEY = 'v'（滚动区焦点下打开；差异登记 keymap 文档）`, () => {
    expect(SUBAGENT_VIEW_KEY).toBe('v');
  });

  it('composer 焦点下 v 不打开（照常插入草稿）', () => {
    const { h, sink } = makeHarness();
    registerChild({ sink }, 'child-a');
    h.feed('v');
    expect(h.state.draft).toBe('v');
    expect(h.state.subagentView ?? null).toBeNull();
    h.dispose();
  });

  it('打开视图（标准路径）：projectSession 磁盘重放 + q/Esc 返回 + composer 隐藏', async () => {
    const dir = fixtureChildDir();
    const { h, sink } = makeHarness(runtimeWithChild(dir));
    sink.emit('child-1', {
      type: 'user/message',
      seq: 2,
      payload: { text: '子任务指令', turnId: 't1' },
    } as unknown as AnySessionEvent);
    enterScrollbackFocus(h);
    h.feed(SUBAGENT_VIEW_KEY);
    const sv = h.state.subagentView;
    expect(sv).toBeDefined();
    expect(sv?.hint).toContain('q/Esc 返回');
    const lines = subviewLinesOf(h) ?? [];
    expect(lines).toContain('❯ 子任务指令');
    expect(lines).toContain('子会话结果第 1 行。');
    // 视图打开时 composer 隐藏：草稿 0 行、composer 层只剩提示行
    const layout = layoutChat(30, 100, h.state);
    expect(layout.draftRows).toBe(0);
    expect(layout.composer.height).toBe(1);
    // 主转录 scrollback 未被污染
    expect(linesOf(h)).not.toContain('子会话结果第 1 行。');
    // q 返回
    h.feed('q');
    expect(h.state.subagentView ?? null).toBeNull();
    // 再次打开 → Esc 返回（孤立 ESC 需 idle flush 兜底出键）
    h.feed(SUBAGENT_VIEW_KEY);
    expect(h.state.subagentView).toBeDefined();
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60); // 孤立 ESC 空闲超时（50ms）后 parser 才产出 Esc 键
    expect(h.state.subagentView ?? null).toBeNull();
    h.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('视图内 ↑↓/PgUp/滚轮 滚动可用', () => {
    const dir = fixtureChildDir(60); // 超过一屏（rows=30）
    const { h, sink } = makeHarness(runtimeWithChild(dir));
    sink.emit('child-1', {
      type: 'user/message',
      seq: 1,
      payload: { text: '子任务指令', turnId: 't1' },
    } as unknown as AnySessionEvent);
    enterScrollbackFocus(h);
    h.feed(SUBAGENT_VIEW_KEY);
    const sv = h.state.subagentView;
    expect(sv).toBeDefined();
    expect(sv?.scrollback.follow).toBe(true);
    h.feed(ARROW_UP);
    expect(sv?.scrollback.follow).toBe(false);
    const top1 = sv?.scrollback.scrollTopRow ?? 0;
    expect(top1).toBeGreaterThan(0);
    h.feed(ARROW_DOWN);
    h.feed(PAGEUP);
    expect(sv?.scrollback.scrollTopRow).toBeLessThan(top1);
    h.feed(WHEEL_UP);
    h.feed('q');
    expect(h.state.subagentView ?? null).toBeNull();
    h.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('定位失败：视图如实显示错误（不伪造内容）', () => {
    const { h, sink } = makeHarness(runtimeWithChild(undefined));
    // 只登记结构性事件（不可转录）：子会话已派发但无可读日志/无正文 → 错误行
    sink.emit('child-x', { type: 'step', seq: 1, payload: {} } as unknown as AnySessionEvent);
    enterScrollbackFocus(h);
    h.feed(SUBAGENT_VIEW_KEY);
    const lines = subviewLinesOf(h) ?? [];
    expect(lines.some((l) => l.includes('无法读取子会话 child-x'))).toBe(true);
    h.feed('q');
    h.dispose();
  });

  it('无子会话时 v：不打开视图，瞬时提示', () => {
    const { h } = makeHarness(runtimeWithChild(undefined));
    enterScrollbackFocus(h);
    h.feed(SUBAGENT_VIEW_KEY);
    expect(h.state.subagentView ?? null).toBeNull();
    expect((h.state.indicators ?? []).some((i) => i.includes('子会话'))).toBe(true);
    h.dispose();
  });
});

describe('P3-D 全屏子视图：多子代理列表选择', () => {
  function twoChildFixture(): { f: Fixture; dirA: string; dirB: string } {
    const dirA = fixtureChildDir();
    const dirB = fixtureChildDir();
    const runtime = makeRuntime({
      sessionManager: {
        list: () => [],
        locate: (id: string) => (id === 'child-a' ? dirA : id === 'child-b' ? dirB : undefined),
      } as unknown as ChatRuntime['sessionManager'],
    });
    const f = makeHarness(runtime);
    registerChild(f, 'child-a', '任务 A');
    registerChild(f, 'child-b', '任务 B');
    return { f, dirA, dirB };
  }

  it('两个子代理：v 打开选择列表 → Enter 打开高亮项', () => {
    const { f, dirA, dirB } = twoChildFixture();
    enterScrollbackFocus(f.h);
    f.h.feed(SUBAGENT_VIEW_KEY);
    // 列表浮层出现
    expect(f.h.state.overlays.length).toBe(1);
    expect(f.h.state.overlays[0]?.title).toContain('选择子会话');
    expect(f.h.state.overlays[0]?.items).toHaveLength(2);
    expect(f.h.state.subagentView ?? null).toBeNull();
    // ↓ 选中第二项 → Enter
    f.h.feed(ARROW_DOWN);
    f.h.feed(ENTER);
    expect(f.h.state.subagentView).toBeDefined();
    expect(f.h.state.subagentView?.hint).toContain('child-b');
    expect(subviewLinesOf(f.h)).toContain('❯ 任务 B');
    f.h.feed('q');
    expect(f.h.state.subagentView ?? null).toBeNull();
    f.h.dispose();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('选择列表 Esc 取消：不打开视图、浮层关闭、焦点回输入框', async () => {
    const { f, dirA, dirB } = twoChildFixture();
    enterScrollbackFocus(f.h);
    f.h.feed(SUBAGENT_VIEW_KEY);
    f.h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60); // 孤立 ESC 空闲超时（50ms）后 parser 才产出 Esc 键
    expect(f.h.state.overlays).toHaveLength(0);
    expect(f.h.state.subagentView ?? null).toBeNull();
    f.h.feed('x');
    expect(f.h.state.draft).toBe('x'); // 焦点已回 composer
    f.h.dispose();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });
});

// —— 运行中实时桥（P3-D 任务 3：SubagentHooks.onChildEvent → 子视图 Scrollback）——
describe('P3-D 运行中实时追加（onChildEvent 桥）', () => {
  it('视图打开时子会话事件实时进入子视图 scrollback', () => {
    const { h, sink } = makeHarness();
    sink.emit('child-live', {
      type: 'user/message',
      seq: 1,
      payload: { text: '运行中任务', turnId: 't1' },
    } as unknown as AnySessionEvent);
    enterScrollbackFocus(h);
    h.feed(SUBAGENT_VIEW_KEY);
    expect(h.state.subagentView).toBeDefined();
    expect(subviewLinesOf(h)).toContain('❯ 运行中任务');
    // 子会话 turn 进行中的 assistant 正文实时追加
    sink.emit('child-live', {
      type: 'assistant/message',
      seq: 2,
      payload: { text: '子会话实时正文', turnId: 't1' },
    } as unknown as AnySessionEvent);
    expect(subviewLinesOf(h)).toContain('子会话实时正文');
    h.feed('q');
    h.dispose();
  });

  it('视图未打开时事件也累积；打开后从内存重放（磁盘缺失时如实降级为缓存内容）', () => {
    const { h, sink } = makeHarness(); // locate → undefined（无磁盘）
    sink.emit('child-m', {
      type: 'user/message',
      seq: 1,
      payload: { text: '早期事件', turnId: 't1' },
    } as unknown as AnySessionEvent);
    sink.emit('child-m', {
      type: 'assistant/message',
      seq: 2,
      payload: { text: '早期正文', turnId: 't1' },
    } as unknown as AnySessionEvent);
    enterScrollbackFocus(h);
    h.feed(SUBAGENT_VIEW_KEY);
    const lines = subviewLinesOf(h) ?? [];
    expect(lines).toContain('❯ 早期事件');
    expect(lines).toContain('早期正文');
    h.dispose();
  });
});

// —— 装配层接线（P3-D 任务 3：setupChatSession → createSubagentTools.hooks）——
describe('P3-D 装配层接线（setupChatSession subagentHooks）', () => {
  it('subagentHooks 透传：真实 mock subagent_start 触发 onChildEvent（子会话事件桥出）', async () => {
    vi.useRealTimers();
    const events: Array<{ sessionId: string; type: string }> = [];
    const home = mkdtempSync(join(tmpdir(), 'h2-p3d-home-'));
    const root = mkdtempSync(join(tmpdir(), 'h2-p3d-root-'));
    const runtime = await setupChatSession(
      {
        provider: 'mock',
        home,
        root,
        mockScript: [
          {
            textChunks: ['派发子任务。'],
            toolCalls: [{ id: 'sa-1', name: 'subagent_start', arguments: JSON.stringify({ prompt: '子任务指令' }) }],
          },
        ],
        mockChildScript: [{ textChunks: ['子会话完成。'] }],
      },
      {
        line: () => undefined,
        askApproval: async () => 'n',
        subagentHooks: {
          onChildEvent: (sessionId, event) => events.push({ sessionId, type: event.type }),
        },
      },
    );
    try {
      await runtime.runUserTurn('开始', () => undefined);
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === 'user/message')).toBe(true);
      expect(events.some((e) => e.type === 'assistant/message')).toBe(true);
      expect(new Set(events.map((e) => e.sessionId)).size).toBe(1); // 同一子会话
    } finally {
      try {
        await runtime.finish({});
      } catch {
        // 清理忽略
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
