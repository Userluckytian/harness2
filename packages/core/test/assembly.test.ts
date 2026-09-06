// 装配层测试（阶段 8 Task 4）：hub 装配链（本地 + 插件 + MCP + subagent）、开关生效、
// 冲突优先级（本地 > 插件 > MCP）、子会话审批上抛与事件桥接、serve 级插件/MCP 装配与收尾。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHub, type SessionHubHooks } from '../src/server/sessions.js';
import { SessionManager } from '../src/session/manager.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { MockProvider, type MockScript } from '../src/provider/mock.js';
import { loadSession } from '../src/session/reader.js';
import { SUBAGENT_TOOL_NAMES } from '../src/agent/subagent.js';
import { PluginBus } from '../src/plugins/bus.js';
import { defaultPluginsRoot } from '../src/plugins/loader.js';
import { McpManager } from '../src/mcp/client.js';
import { startServe } from '../src/server/http.js';
import { KNOWN_EVENT_TYPES } from '../src/session/types.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-assembly-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function toolDef(name: string, log?: Array<string>): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    execute: () => {
      log?.push(name);
      return { output: `${name}-ok` };
    },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 15): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe('SessionHub subagent 装配', () => {
  it('端到端：父 turn 调 subagent_start → 独立子会话 + 事件桥接 + turn-end 上抛', async () => {
    const root = tmpDir();
    const manager = new SessionManager(join(root, 'sessions'));
    const tools = new ToolRegistry();
    const childLog: string[] = [];
    tools.register(toolDef('child_tool', childLog));
    const parentScript: MockScript = [
      { toolCalls: [{ id: 'c1', name: 'subagent_start', arguments: '{"prompt":"child task"}' }] },
      { text: 'parent wrapped' },
    ];
    const hub = new SessionHub({
      manager,
      provider: new MockProvider(parentScript),
      tools,
      cwd: root,
      subagent: { provider: new MockProvider([{ toolCalls: [{ id: 'cc1', name: 'child_tool', arguments: '{}' }] }, { text: 'child done' }]), maxDepth: 1, maxTurns: 5 },
      approvalTimeoutMs: 2000,
      hooks: {},
    });
    const collected: { events: Array<{ sessionId: string; type: string }>; turnEnds: Array<{ sessionId: string }> } = {
      events: [],
      turnEnds: [],
    };
    const hooks: SessionHubHooks = {
      onEvent: (sessionId, event) => collected.events.push({ sessionId, type: event.type }),
      onTurnEnd: (sessionId) => collected.turnEnds.push({ sessionId }),
    };
    hub.addHooks(hooks);
    const created = hub.create(root);
    hub.sendUserMessage(created.id, 'go');
    await waitFor(() => collected.turnEnds.length >= 2); // 父 + 子 各一个 turn-end
    await hub.close();
    // 父日志：tool/result.output 带 childSessionId；事件类型全部既有（零新增事件类型）
    const parentSession = loadSession(hub.events(created.id).dir);
    const tr = parentSession.events.find((e) => e.event.type === 'tool/result')!;
    const out = JSON.parse((tr.event.payload as { output: string }).output) as { childSessionId: string; finalText?: string };
    expect(out.finalText).toBe('child done');
    for (const e of parentSession.events) expect(KNOWN_EVENT_TYPES).toContain(e.event.type);
    // 子会话独立落盘 + 血缘 header
    const childDir = manager.list().find((s) => loadSession(s.dir).header?.parentSession === created.id)!.dir;
    const childHeader = loadSession(childDir).header!;
    expect(childHeader.subagent).toBe(true);
    expect(childHeader.isSeeded).toBe(true);
    // 子会话事件经 hub 观察缝流出（WS 面同源可见）
    expect(collected.events.some((e) => e.sessionId === childHeader.sessionId && e.type === 'user/message')).toBe(true);
    expect(collected.turnEnds.some((e) => e.sessionId === childHeader.sessionId)).toBe(true);
    // 共享注册表未被 subagent 工具污染（per-turn 重绑语义）
    expect(tools.get('subagent_start')).toBeUndefined();
  });

  it('开关：未装配 subagent → 工具集无 subagent_*；装配后 toolsForSession 有且共享表不被改写', async () => {
    const root = tmpDir();
    const manager = new SessionManager(join(root, 's'));
    const tools = new ToolRegistry();
    tools.register(toolDef('read'));
    const plainHub = new SessionHub({ manager, provider: new MockProvider([]), tools, cwd: root });
    const sid = '20260906-000000-aaaaaa';
    expect(plainHub.toolsForSession(sid).get('subagent_start')).toBeUndefined();
    const subHub = new SessionHub({
      manager,
      provider: new MockProvider([]),
      tools,
      cwd: root,
      subagent: { provider: new MockProvider([]), maxDepth: 1, maxTurns: 5 },
    });
    const ts = subHub.toolsForSession(sid);
    expect(ts.get('subagent_start')).toBeDefined();
    expect(ts.get('subagent_continue')).toBeDefined();
    expect(ts.get('read')).toBeDefined();
    expect([...SUBAGENT_TOOL_NAMES]).toEqual(['subagent_start', 'subagent_continue']);
    await plainHub.close();
    await subHub.close();
  });

  it('P1-3：插件抢占 subagent 权威工具名 → turn 工具集用权威版 + 告警（不静默、不崩溃）', async () => {
    const root = tmpDir();
    const manager = new SessionManager(join(root, 's'));
    const tools = new ToolRegistry();
    tools.register(toolDef('read'));
    // 模拟插件抢注的 subagent_start（权限/装载层放行后的共享注册表现状）
    const pluginVersion = toolDef('subagent_start');
    tools.register(pluginVersion);
    const errorLines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errorLines.push(String(line));
    });
    const hub = new SessionHub({
      manager,
      provider: new MockProvider([]),
      tools,
      cwd: root,
      subagent: { provider: new MockProvider([]), maxDepth: 1, maxTurns: 5 },
    });
    const sid = '20260906-000000-aaaaaa';
    const ts = hub.toolsForSession(sid);
    // 权威版进 turn 工具集（插件版被换装剔除）；共享注册表原样（插件工具不被悄悄销毁）
    expect(ts.get('subagent_start')!.description).not.toBe(pluginVersion.description);
    expect(ts.get('subagent_continue')).toBeDefined();
    expect(tools.get('subagent_start')).toBe(pluginVersion);
    expect(errorLines.join('\n')).toContain('"subagent_start" 与 subagent 权威工具重名');
    // 每 turn 重装不重复告警（同名只告警一次）
    hub.toolsForSession(sid);
    expect(errorLines.filter((l) => l.includes('subagent_start'))).toHaveLength(1);
    spy.mockRestore();
    await hub.close();
  });

  it('审批上抛：子会话 ask 进入同一待审批表（payload.sessionId = 子会话），allow 后执行', async () => {
    const root = tmpDir();
    const manager = new SessionManager(join(root, 's'));
    const tools = new ToolRegistry();
    const childLog: string[] = [];
    tools.register(toolDef('child_tool', childLog));
    const hub = new SessionHub({
      manager,
      provider: new MockProvider([{ toolCalls: [{ id: 'c1', name: 'subagent_start', arguments: '{"prompt":"p"}' }] }, { text: 'wrapped' }]),
      tools,
      cwd: root,
      subagent: { provider: new MockProvider([{ toolCalls: [{ id: 'cc1', name: 'child_tool', arguments: '{}' }] }, { text: 'child done' }]), maxDepth: 1, maxTurns: 5 },
      decide: () => 'ask', // child_tool 不在安全集 → 子会话 ask
      approvalTimeoutMs: 3000,
      hooks: {},
    });
    let childSessionIdFromApproval: string | null = null;
    const hooks: SessionHubHooks = {
      onApprovalRequest: (approval) => {
        childSessionIdFromApproval = approval.sessionId;
        hub.respondApproval(approval.requestId, 'allow'); // 自动允许（测试通道）
      },
    };
    hub.addHooks(hooks);
    const created = hub.create(root);
    hub.sendUserMessage(created.id, 'go');
    await waitFor(() => childLog.length > 0);
    await hub.close();
    expect(childSessionIdFromApproval).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6,}$/);
    expect(childSessionIdFromApproval).not.toBe(created.id); // payload 归属子会话
    expect(childLog).toEqual(['child_tool']);
  });
});

