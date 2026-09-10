// S4b 有界 attempt 重试接线测试：把 retry-policy 纯策略接进 provider + loop。
// 覆盖（brief §行为或契约）：429 退避档重试 / 401 不重试 / EOF·stream_truncated 重试 /
// 半截工具调用不执行 / 重试不重跑已完成工具 / per-turn cap 6 停 / 累计 120s 停 /
// abort 中断等待 / finalText 空有结构化结果 / provider 错误码归一 + Retry-After 透传。
// 全部经 MockProvider 精准断流（按 token/工具边界回错误码），不触真实模型。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../src/provider/mock.js';
import { runTurn } from '../src/agent/loop.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SESSION_LOG_FILE, type AnySessionEvent } from '../src/session/types.js';
import { RETRY_MAX_EXTRA_PER_TURN, RETRY_MAX_TOTAL_WAIT_SECONDS } from '../src/interaction/types.js';
import type { ToolDefinition } from '../src/tools/types.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-attempt-wire-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function loadEvents(dir: string): AnySessionEvent[] {
  return readFileSync(join(dir, SESSION_LOG_FILE), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AnySessionEvent);
}
const attemptsOf = (dir: string) => loadEvents(dir).filter((e) => e.type === 'assistant/attempt');

function makeTool(name: string, execute: ToolDefinition['execute']): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: {} },
    execute,
  };
}

/** 推进 fake 时钟直到 turn 结算（防真实 120s 等待；stepMs 每次推进量） */
async function flushUntilPending(p: Promise<unknown>, stepMs = 500, maxMs = 400_000): Promise<void> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  let waited = 0;
  while (!settled && waited < maxMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
    waited += stepMs;
  }
}

describe('provider 错误码归一 + Retry-After 透传（S4b 接线）', () => {
  it('429 有界重试：退避档 2/10/30，第三次后成功；assistant/attempt 追加记录、新 attempt 从零文本', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 无抖动 → 精确档位 2/10/30
    const dir = tmpDir();
    const provider = new MockProvider([{ error: 429 }, { error: 429 }, { error: 429 }, { text: '成功' }]);
    const pending = runTurn(dir, { provider, tools: new ToolRegistry(), cwd: dir, userText: 'hi' });
    await flushUntilPending(pending);
    const result = await pending;

    expect(result.stopReason).toBe('end_turn');
    expect(result.finalText).toBe('成功');
    // 1 初始 + 3 额外重试 = 4 次 streamChat
    expect(provider.consumed).toBe(4);
    // 3 条失败 attempt（append-only），末尾成功落 assistant/message
    expect(attemptsOf(dir)).toHaveLength(3);
    const types = loadEvents(dir).map((e) => e.type);
    expect(types.filter((t) => t === 'assistant/attempt')).toHaveLength(3);
    expect(types.filter((t) => t === 'assistant/message')).toHaveLength(1);
    expect(types.at(-1)).toBe('step/end');
  });

  it('401 直接不重试：单次 attempt、一次记录、error 结束', async () => {
    const dir = tmpDir();
    const provider = new MockProvider([{ error: 401 }]);
    const result = await runTurn(dir, { provider, tools: new ToolRegistry(), cwd: dir, userText: 'hi' });

    expect(result.stopReason).toBe('error');
    expect(result.error).toContain('401');
    expect(provider.consumed).toBe(1); // 未重试
    expect(attemptsOf(dir)).toHaveLength(1);
  });

  it('Retry-After 透传：provider 抛 429 携带 retry-after，loop 按 Retry-After 等待重试', async () => {
    vi.useFakeTimers();
    const dir = tmpDir();
    // 0.1s Retry-After → 快速重试成功
    const provider = new MockProvider([{ error: 429, retryAfterSeconds: 0.1 }, { text: '重试成功' }]);
    const pending = runTurn(dir, { provider, tools: new ToolRegistry(), cwd: dir, userText: 'hi' });
    await flushUntilPending(pending);
    const result = await pending;

    expect(result.stopReason).toBe('end_turn');
    expect(result.finalText).toBe('重试成功');
    expect(provider.consumed).toBe(2);
  });
});

