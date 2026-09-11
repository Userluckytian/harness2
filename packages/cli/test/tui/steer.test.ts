// T5 steer 控制输入接线测试：
//   纯：buildSteerRequest（turnId 缺失/空白 → null）、makeSteerId、describeSteerResult（stale 保草稿）。
//   sink：同 id 重复 → push false + rejected 回帧；take 顺序；观察者退订。
//   真实 core loop 联调（in-process）：真 SessionSteerSink 语义 sink + 真实 runTurn + provider 测试替身，
//     在安全 step 边界 accepted（控制文本叠加进下一 step 请求且**不入投影正文**）；expectedTurnId 不符 → stale+ draftKept。
//   ChatRuntime：空闲/无 turnId → unknown（保草稿）；mock 真实 turn 内提交 → observed accepted。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeProjection,
  loadSession,
  runTurn,
  SessionWriter,
  ToolRegistry,
  type ChatProvider,
  type ChatRequest,
  type SteerResult,
  type StreamChunk,
} from '@harness2/core';
import { CliSteerSink, buildSteerRequest, describeSteerResult, makeSteerId } from '../../src/steer.js';
import { MOCK_DEMO_SCRIPT } from '../../src/chat-setup.js';
import { createTestRuntime, type TestRuntime } from './shell-runtime.js';

const temps: string[] = [];
const runtimes: TestRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.cleanup();
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
});

describe('T5 steer 纯函数', () => {
  it('buildSteerRequest：turnId 缺失/空 → null（调用方保草稿报 unknown）；空白文本 → null', () => {
    expect(buildSteerRequest(undefined, 'id-1', 'hello')).toBeNull();
    expect(buildSteerRequest('', 'id-1', 'hello')).toBeNull();
    expect(buildSteerRequest('turn-1', 'id-1', '   ')).toBeNull();
    expect(buildSteerRequest('turn-1', 'id-1', 'hello')).toEqual({
      id: 'id-1',
      expectedTurnId: 'turn-1',
      text: 'hello',
    });
  });

  it('makeSteerId：同一时刻不同序号唯一', () => {
    expect(makeSteerId(1, 1000)).toBe('cli-steer-1000-1');
    expect(makeSteerId(2, 1000)).not.toBe(makeSteerId(1, 1000));
  });

  it('describeSteerResult：stale 必须体现「草稿已保留」', () => {
    const stale = describeSteerResult({ id: 's', expectedTurnId: 't', state: 'stale', draftKept: true } as SteerResult);
    expect(stale.draftKept).toBe(true);
    expect(stale.line).toContain('草稿已保留');
    const accepted = describeSteerResult({ id: 's', expectedTurnId: 't', state: 'accepted' });
    expect(accepted.draftKept).toBe(false);
    expect(accepted.line).toContain('已接受');
    const rejected = describeSteerResult({ id: 's', expectedTurnId: 't', state: 'rejected' });
    expect(rejected.line).toContain('拒绝');
  });
});

describe('T5 CliSteerSink：入队/去重/回帧', () => {
  it('同 id 重复提交 → 第二次 push false 且立刻 rejected 回帧（不占队位、不双注入）', () => {
    const sink = new CliSteerSink();
    const seen: SteerResult[] = [];
    const un = sink.observe({ onSteerResult: (r) => seen.push(r) });
    const req = { id: 'dup-1', expectedTurnId: 'turn-1', text: 'x' };
    expect(sink.push(req)).toBe(true);
    expect(sink.push(req)).toBe(false);
    expect(sink.size).toBe(1); // 重复未入队
    expect(seen).toContainEqual({ id: 'dup-1', expectedTurnId: 'turn-1', state: 'rejected' });
    un();
    sink.resolve({ id: 'dup-1', expectedTurnId: 'turn-1', state: 'accepted' });
    expect(seen).toHaveLength(1); // 退订后不再收到
  });

  it('take 按 FIFO 出队；resolve 记录 history', () => {
    const sink = new CliSteerSink();
    sink.push({ id: 'a', expectedTurnId: 't', text: '1' });
    sink.push({ id: 'b', expectedTurnId: 't', text: '2' });
    expect(sink.take()?.id).toBe('a');
    expect(sink.take()?.id).toBe('b');
    expect(sink.take()).toBeUndefined();
    sink.resolve({ id: 'a', expectedTurnId: 't', state: 'accepted' });
    expect(sink.history()).toEqual([{ id: 'a', expectedTurnId: 't', state: 'accepted' }]);
  });
});

/** 可捕获请求的 provider 测试替身（Provider 缝本就是注入点：真实 runTurn + 受控流） */
class ScriptedProvider implements ChatProvider {
  readonly name = 'scripted';
  readonly requests: ChatRequest[] = [];
  constructor(private readonly script: StreamChunk[][]) {}
  async *streamChat(req: ChatRequest): AsyncIterable<StreamChunk> {
    this.requests.push(req);
    const step = this.script[Math.min(this.requests.length - 1, this.script.length - 1)] ?? [];
    for (const chunk of step) yield chunk;
  }
}