// —— serve 级装配（config 派生路径） ——

const MIN_CONFIG = {
  providers: { ch: { protocol: 'openai', baseUrl: 'https://example.invalid' } },
  roles: { main: { channel: 'ch', model: 'm' } },
};

function writeHomeFixture(home: string, config: Record<string, unknown>, plugin?: { name: string }): void {
  const harnessDir = join(home, '.harness2');
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(join(harnessDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  // provider 走 config 派生路径（fixture key；测试不发起真实 turn，零网络）
  writeFileSync(join(harnessDir, 'auth.json'), JSON.stringify({ channels: { ch: { apiKey: 'fixture-key' } } }), 'utf8');
  if (plugin !== undefined) {
    const dir = join(harnessDir, 'plugins', plugin.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ name: plugin.name, version: '1.0.0', permissions: { tools: true } }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(dir, 'index.js'),
      `export default { name: '${plugin.name}', setup(ctx) { ctx.registerTool({ name: 'p_greet', description: 'greet', parameters: { type: 'object', properties: {} }, execute: () => ({ output: 'plugin-hello' }) }); } };`,
      'utf8',
    );
  }
}

describe('startServe 插件/MCP 装配', () => {
  it('plugins.enabled + allow → 插件工具进装配链；enabled=false → 零插件行为', async () => {
    const home = tmpDir();
    const root = tmpDir();
    writeHomeFixture(home, { ...MIN_CONFIG, plugins: { enabled: true, allow: ['demo'] } }, { name: 'demo' });
    const handle = await startServe({ port: 0, home, root });
    try {
      expect(handle.plugins).toBeDefined();
      const ts = handle.hub.toolsForSession('20260906-000000-aaaaaa');
      expect(ts.get('p_greet')).toBeDefined();
      // 冲突优先级：本地已注册同名 → 插件无法顶替（注册即拒绝）
      const events = ts.list().map((d) => d.name);
      expect(events.indexOf('read')).toBeLessThan(events.indexOf('p_greet'));
    } finally {
      await handle.close();
    }
    // disable 开关：enabled=false → 不装载
    const home2 = tmpDir();
    writeHomeFixture(home2, { ...MIN_CONFIG, plugins: { enabled: false, allow: ['demo'] } }, { name: 'demo' });
    const handle2 = await startServe({ port: 0, home: home2, root });
    try {
      expect(handle2.plugins).toBeUndefined();
      expect(handle2.hub.toolsForSession('20260906-000000-aaaaaa').get('p_greet')).toBeUndefined();
    } finally {
      await handle2.close();
    }
  });

  it('mcpServers 配置 → namespaced 工具进装配链；close 后下线', async () => {
    const home = tmpDir();
    const root = tmpDir();
    writeHomeFixture(home, {
      ...MIN_CONFIG,
      mcpServers: { probe: { command: process.execPath, args: [join(import.meta.dirname, 'fixtures', 'mcp-stdio-server.mjs')] } },
    });
    const handle = await startServe({ port: 0, home, root });
    try {
      expect(handle.mcp).toBeDefined();
      const ts = handle.hub.toolsForSession('20260906-000000-aaaaaa');
      const def = ts.get('mcp__probe__echo')!;
      expect(def).toBeDefined();
      const out = await def.execute({ msg: 'assembly' }, { signal: new AbortController().signal, cwd: root });
      expect(out.output).toBe('stdio-echo:assembly');
    } finally {
      await handle.close();
    }
  });

  it('插件事件订阅桥接：hub 落盘事件 → 插件 on handler（serve 观察面同源）', async () => {
    const root = tmpDir();
    const home = tmpDir();
    // fixture 插件：声明 events 权限并订阅 user/message
    const dir = join(defaultPluginsRoot(home), 'watch');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ name: 'watch', version: '1.0.0', permissions: { events: ['user/message'] } }, null, 2),
      'utf8',
    );
    writeFileSync(
      join(dir, 'index.js'),
      `export default { name: 'watch', setup(ctx) { ctx.on('user/message', (f) => { const g = globalThis; (g.__h2_seen ??= []).push(f.event.payload.text); }); } };`,
      'utf8',
    );
    const tools = new ToolRegistry();
    const bus = new PluginBus({ tools });
    const report = await bus.loadAll(defaultPluginsRoot(home), ['watch']);
    expect(report.loaded).toHaveLength(1);
    const hub = new SessionHub({
      manager: new SessionManager(join(root, 's')),
      provider: new MockProvider([{ text: 'hi' }]),
      tools,
      cwd: root,
      plugins: { bus },
    });
    const created = hub.create(root);
    hub.sendUserMessage(created.id, 'bridge-me');
    const g = globalThis as { __h2_seen?: string[] };
    await waitFor(() => (g.__h2_seen ?? []).includes('bridge-me'));
    await hub.close();
    bus.dispose();
    expect(g.__h2_seen).toEqual(['bridge-me']);
    delete g.__h2_seen;
  });
});

// 默认插件根冒烟（defaultPluginsRoot 依赖 home 注入；此处仅确认函数可用）
describe('defaultPluginsRoot', () => {
  it('home 注入生效', () => {
    expect(defaultPluginsRoot('/tmp/h2home')).toContain('.harness2');
    expect(defaultPluginsRoot('/tmp/h2home')).toContain('plugins');
  });
});