describe('EOF / stream_truncated 重试', () => {
  it('stream_truncated（首 token 前断流）→ 重试成功；失败 attempt text 未合并进新 attempt', async () => {
    vi.useFakeTimers();
    const dir = tmpDir();
    // 半截文本 + 断流 → 重试成功；finalText 必须是新 attempt 全文，不续拼旧半句
    const provider = new MockProvider([
      { textChunks: ['半截'], truncateAfter: true, retryAfterSeconds: 0.01 },
      { text: '新半句' },
    ]);
    const pending = runTurn(dir, { provider, tools: new ToolRegistry(), cwd: dir, userText: 'hi' });
    await flushUntilPending(pending);
    const result = await pending;

    expect(result.stopReason).toBe('end_turn');
    expect(result.finalText).toBe('新半句'); // 绝不「半截新半句」
    expect(provider.consumed).toBe(2);
    // 失败 attempt 保留半截 text（可展开）
    const attempt = attemptsOf(dir)[0];
    expect(attempt && attempt.type === 'assistant/attempt' ? attempt.payload.text : null).toBe('半截');
    // 成功 attempt 才落 assistant/message
    const msgs = loadEvents(dir).filter((e) => e.type === 'assistant/message');
    expect(msgs).toHaveLength(1);
    expect(msgs[0] && msgs[0].type === 'assistant/message' ? (msgs[0].payload as { text: string }).text : null).toBe(
      '新半句',
    );
  });

  it('stream_truncated 超预算：一直断流，per-turn cap 6 次额外后停止并告知（不重试第 7 次）', async () => {
    vi.useFakeTimers();
    const dir = tmpDir();
    // 每次失败携带微小 Retry-After（wait 预算不先耗尽，纯按次数 cap=6）
    const script = Array.from({ length: RETRY_MAX_EXTRA_PER_TURN + 1 }, () => ({
      error: 'stream_truncated',
      retryAfterSeconds: 0.01,
    }));
    const provider = new MockProvider(script as never[]);
    const pending = runTurn(dir, { provider, tools: new ToolRegistry(), cwd: dir, userText: 'hi' });
    await flushUntilPending(pending);
    const result = await pending;

    expect(result.stopReason).toBe('error');
    // 1 初始 + 6 额外 = 7 次尝试后停止
    expect(provider.consumed).toBe(RETRY_MAX_EXTRA_PER_TURN + 1);
    expect(result.error).toContain('重试预算已耗尽');
    // 7 条失败 attempt 全部 append（不静默）
    expect(attemptsOf(dir)).toHaveLength(RETRY_MAX_EXTRA_PER_TURN + 1);
  });

  it('累计等待 120s 停：Retry-After 叠满预算后第 3 次失败即停（次数未满也停）', async () => {
    vi.useFakeTimers();
    const dir = tmpDir();
    // 每次 Retry-After 60s：两次等待 = 120s，第三次失败时 wait 预算耗尽 → 停止
    const provider = new MockProvider([
      { error: 429, retryAfterSeconds: 60 },
      { error: 429, retryAfterSeconds: 60 },
      { error: 429, retryAfterSeconds: 60 },
    ]);
    const pending = runTurn(dir, { provider, tools: new ToolRegistry(), cwd: dir, userText: 'hi' });
    await flushUntilPending(pending, 50, 200_000);
    const result = await pending;

    expect(result.stopReason).toBe('error');
    expect(provider.consumed).toBe(3); // 只尝试 3 次（次数 cap=6 未满，但 120s 等待预算先耗尽）
    // 累计 120s 预算耗尽 → 明确停因（含 120s 数字），不静默、不违规重试
    expect(result.error).toContain('重试预算已耗尽');
    expect(result.error).toContain(String(RETRY_MAX_TOTAL_WAIT_SECONDS));
  });
});

describe('半截工具调用不执行 / 已完成工具不重跑', () => {
  it('半截工具调用不执行：断流 attempt 已产 tool-call 候选但不落计划，重试后不执行该半截工具', async () => {
    vi.useFakeTimers();
    const dir = tmpDir();
    let executed = 0;
    const registry = new ToolRegistry();
    registry.register(
      makeTool('t', () => {
        executed += 1;
        return { output: 'done' };
      }),
    );
    // attempt1：产出一个 tool-call 候选后断流（半截，未完成 → 不允许执行）
    // attempt2：纯文本收尾（不再调工具）
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 't', arguments: '{}' }], truncateAfter: true, retryAfterSeconds: 0.01 },
      { text: '收尾' },
    ]);
    const pending = runTurn(dir, { provider, tools: registry, cwd: dir, userText: 'go' });
    await flushUntilPending(pending);
    const result = await pending;

    expect(result.stopReason).toBe('end_turn');
    // 半截 attempt 的 tool-call 未执行（executed 仍 0）
    expect(executed).toBe(0);
    expect(result.toolCalls).toBe(0);
    // 未提交工具计划：没有 tool/call、没有 tool/result
    const evt = loadEvents(dir);
    expect(evt.some((e) => e.type === 'tool/call')).toBe(false);
    expect(evt.some((e) => e.type === 'tool/result')).toBe(false);
    // 失败 attempt 独立记录
    expect(attemptsOf(dir)).toHaveLength(1);
    expect(provider.consumed).toBe(2);
  });

  it('重试不重跑已完成工具：step1 工具已执行并落盘，step2 断流重试基于同一投影，工具不二次执行', async () => {
    vi.useFakeTimers();
    const dir = tmpDir();
    let executed = 0;
    const registry = new ToolRegistry();
    registry.register(
      makeTool('t', () => {
        executed += 1;
        return { output: 'done' };
      }),
    );
    const provider = new MockProvider([
      { text: '第一步', toolCalls: [{ id: 'c1', name: 't', arguments: '{}' }] },
      { text: '半截', truncateAfter: true, retryAfterSeconds: 0.01 },
      { text: '第二步' },
    ]);
    const pending = runTurn(dir, { provider, tools: registry, cwd: dir, userText: 'go' });
    await flushUntilPending(pending);
    const result = await pending;

    expect(result.stopReason).toBe('end_turn');
    // 只有 step1 执行了工具一次；step2 断流重试不重跑
    expect(executed).toBe(1);
    expect(result.toolCalls).toBe(1);
    expect(provider.consumed).toBe(3); // step1 + step2(attempt1) + step2(attempt2)
    const evt = loadEvents(dir);
    expect(evt.filter((e) => e.type === 'tool/result')).toHaveLength(1);
    // step2 的两个 attempt 基于同一投影（均含 step1 的 tool result），不变量保持
    const step2Attempt1 = provider.requests[1];
    const step2Attempt2 = provider.requests[2];
    const toolMsgs = (r: unknown) =>
      (r as { messages: Array<{ role: string }> }).messages.filter((m) => m.role === 'tool');
    expect(toolMsgs(step2Attempt1)).toHaveLength(1);
    expect(toolMsgs(step2Attempt2)).toHaveLength(1);
    expect(toolMsgs(step2Attempt1)).toEqual(toolMsgs(step2Attempt2));
  });
});