function newSession(): { dir: string; root: string; writer: SessionWriter } {
  const base = mkdtempSync(join(tmpdir(), 'h2-steer-'));
  temps.push(base);
  const dir = join(base, 's1');
  const writer = SessionWriter.create(dir, { sessionId: 's1', cwd: base }, { fsync: false });
  return { dir, root: base, writer };
}

function echoTools(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: 'echo',
    description: 'echo (test)',
    parameters: { type: 'object', properties: {} },
    concurrencySafe: true,
    cancelGuaranteed: true,
    execute: () => ({ output: 'ok' }),
  });
  return tools;
}

/** step1 工具调用（非终态）→ step2 文本收尾：steer 在 step1 边界可被接受 */
const TWO_STEP_SCRIPT: StreamChunk[][] = [
  [
    { type: 'tool-call', call: { id: 'c1', name: 'echo', arguments: '{}' } },
    { type: 'done', stopReason: 'tool_use' },
  ],
  [
    { type: 'text-delta', text: '完成' },
    { type: 'done', stopReason: 'end_turn' },
  ],
];

describe('T5 steer 与真实 core loop 联调（in-process）', () => {
  it('安全 step 边界 accepted：控制文本进入下一 step 请求，且不写入会话投影正文', async () => {
    const { dir, root, writer } = newSession();
    const provider = new ScriptedProvider(TWO_STEP_SCRIPT);
    const sink = new CliSteerSink();
    const seen: SteerResult[] = [];
    sink.observe({ onSteerResult: (r) => seen.push(r) });
    let pushed = false;
    const result = await runTurn(writer, {
      provider,
      tools: echoTools(),
      cwd: root,
      userText: 'hi',
      steer: sink,
      onStream: (e) => {
        if (e.type === 'tool-call' && !pushed) {
          pushed = true;
          sink.push({ id: 'steer-ok', expectedTurnId: e.turnId, text: 'CTRL_TEXT' });
        }
      },
    });
    expect(result.stopReason).toBe('end_turn');
    expect(seen).toContainEqual(expect.objectContaining({ id: 'steer-ok', state: 'accepted' }));
    expect(provider.requests.length).toBeGreaterThanOrEqual(2);
    const second = provider.requests[1];
    expect(second?.messages.some((m) => m.role === 'user' && m.content === 'CTRL_TEXT')).toBe(true);
    // steer 是控制输入：不写日志、不进投影正文
    const projection = computeProjection(loadSession(dir));
    expect(projection.messages.some((m) => m.text.includes('CTRL_TEXT'))).toBe(false);
    writer.close();
  });

  it('expectedTurnId 不符 → stale + draftKept（不应用、不中断 turn）', async () => {
    const { root, writer } = newSession();
    const provider = new ScriptedProvider(TWO_STEP_SCRIPT);
    const sink = new CliSteerSink();
    const seen: SteerResult[] = [];
    sink.observe({ onSteerResult: (r) => seen.push(r) });
    let pushed = false;
    const result = await runTurn(writer, {
      provider,
      tools: echoTools(),
      cwd: root,
      userText: 'hi',
      steer: sink,
      onStream: (e) => {
        if (e.type === 'tool-call' && !pushed) {
          pushed = true;
          sink.push({ id: 'steer-stale', expectedTurnId: 'not-this-turn', text: 'STALE_TEXT' });
        }
      },
    });
    expect(result.stopReason).toBe('end_turn');
    expect(seen).toContainEqual(expect.objectContaining({ id: 'steer-stale', state: 'stale', draftKept: true }));
    const second = provider.requests[1];
    expect(second?.messages.some((m) => m.content === 'STALE_TEXT')).toBe(false);
    writer.close();
  });
});

describe('T5 ChatRuntime steer 提交（turnId 作用域）', () => {
  it('无活动 turn → unknown 且要求保草稿（不猜测 turnId）', async () => {
    const tr = await createTestRuntime();
    runtimes.push(tr);
    expect(tr.runtime.currentTurnId()).toBeUndefined();
    const out = tr.runtime.submitSteer('草稿内容');
    expect(out.state).toBe('unknown');
    if (out.state === 'unknown') expect(out.draftKept).toBe(true);
  });

  it('mock 真实 turn 内提交 → 观察者收到 accepted（step1 工具边界）', async () => {
    const tr = await createTestRuntime(MOCK_DEMO_SCRIPT);
    runtimes.push(tr);
    const seen: SteerResult[] = [];
    const un = tr.runtime.observeSteer((r) => seen.push(r));
    let submitState: string | undefined;
    await tr.runtime.runUserTurn('hi', (e) => {
      if (e.type === 'tool-call' && submitState === undefined) {
        const out = tr.runtime.submitSteer('请换个做法');
        submitState = out.state;
      }
    });
    un();
    expect(submitState).toBe('submitted');
    expect(seen.some((r) => r.state === 'accepted')).toBe(true);
    // turn 结束后 turnId 清空：后续 steer 不再挂到刚结束的 turn
    expect(tr.runtime.currentTurnId()).toBeUndefined();
    expect(tr.runtime.submitSteer('after')).toMatchObject({ state: 'unknown', draftKept: true });
  });
});
