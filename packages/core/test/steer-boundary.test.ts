// S6 step 边界 steer + 投影兼容测试。
// 核心不变量：steer 是**控制输入**，只在安全 step 边界应用；原则
//   1) 只在 step 完整往返后、下个 step 前应用，不打断 provider 当前流；
//   2) stale base（expectedTurnId 过期）被拒且保 draft；
//   3) 同一 steer id 只生效一次（不双注入）；
//   4) 上一步有 must-complete（cancelGuaranteed:false）工具时排队，不强行另开 step；
//   5) 投影不变：steer 不进 session.log 的 user/message 正文；模型从投影重建的输入不变；
//   6) ack（sink.resolve）对每个提交 id 恰好回一次，并发/重连/边界不丢。
// 全部经 local MockProvider + 临时目录，不触真实网络。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../src/provider/mock.js';
import type { ChatProvider } from '../src/provider/types.js';
import { runTurn } from '../src/agent/loop.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SESSION_LOG_FILE, type AnySessionEvent } from '../src/session/types.js';
import type { SteerRequest, SteerResult } from '../src/interaction/types.js';
import type { SteerSink } from '../src/agent/types.js';
import type { ToolDefinition } from '../src/tools/types.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-steer-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function loadEvents(dir: string): AnySessionEvent[] {
  return readFileSync(join(dir, SESSION_LOG_FILE), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AnySessionEvent);
}

function makeTool(
  name: string,
  execute: ToolDefinition['execute'],
  extra: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: {} },
    execute,
    ...extra,
  };
}

/** 可在运行中随时推入 steer 的 sink 走查实现（模拟外部/并发输入） */
class TestSteerSink implements SteerSink {
  pending: SteerRequest[] = [];
  results: SteerResult[] = [];
  push(req: SteerRequest): void {
    this.pending.push(req);
  }
  take(): SteerRequest | undefined {
    return this.pending.shift();
  }
  resolve(result: SteerResult): void {
    this.results.push(result);
  }
}

/** 从日志独立回放（不与 loop 共享实现）：step/start 快照该时刻投影消息序列。
 *  tool/call 折叠进 assistant（不单独成行），与 provider.request 的 messages 对齐。 */
function replayProjectionAtStepStart(dir: string): string[][] {
  const sessionEvents = loadEvents(dir);
  const messages: string[] = [];
  const snapshots: string[][] = [];
  for (const e of sessionEvents) {
    if (e.type === 'step/start') {
      snapshots.push([...messages]);
      continue;
    }
    if (e.type === 'user/message') messages.push(`user:${e.payload.text}`);
    else if (e.type === 'assistant/message') messages.push(`assistant:${e.payload.text}`);
    else if (e.type === 'tool/result') messages.push(`toolresult:${e.payload.tool}`);
  }
  return snapshots;
}

type ReqMessage = { role: string; content?: string; name?: string };

function fmt(messages: ReqMessage[]): string[] {
  return messages.map((m) => {
    if (m.role === 'user' || m.role === 'assistant') return `${m.role}:${m.content}`;
    if (m.role === 'tool') return `toolresult:${m.name}`;
    return String(m.role);
  });
}