describe('abort 中断重试等待 / finalText 空有结构化结果', () => {
  it('abort 中断等待：重试退避中取消 → RetryAbortError → cancelled，不续试', async () => {
    vi.useFakeTimers();
    const dir = tmpDir();
    const ac = new AbortController();
    const provider = new MockProvider([{ error: 429, retryAfterSeconds: 30 }, { text: '不该发生' }]);
    const pending = runTurn(dir, {
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: 'hi',
      signal: ac.signal,
    });
    // 推进到首错发生并进入 30s 等待（但未到 30s）
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(100);
    ac.abort(); // 等待中被取消
    await flushUntilPending(pending);
    const result = await pending;

    expect(result.stopReason).toBe('cancelled');
    expect(provider.consumed).toBe(1); // 未重试（等待即取消）
    // 无 assistant/message 冒充完整
    expect(loadEvents(dir).some((e) => e.type === 'assistant/message')).toBe(false);
    // 两条 attempt：失败的 429 尝试 + 等待取消的 cancelled 尝试（末尾为取消记录）
    const attempts = attemptsOf(dir);
    expect(attempts).toHaveLength(2);
    expect(attempts[0] && attempts[0].type === 'assistant/attempt' ? attempts[0].payload.error : '').toBe('429');
    expect(attempts[1] && attempts[1].type === 'assistant/attempt' ? attempts[1].payload.error : '').toContain(
      'cancelled',
    );
    expect(loadEvents(dir).at(-1)?.type).toBe('step/end');
  });

  it('finalText 空但有结构化结果：max_steps 到达 → 返回 max_steps（不静默、无 finalText 断言不炸）', async () => {
    const dir = tmpDir();
    const registry = new ToolRegistry();
    registry.register(makeTool('noop', () => ({ output: 'ok' })));
    // 3 步纯工具调用（无文本）→ maxSteps 2 触发 max_steps
    const reply = () => ({ toolCalls: [{ id: `c-${Math.random()}`, name: 'noop', arguments: '{}' }] });
    const provider = new MockProvider([reply(), reply(), reply()]);
    const result = await runTurn(dir, { provider, tools: registry, cwd: dir, userText: '循环', maxSteps: 2 });

    expect(result.stopReason).toBe('max_steps');
    expect(result.steps).toBe(2);
    // finalText 缺省（无文本）也能返回结构化结果
    expect(result.finalText).toBeUndefined();
    expect(result.toolCalls).toBe(2);
    expect(loadEvents(dir).at(-1)?.type).toBe('step/end');
  });
});

describe('整 turn 预算跨 step 累计（S4a review：record 不 clamp，仍被闸守住）', () => {
  it('两次 step 各断流一次：预算累计 2 次仍 < cap 6，正常重试完成', async () => {
    vi.useFakeTimers();
    const dir = tmpDir();
    const registry = new ToolRegistry();
    registry.register(makeTool('t', () => ({ output: 'done' })));
    // step1：断流重试后执行工具；step2：断流重试后纯文本收尾 → 全程 2 条失败 attempt
    const provider = new MockProvider([
      { text: '半截1', truncateAfter: true, retryAfterSeconds: 0.01 },
      { text: 'a', toolCalls: [{ id: 'c1', name: 't', arguments: '{}' }] },
      { text: '半截2', truncateAfter: true, retryAfterSeconds: 0.01 },
      { text: 'b' },
    ]);
    const pending = runTurn(dir, { provider, tools: registry, cwd: dir, userText: 'go' });
    await flushUntilPending(pending);
    const result = await pending;

    expect(result.stopReason).toBe('end_turn');
    expect(provider.consumed).toBe(4); // 每 step 各 2 次 attempt
    // 两次 step 各留 1 条失败 attempt（预算累计 2 < 6）
    expect(attemptsOf(dir)).toHaveLength(2);
    expect(result.toolCalls).toBe(1);
  });

  it('S4a 冻结数字自洽仍成立（接线层不改变策略常量）', () => {
    expect(RETRY_MAX_EXTRA_PER_TURN).toBe(6);
    expect(RETRY_MAX_TOTAL_WAIT_SECONDS).toBe(120);
  });
});
