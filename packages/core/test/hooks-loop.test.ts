// A09 Hooks loop 集成测试：preTool 拦截/改写输入、postTool 回注（Model-visible ⟺ logged）、
// turnEnd / sessionStart / sessionEnd 触发，以及 hook/invocation 扩展事件写→读→重放。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../src/provider/mock.js';
import { runTurn } from '../src/agent/loop.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { exportAllEvents, loadSession } from '../src/session/reader.js';
import { createHookRunner } from '../src/hooks/runner.js';
import { HOOK_INVOCATION_EVENT_TYPE, readHookInvocations } from '../src/hooks/extension.js';
import type { HookSpawnHook, HookSpawnResult } from '../src/hooks/executor.js';
import type { HooksConfig } from '../src/config/schema.js';
import type { ToolDefinition } from '../src/tools/types.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-hooks-loop-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function cfg(entries: HooksConfig['entries']): HooksConfig {
  return { enabled: true, timeoutMs: 30_000, maxOutputBytes: 32_768, entries };
}

function spawnReturning(map: Record<string, Partial<HookSpawnResult>>): HookSpawnHook {
  return async (input) => {
    const match = Object.entries(map).find(([cmd]) => input.command.includes(cmd));
    const result = match?.[1] ?? {};
    return { status: 'completed', exitCode: 0, stdout: '', stderr: '', ...result };
  };
}

function makeTool(name: string, execute: ToolDefinition['execute']): ToolDefinition {
  return { name, description: `${name} tool`, parameters: { type: 'object', properties: {} }, execute };
}

describe('preTool 拦截语义（对齐 ZCode：可阻止执行 / 改写输入）', () => {
  it('continue:false → 工具不执行，以 ok:false 的 tool/result 落盘（模型可见）', async () => {
    const dir = tmpDir();
    const execute = vi.fn(() => ({ output: 'should-not-run' }));
    const registry = new ToolRegistry();
    registry.register(makeTool('bash', execute));
    const provider = new MockProvider([
      { text: 'run', toolCalls: [{ id: 'c1', name: 'bash', arguments: '{"command":"rm -rf /"}' }] },
      { text: '好' },
    ]);
    const hooks = createHookRunner({
      config: cfg([{ event: 'preTool', matcher: 'bash', command: 'guard' }]),
      spawnHook: spawnReturning({ guard: { stdout: '{"continue":false,"reason":"危险命令"}' } }),
    });

    const result = await runTurn(dir, { provider, tools: registry, cwd: dir, userText: '删库', hooks });
    expect(result.stopReason).toBe('end_turn');
    expect(execute).not.toHaveBeenCalled();

    const session = loadSession(dir);
    const tr = session.events.find((x) => x.event.type === 'tool/result')?.event;
    expect(tr && tr.type === 'tool/result' ? tr.payload : null).toMatchObject({ ok: false });
    expect(tr && tr.type === 'tool/result' ? tr.payload.error : '').toContain('已由钩子阻止：危险命令');
    // 第二请求里该 tool 消息带阻断原因（模型确实看得到）
    const secondReq = provider.requests[1]!;
    expect(JSON.stringify(secondReq.messages)).toContain('已由钩子阻止：危险命令');
  });

  it('updatedInput → 工具以改写后的入参执行', async () => {
    const dir = tmpDir();
    const seen: unknown[] = [];
    const registry = new ToolRegistry();
    registry.register(
      makeTool('bash', (args) => {
        seen.push(args);
        return { output: 'ok' };
      }),
    );
    const provider = new MockProvider([
      { text: 'run', toolCalls: [{ id: 'c1', name: 'bash', arguments: '{"command":"rm -rf /"}' }] },
      { text: 'done' },
    ]);
    const hooks = createHookRunner({
      config: cfg([{ event: 'preTool', matcher: 'bash', command: 'rewrite' }]),
      spawnHook: spawnReturning({ rewrite: { stdout: '{"updatedInput":{"command":"echo safe"}}' } }),
    });

    await runTurn(dir, { provider, tools: registry, cwd: dir, userText: 'x', hooks });
    expect(seen).toEqual([{ command: 'echo safe' }]);
  });
});