describe('S6 安全 step 边界 steer', () => {
  it('steer 在工具步骤后的边界被接受并注入下一 step；不做成 user/message；投影不变', async () => {
    const dir = tmpDir();
    const sink = new TestSteerSink();
    const provider = new MockProvider([
      { text: '查状态', toolCalls: [{ id: 'c1', name: 'look', arguments: '{}' }] },
      { text: '已转 B' },
    ]);
    const registry = new ToolRegistry();
    registry.register(makeTool('look', () => ({ output: 'ok' }), { cancelGuaranteed: true }));

    let pushed = false;
    const result = await runTurn(dir, {
      provider,
      tools: registry,
      cwd: dir,
      userText: '做 A',
      steer: sink,
      onStream: (e) => {
        // 模拟外部在本 step（第一步）进行中发起 steer：用完真实 turnId 后推入
        if (e.type === 'tool-call' && !pushed) {
          pushed = true;
          sink.push({ id: 's1', expectedTurnId: e.turnId, text: '现在转向做 B' });
        }
      },
    });

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(2);

    // step1（查状态）请求无 steer；step2 边界接受 s1 → 叠加控制 user
    const req0 = provider.requests[0];
    const req1 = provider.requests[1];
    expect(fmt(req0!.messages as ReqMessage[])).toEqual(['user:做 A']);
    const req1Fmt = fmt(req1!.messages as ReqMessage[]);
    expect(req1Fmt.at(-1)).toBe('user:现在转向做 B');

    // --- 投影不变：日志回放（无 steer）与请求剥掉控制 user 后一致 ---
    const logSnaps = replayProjectionAtStepStart(dir);
    const reqSnapsStripped = provider.requests.map((r) =>
      fmt(r.messages as ReqMessage[]).filter((line) => line !== 'user:现在转向做 B'),
    );
    expect(reqSnapsStripped).toEqual(logSnaps);

    // steer 文本不出现在任何 user/message 事件（不伪造用户正文）
    for (const e of loadEvents(dir)) {
      if (e.type === 'user/message') expect(e.payload.text).not.toContain('现在转向做 B');
      if (e.type === 'assistant/message') expect(e.payload.text).not.toContain('现在转向做 B');
    }

    // ack：s1 accepted，expectedTurnId 为该 turn 真实 id（非占位）
    expect(sink.results).toHaveLength(1);
    expect(sink.results[0]!.state).toBe('accepted');
    expect(sink.results[0]!.expectedTurnId).toBe(result.turnId);
  });

  it('stale（expectedTurnId 与当前 turn 不符）被拒·draftKept；投影不变、不注入', async () => {
    const dir = tmpDir();
    const sink = new TestSteerSink();
    sink.push({ id: 'stale-1', expectedTurnId: 'some-other-turn', text: '别按旧方向' });
    const provider = new MockProvider([{ text: '完成' }]);
    const result = await runTurn(dir, { provider, tools: new ToolRegistry(), cwd: dir, userText: 'x', steer: sink });

    expect(result.stopReason).toBe('end_turn');
    expect(sink.results).toEqual([
      { id: 'stale-1', expectedTurnId: 'some-other-turn', state: 'stale', draftKept: true },
    ]);
    // 未注入：唯一请求的 user 是原始 userText，无 steer 文本
    expect(provider.requests[0]!.messages.map((m) => m.content)).toEqual(['x']);
  });

  it('重复 steer id 只生效一次：第二次到边界解析为 rejected，不双注入', async () => {
    const dir = tmpDir();
    const sink = new TestSteerSink();
    const provider = new MockProvider([
      { text: '做了 A', toolCalls: [{ id: 'c1', name: 'safe', arguments: '{}' }] },
      { text: '收尾' },
    ]);
    const registry = new ToolRegistry();
    registry.register(makeTool('safe', () => ({ output: 'x' }), { cancelGuaranteed: true }));

    let pushed = false;
    const result = await runTurn(dir, {
      provider,
      tools: registry,
      cwd: dir,
      userText: '开始',
      steer: sink,
      onStream: (e) => {
        if (e.type === 'tool-call' && !pushed) {
          pushed = true;
          // 同 id 推两次：只生效一次
          sink.push({ id: 'dup-1', expectedTurnId: e.turnId, text: '转向' });
          sink.push({ id: 'dup-1', expectedTurnId: e.turnId, text: '转向' });
        }
      },
    });

    // 只注入一次：step2 请求末尾出现一次「转向」
    const req1Fmt = fmt(provider.requests[1]!.messages as ReqMessage[]);
    expect(req1Fmt.filter((l) => l === 'user:转向')).toHaveLength(1);
    // 两个 id 都收到 ack：一次 accepted + 一次 rejected(duplicate)
    expect(sink.results).toEqual([
      { id: 'dup-1', expectedTurnId: result.turnId, state: 'accepted' },
      { id: 'dup-1', expectedTurnId: result.turnId, state: 'rejected' },
    ]);
  });

  it('must-complete 工具上一步后不强行另开 step：steer 排队等干净边界，不注入到结果回填步骤', async () => {
    const dir = tmpDir();
    const sink = new TestSteerSink();
    let mustExec = 0;
    let safeExec = 0;
    const provider = new MockProvider([
      // step1：must-complete（cancelGuaranteed:false）
      { text: '写关键数据', toolCalls: [{ id: 'c1', name: 'must_complete', arguments: '{}' }] },
      // step2：可取消（clean）工具
      { text: '读回确认', toolCalls: [{ id: 'c2', name: 'safe_back', arguments: '{}' }] },
      // step3：干净收尾
      { text: '按新方向 B' },
    ]);
    const registry = new ToolRegistry();
    registry.register(
      makeTool(
        'must_complete',
        () => {
          mustExec += 1;
          return { output: 'committed' };
        },
        { cancelGuaranteed: false },
      ),
    );
    registry.register(
      makeTool(
        'safe_back',
        () => {
          safeExec += 1;
          return { output: 'ok' };
        },
        { cancelGuaranteed: true },
      ),
    );

    let pushed = false;
    const result = await runTurn(dir, {
      provider,
      tools: registry,
      cwd: dir,
      userText: '开始',
      steer: sink,
      onStream: (e) => {
        // 第一条 must-complete 工具调用已宣布 → 在其后推入 steer
        if (e.type === 'tool-call' && e.call.name === 'must_complete' && !pushed) {
          pushed = true;
          sink.push({ id: 'mc-1', expectedTurnId: e.turnId, text: '转向' });
        }
      },
    });

    // step2（must_complete 后的自然结果回填/下一步）不注入 steer——没有另开独立 step
    const req1Fmt = fmt(provider.requests[1]!.messages as ReqMessage[]);
    expect(req1Fmt.some((l) => l === 'user:转向')).toBe(false);
    // step3（干净边界）才注入
    const req2Fmt = fmt(provider.requests[2]!.messages as ReqMessage[]);
    expect(req2Fmt.at(-1)).toBe('user:转向');
    // 每个工具只执行一次（无强制另开 step 导致的重复/打断）
    expect(mustExec).toBe(1);
    expect(safeExec).toBe(1);
    expect(sink.results).toHaveLength(1);
    expect(sink.results[0]).toEqual({ id: 'mc-1', expectedTurnId: result.turnId, state: 'accepted' });
  });

  it('step 进行中发起 steer 不打断当前 provider 流：流完整产出、无半截 attempt、ack 不丢', async () => {
    const dir = tmpDir();
    const sink = new TestSteerSink();
    let pushedMid = false;
    let pushedAsync = false;
    const streamProvider: ChatProvider = {
      name: 'stream',
      async *streamChat(_req) {
        yield { type: 'text-delta', text: '块0' };
        for (const t of ['块1', '块2', '块3', '块4']) {
          await new Promise((r) => setTimeout(r, 10));
          yield { type: 'text-delta', text: t };
        }
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const registry = new ToolRegistry();

    const pending = runTurn(dir, {
      provider: streamProvider,
      tools: registry,
      cwd: dir,
      userText: '开始',
      steer: sink,
      onStream: (e) => {
        if (e.type === 'text-delta' && e.text === '块0' && !pushedMid) {
          pushedMid = true;
          sink.push({ id: 'st-1', expectedTurnId: e.turnId, text: '中途转向' });
        }
      },
    });
    // 并发期再推一个（模拟重连/并发输入）：turnId 未知 → 用任意串，验证 stale 也回帧
    setTimeout(() => {
      if (!pushedAsync) {
        pushedAsync = true;
        sink.push({ id: 'st-2', expectedTurnId: 'unknown-concurrent', text: '并发转向' });
      }
    }, 2);
    const result = await pending;

    // 当前流未被打断：完整文本落盘为单条 assistant/message，无半截 attempt
    const events = loadEvents(dir);
    const assistant = events.find((e) => e.type === 'assistant/message');
    expect(assistant && assistant.type === 'assistant/message' ? assistant.payload.text : '').toBe('块0块1块2块3块4');
    expect(events.filter((e) => e.type === 'assistant/attempt')).toHaveLength(0);
    expect(result.stopReason).toBe('end_turn');
    // 单步纯文本 turn：两个 steer 都在结束前被 drain 并各自收到 ack（不丢）
    expect(sink.results.map((r) => r.id).sort()).toEqual(['st-1', 'st-2']);
  });

  it('turn 结束时 drain：未在边界应用的过期 steer 也收到明确 ack（不静默丢）', async () => {
    const dir = tmpDir();
    const sink = new TestSteerSink();
    sink.push({ id: 'late-1', expectedTurnId: 'other-turn', text: '迟到' });
    const provider = new MockProvider([{ text: '收工' }]);
    await runTurn(dir, { provider, tools: new ToolRegistry(), cwd: dir, userText: '开始', steer: sink });

    expect(sink.results).toEqual([{ id: 'late-1', expectedTurnId: 'other-turn', state: 'stale', draftKept: true }]);
  });
});
