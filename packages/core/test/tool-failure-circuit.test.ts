// A1-3 验收测试：连续工具失败熔断（stopReason='tool_failures' + 非空 finalText，禁止空回复）。
// 全 mock，零 API key、零网络。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTurn } from '../src/agent/loop.js';
import { MockProvider } from '../src/provider/mock.js';
import { SESSION_LOG_FILE, type AnySessionEvent } from '../src/session/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-circuit-'));
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

function tool(name: string, execute: ToolDefinition['execute']): ToolDefinition {
  return { name, description: `${name} test tool`, parameters: { type: 'object', properties: {} }, execute };
}

/** 连续 n 次调用指定工具的脚本（每次回复无文本，只有工具调用） */
function calls(
  name: string,
  n: number,
): Array<{ text: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }> {
  return Array.from({ length: n }, (_, i) => ({
    text: '',
    toolCalls: [{ id: `c-${i}`, name, arguments: '{}' }],
  }));
}

describe('A1-3 连续工具失败熔断', () => {
  it('连续 5 次工具失败 → stopReason=tool_failures + 非空 finalText（且落盘为 assistant/message）', async () => {
    const dir = tmpDir();
    const provider = new MockProvider(calls('always_fail', 10));
    const registry = new ToolRegistry();
    registry.register(tool('always_fail', async () => ({ error: 'boom: 命令不存在' })));

    const result = await runTurn(dir, { provider, tools: registry, cwd: dir, userText: '查新闻' });

    expect(result.stopReason).toBe('tool_failures');
    expect(result.steps).toBe(5); // 第 5 次连续失败即熔断，不再烧到 maxSteps=25
    expect(result.finalText).toBeDefined();
    expect(result.finalText!.length).toBeGreaterThan(0);
    expect(result.finalText).toContain('连续 5 次工具调用失败');
    expect(result.finalText).toContain('always_fail');
    expect(result.finalText).toContain('boom: 命令不存在');
    expect(provider.consumed).toBe(5);

    // 非空回复必须对用户可见：以 assistant/message 落盘（desktop 事件投影 + CLI 流式都读它）
    const events = loadEvents(dir);
    const assistantTexts = events
      .filter((e): e is Extract<AnySessionEvent, { type: 'assistant/message' }> => e.type === 'assistant/message')
      .map((e) => e.payload.text)
      .filter((t) => t.length > 0);
    expect(assistantTexts).toContain(result.finalText);
    expect(events.at(-1)?.type).toBe('step/end'); // 日志无悬挂
  });

  it('阈值可配置：maxConsecutiveToolFailures=2 时第 2 次连续失败即熔断', async () => {
    const dir = tmpDir();
    const provider = new MockProvider(calls('always_fail', 5));
    const registry = new ToolRegistry();
    registry.register(tool('always_fail', async () => ({ error: 'nope' })));

    const result = await runTurn(dir, {
      provider,
      tools: registry,
      cwd: dir,
      userText: 'x',
      maxConsecutiveToolFailures: 2,
    });
    expect(result.stopReason).toBe('tool_failures');
    expect(result.steps).toBe(2);
    expect(result.finalText).toContain('阈值 2');
  });

  it('一次成功即重置计数：失败/成功交替不会误触熔断', async () => {
    const dir = tmpDir();
    const provider = new MockProvider([
      ...calls('always_fail', 1),
      ...calls('always_ok', 1),
      ...calls('always_fail', 1),
      ...calls('always_ok', 1),
      { text: '查询完成，共 3 条要闻。' },
    ]);
    const registry = new ToolRegistry();
    registry.register(tool('always_fail', async () => ({ error: 'transient' })));
    registry.register(tool('always_ok', async () => ({ output: 'ok' })));

    const result = await runTurn(dir, {
      provider,
      tools: registry,
      cwd: dir,
      userText: 'x',
      maxConsecutiveToolFailures: 2,
    });
    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(5);
    expect(result.finalText).toBe('查询完成，共 3 条要闻。');
  });

  it('阈值 0 = 关闭熔断（只受 maxSteps 约束，兼容旧行为）', async () => {
    const dir = tmpDir();
    const provider = new MockProvider(calls('always_fail', 10));
    const registry = new ToolRegistry();
    registry.register(tool('always_fail', async () => ({ error: 'nope' })));

    const result = await runTurn(dir, {
      provider,
      tools: registry,
      cwd: dir,
      userText: 'x',
      maxSteps: 3,
      maxConsecutiveToolFailures: 0,
    });
    expect(result.stopReason).toBe('max_steps');
    expect(result.steps).toBe(3);
  });
});