describe('postTool 回注（结果文本随事件落盘，可从日志重建）', () => {
  it('additionalContext 追加进 tool/result.output', async () => {
    const dir = tmpDir();
    const registry = new ToolRegistry();
    registry.register(makeTool('bash', () => ({ output: 'real-output' })));
    const provider = new MockProvider([
      { text: 'run', toolCalls: [{ id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }] },
      { text: 'done' },
    ]);
    const hooks = createHookRunner({
      config: cfg([{ event: 'postTool', matcher: 'bash', command: 'ctx' }]),
      spawnHook: spawnReturning({ ctx: { stdout: '{"additionalContext":"记得提交"}' } }),
    });

    await runTurn(dir, { provider, tools: registry, cwd: dir, userText: 'x', hooks });
    const session = loadSession(dir);
    const tr = session.events.find((x) => x.event.type === 'tool/result')?.event;
    const payload = tr && tr.type === 'tool/result' ? tr.payload : null;
    expect(payload?.output).toBe('real-output\n[Hook additional context]\n#1\n记得提交');
    // Model-visible ⟺ logged：第二请求的 tool 消息含回注文本
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain('记得提交');
  });

  it('失败结果的回注进 error 字段', async () => {
    const dir = tmpDir();
    const registry = new ToolRegistry();
    registry.register(makeTool('bash', () => ({ error: 'boom' })));
    const provider = new MockProvider([
      { text: 'run', toolCalls: [{ id: 'c1', name: 'bash', arguments: '{"command":"x"}' }] },
      { text: 'done' },
    ]);
    const hooks = createHookRunner({
      config: cfg([{ event: 'postTool', matcher: 'bash', command: 'ctx' }]),
      spawnHook: spawnReturning({ ctx: { stdout: '{"additionalContext":"补丁提示"}' } }),
    });
    await runTurn(dir, { provider, tools: registry, cwd: dir, userText: 'x', hooks });
    const session = loadSession(dir);
    const tr = session.events.find((x) => x.event.type === 'tool/result')?.event;
    const payload = tr && tr.type === 'tool/result' ? tr.payload : null;
    expect(payload?.ok).toBe(false);
    expect(payload?.error).toContain('boom');
    expect(payload?.error).toContain('补丁提示');
  });
});

describe('turnEnd / sessionStart / sessionEnd 触发 + hook/invocation 扩展事件', () => {
  it('新会话：sessionStart → … → turnEnd → sessionEnd 全部落 hook/invocation（写→读→重放）', async () => {
    const dir = tmpDir();
    const turns: string[] = [];
    const hooks = createHookRunner({
      config: cfg([
        { event: 'sessionStart', command: 'h-session-start' },
        { event: 'turnEnd', command: 'h-turn-end' },
        { event: 'sessionEnd', command: 'h-session-end' },
      ]),
      spawnHook: async (input) => {
        turns.push(input.command);
        return { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const provider = new MockProvider([{ text: '你好' }]);
    await runTurn(dir, { provider, tools: new ToolRegistry(), cwd: dir, userText: 'hi', hooks });

    expect(turns).toEqual(['h-session-start', 'h-turn-end', 'h-session-end']);

    const session = loadSession(dir);
    const invocations = readHookInvocations(session.extensionEvents);
    expect(invocations.map((i) => i.payload.event)).toEqual(['sessionStart', 'turnEnd', 'sessionEnd']);
    expect(invocations[0]!.payload.outcome).toBe('success');
    // 扩展事件类型已注册 + 解析（writer 接受 → loadSession 读回）
    expect(session.extensionEvents.every((e) => e.event.type === HOOK_INVOCATION_EVENT_TYPE)).toBe(true);
    // 重放/导出含扩展事件行
    expect(exportAllEvents(session)).toContain(HOOK_INVOCATION_EVENT_TYPE);
  });

  it('复用已存在会话：不再触发 sessionStart（仅 turnEnd/sessionEnd 边界）', async () => {
    const dir = tmpDir();
    // 先跑一次建立会话
    await runTurn(dir, {
      provider: new MockProvider([{ text: '1' }]),
      tools: new ToolRegistry(),
      cwd: dir,
      userText: 'a',
    });
    const turns: string[] = [];
    const hooks = createHookRunner({
      config: cfg([
        { event: 'sessionStart', command: 'h-session-start' },
        { event: 'sessionEnd', command: 'h-session-end' },
      ]),
      spawnHook: async (input) => {
        turns.push(input.command);
        return { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
      },
    });
    await runTurn(dir, {
      provider: new MockProvider([{ text: '2' }]),
      tools: new ToolRegistry(),
      cwd: dir,
      userText: 'b',
      hooks,
    });
    expect(turns).toEqual(['h-session-end']); // 无 sessionStart
  });

  it('未配置 hooks → 会话无任何 hook/invocation 事件（零回归）', async () => {
    const dir = tmpDir();
    await runTurn(dir, {
      provider: new MockProvider([{ text: 'hi' }]),
      tools: new ToolRegistry(),
      cwd: dir,
      userText: 'x',
    });
    const session = loadSession(dir);
    expect(readHookInvocations(session.extensionEvents)).toEqual([]);
  });
});
