// Subagent 测试（阶段 8 Task 3）：独立子会话落盘 / 血缘 header / 深度限制 / 取消传播 /
// continue 往返与血缘校验 / 子失败不影响父 / 参数校验 / 零新增事件类型。
// mock provider 脚本按消费顺序编排父/子/孙 turn（同一 provider 实例贯穿父子）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { MockProvider, type MockScript } from '../src/provider/mock.js';
import { SessionManager } from '../src/session/manager.js';
import { loadSession, computeProjection } from '../src/session/reader.js';
import { runTurn } from '../src/agent/loop.js';
import {
  SUBAGENT_TOOL_NAMES,
  buildSubagentChildTools,
  createSubagentTools,
  type SubagentOptions,
  type SubagentStartOutput,
} from '../src/agent/subagent.js';
import { KNOWN_EVENT_TYPES } from '../src/session/types.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-subagent-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CALL_CTX = { signal: new AbortController().signal, cwd: '.' };

function parseOut(output: string | undefined): SubagentStartOutput {
  return JSON.parse(output!) as SubagentStartOutput;
}

/** 子会话可用工具（记录调用），注册进 base registry */
function childToolDef(log: Array<{ name: string; args: unknown }>): ToolDefinition {
  return {
    name: 'child_tool',
    description: '子会话可用的宿主工具',
    parameters: { type: 'object', properties: { x: { type: 'string' } } },
    execute: (args) => {
      log.push({ name: 'child_tool', args });
      return { output: 'child-tool-ok' };
    },
  };
}

interface Harness {
  manager: SessionManager;
  registry: ToolRegistry;
  provider: MockProvider;
  parentWriter: ReturnType<SessionManager['create']>['writer'];
  parentId: string;
  childLog: Array<{ name: string; args: unknown }>;
  childEvents: Array<{ sessionId: string; type: string }>;
}

/** 组装父会话（depth 0）+ 注册 subagent 工具 */
function makeHarness(script: MockScript, opts: { maxDepth?: number; maxTurns?: number; cwd?: string } = {}): Harness {
  const root = tmpDir();
  const manager = new SessionManager(join(root, 'sessions'));
  const provider = new MockProvider(script);
  const registry = new ToolRegistry();
  const childLog: Array<{ name: string; args: unknown }> = [];
  registry.register(childToolDef(childLog));
  const parent = manager.create(opts.cwd ?? root, { fsync: false });
  const childEvents: Array<{ sessionId: string; type: string }> = [];
  const subOptions: SubagentOptions = {
    manager,
    provider,
    baseTools: registry,
    cwd: opts.cwd ?? root,
    maxDepth: opts.maxDepth ?? 1,
    maxTurns: opts.maxTurns ?? 25,
    parentSessionId: parent.id,
    depth: 0,
    hooks: {
      onChildEvent: (sessionId, event) => childEvents.push({ sessionId, type: event.type }),
    },
    fsync: false,
  };
  for (const def of createSubagentTools(subOptions)) registry.register(def);
  return {
    manager,
    registry,
    provider,
    parentWriter: parent.writer,
    parentId: parent.id,
    childLog,
    childEvents,
  };
}

/** 找到 parentId 的直接子会话目录 */
function childDirs(manager: SessionManager, parentId: string): string[] {
  return manager
    .list()
    .filter((s) => loadSession(s.dir).header?.parentSession === parentId)
    .map((s) => s.dir);
}

/** 轮询等待条件成立（异步收尾竞态防护） */
async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 15): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe('subagent_start 独立子会话', () => {
  it('往返：子会话跑完整 turn，output 带 {childSessionId, finalText, stopReason}', async () => {
    const h = makeHarness([
      { toolCalls: [{ id: 'c1', name: 'subagent_start', arguments: '{"prompt":"do it"}' }] },
      { text: 'child done' },
      { text: 'parent wrapped' },
    ]);
    const result = await runTurn(h.parentWriter, {
      provider: h.provider,
      tools: h.registry,
      cwd: '.',
      userText: '帮我去办',
      maxSteps: 5,
    });
    expect(result.stopReason).toBe('end_turn');
    expect(result.finalText).toBe('parent wrapped');
    // 父日志只有 tool/call + tool/result（零新增事件类型），output 携带子会话 id
    const parentSession = loadSession(h.parentWriter.dir);
    const toolResults = parentSession.events.filter((e) => e.event.type === 'tool/result');
    const out = parseOut((toolResults[0]!.event.payload as { output?: string }).output);
    expect(out.childSessionId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6,}$/);
    expect(out.finalText).toBe('child done');
    expect(out.stopReason).toBe('end_turn');
    // 血缘 header：parentSession + isSeeded + subagent
    const childDir = childDirs(h.manager, h.parentId);
    expect(childDir).toHaveLength(1);
    const header = loadSession(childDir[0]!).header!;
    expect(header.parentSession).toBe(h.parentId);
    expect(header.isSeeded).toBe(true);
    expect(header.subagent).toBe(true);
    // 子会话独立落盘：user/message + assistant/message
    const childSession = loadSession(childDir[0]!);
    const types = childSession.events.map((e) => e.event.type);
    expect(types).toContain('user/message');
    expect(types).toContain('assistant/message');
    computeProjection(childSession);
    const childTexts = childSession.events
      .filter((e) => e.event.type === 'assistant/message')
      .map((e) => (e.event.payload as { text: string }).text);
    expect(childTexts).toEqual(['child done']);
    // 全部事件类型都在既有 KNOWN_EVENT_TYPES 内（零新增事件类型）
    for (const t of types) expect(KNOWN_EVENT_TYPES).toContain(t);
    for (const t of parentSession.events.map((e) => e.event.type)) expect(KNOWN_EVENT_TYPES).toContain(t);
  });

  it('子会话工具集 = 父集 − subagent 工具：宿主工具可用、subagent 工具缺席', async () => {
    const h = makeHarness([
      { toolCalls: [{ id: 'c1', name: 'subagent_start', arguments: '{"prompt":"use tools"}' }] },
      { toolCalls: [{ id: 'cc1', name: 'child_tool', arguments: '{"x":"1"}' }] },
      { text: 'child done' },
      { text: 'parent wrapped' },
    ]);
    await runTurn(h.parentWriter, {
      provider: h.provider,
      tools: h.registry,
      cwd: '.',
      userText: 'go',
      maxSteps: 6,
    });
    expect(h.childLog).toEqual([{ name: 'child_tool', args: { x: '1' } }]);
    // 第二次模型请求 = 子会话 turn：tools 不含 subagent_*
    const childReq = h.provider.requests[1]!;
    const names = (childReq.tools ?? []).map((t) => t.name);
    expect(names).toContain('child_tool');
    expect(names).not.toContain('subagent_start');
    expect(names).not.toContain('subagent_continue');
  });

  it('cwd 参数：子会话 header.cwd 解析到指定目录', async () => {
    const root = tmpDir();
    const h = makeHarness(
      [
        { toolCalls: [{ id: 'c1', name: 'subagent_start', arguments: JSON.stringify({ prompt: 'p', cwd: 'sub/dir' }) }] },
        { text: 'ok' },
        { text: 'done' },
      ],
      { cwd: root },
    );
    await runTurn(h.parentWriter, { provider: h.provider, tools: h.registry, cwd: root, userText: 'go', maxSteps: 5 });
    const childDir = childDirs(h.manager, h.parentId)[0]!;
    expect(loadSession(childDir).header!.cwd).toBe(join(root, 'sub', 'dir'));
  });

  it('子失败不影响父：子 provider 报错 → output.stopReason=error，父 turn 正常收尾', async () => {
    const h = makeHarness([
      { toolCalls: [{ id: 'c1', name: 'subagent_start', arguments: '{"prompt":"boom"}' }] },
      { error: 'child provider exploded' },
      { text: 'parent still fine' },
    ]);
    const result = await runTurn(h.parentWriter, {
      provider: h.provider,
      tools: h.registry,
      cwd: '.',
      userText: 'go',
      maxSteps: 5,
    });
    expect(result.stopReason).toBe('end_turn');
    expect(result.finalText).toBe('parent still fine');
    const parentSession = loadSession(h.parentWriter.dir);
    const tr = parentSession.events.find((e) => e.event.type === 'tool/result')!;
    const out = parseOut((tr.event.payload as { output?: string }).output);
    expect(out.stopReason).toBe('error');
    expect(out.error).toContain('child provider exploded');
    expect(out.childSessionId).toBeTruthy();
  });
});

describe('深度限制', () => {
  it('maxDepth=1（默认）：子会话工具集无 subagent 工具（buildSubagentChildTools 单元）', () => {
    const root = tmpDir();
    const manager = new SessionManager(join(root, 's'));
    const base = new ToolRegistry();
    base.register(childToolDef([]));
    const options: SubagentOptions = {
      manager,
      provider: new MockProvider([]),
      baseTools: base,
      cwd: root,
      maxDepth: 1,
      maxTurns: 25,
      parentSessionId: 'parent',
      depth: 0, // 派发方深度
    };
    // 派发方的子会话深度 = 1，1 < 1 为假 → 子工具集无 subagent 工具
    const childTools = buildSubagentChildTools(options, 'child-x');
    expect(childTools.get('child_tool')).toBeDefined();
    expect(childTools.get('subagent_start')).toBeUndefined();
    expect(childTools.get('subagent_continue')).toBeUndefined();
    // maxDepth=2 时子会话工具集重挂 subagent 工具（血缘重绑由集成用例覆盖）
    const deeper = buildSubagentChildTools({ ...options, maxDepth: 2 }, 'child-x');
    expect(deeper.get('subagent_start')).toBeDefined();
    expect(deeper.get('subagent_continue')).toBeDefined();
  });

  it('maxDepth=2：子会话可继续下钻，孙会话无 subagent 工具', async () => {
    const h = makeHarness(
      [
        { toolCalls: [{ id: 'c1', name: 'subagent_start', arguments: '{"prompt":"level 1"}' }] },
        { toolCalls: [{ id: 'c2', name: 'subagent_start', arguments: '{"prompt":"level 2"}' }] },
        { text: 'grandchild done' },
        { text: 'child done' },
        { text: 'parent done' },
      ],
      { maxDepth: 2 },
    );
    await runTurn(h.parentWriter, {
      provider: h.provider,
      tools: h.registry,
      cwd: '.',
      userText: 'go deep',
      maxSteps: 8,
    });
    // 子请求含 subagent 工具（子深度 1 < 2），孙请求不含（孙深度 2 < 2 为假）
    const childReq = h.provider.requests[1]!;
    const grandReq = h.provider.requests[2]!;
    expect((childReq.tools ?? []).map((t) => t.name)).toContain('subagent_start');
    expect((grandReq.tools ?? []).map((t) => t.name)).not.toContain('subagent_start');
    // 孙会话血缘：parentSession = 子会话 id（重绑语义）
    const grandPrompt = grandReq.messages[0]!.content as string;
    expect(grandPrompt).toBe('level 2');
    const childDir = childDirs(h.manager, h.parentId)[0]!;
    const childId = loadSession(childDir).header!.sessionId!;
    const grandDirs = childDirs(h.manager, childId);
    expect(grandDirs).toHaveLength(1);
    expect(loadSession(grandDirs[0]!).header!.subagent).toBe(true);
    const out = parseOut(
      (loadSession(childDir).events.filter((e) => e.event.type === 'tool/result')[0]!.event.payload as { output?: string })
        .output,
    );
    expect(out.finalText).toBe('grandchild done');
    expect(out.childSessionId).toBe(loadSession(grandDirs[0]!).header!.sessionId!);
  });
});

describe('subagent_continue', () => {
  it('往返：向子会话追加消息继续跑，返回新结果', async () => {
    const h = makeHarness([{ text: 'first result' }, { text: 'second result' }]);
    const startDef = h.registry.get('subagent_start')!;
    const startOut = await startDef.execute({ prompt: 'first part' }, CALL_CTX);
    const { childSessionId } = parseOut(startOut.output);
    const continueDef = h.registry.get('subagent_continue')!;
    const contOut = await continueDef.execute(
      { childSessionId, message: 'go on' },
      CALL_CTX,
    );
    const parsed = parseOut(contOut.output);
    expect(parsed.childSessionId).toBe(childSessionId);
    expect(parsed.finalText).toBe('second result');
    expect(parsed.stopReason).toBe('end_turn');
    // 子会话日志：两条 user/message、两条 assistant/message（同会话续跑）
    const childDir = h.manager.locate(childSessionId);
    const childSession = loadSession(childDir);
    computeProjection(childSession);
    const userTexts = childSession.events
      .filter((e) => e.active && e.event.type === 'user/message')
      .map((e) => (e.event.payload as { text: string }).text);
    expect(userTexts).toEqual(['first part', 'go on']);
    const childReqs = h.provider.requests;
    expect(childReqs).toHaveLength(2);
    expect(childReqs[1]!.messages.map((m) => (m.role === 'user' ? m.content : null))).toContain('go on');
  });

  it('血缘校验：非本会话派生的会话拒绝续跑；未知 id 报不存在', async () => {
    const h = makeHarness([
      { toolCalls: [{ id: 'c1', name: 'subagent_start', arguments: '{"prompt":"p"}' }] },
      { text: 'ok' },
      { text: 'done' },
    ]);
    const continueDef = h.registry.get('subagent_continue')!;
    // 未知 id
    const miss = await continueDef.execute(
      { childSessionId: '20260906-000000-zzzzzz', message: 'm' },
      CALL_CTX,
    );
    expect(miss.error).toContain('子会话不存在');
    // 存在但不是子会话：造一个独立会话
    const root = tmpDir();
    const stranger = h.manager.create(root, { fsync: false });
    stranger.writer.close();
    const foreign = await continueDef.execute(
      { childSessionId: stranger.id, message: 'm' },
      CALL_CTX,
    );
    expect(foreign.error).toContain('不是本会话的子会话');
  });

  it('参数校验：缺 prompt / 缺 message / 缺 childSessionId → 明确 error', async () => {
    const h = makeHarness([]);
    const startDef = h.registry.get('subagent_start')!;
    const continueDef = h.registry.get('subagent_continue')!;
    expect((await startDef.execute({}, CALL_CTX)).error).toContain('prompt');
    expect((await startDef.execute({ prompt: '   ' }, CALL_CTX)).error).toContain('prompt');
    expect((await continueDef.execute({ message: 'm' }, CALL_CTX)).error).toContain('childSessionId');
    expect((await continueDef.execute({ childSessionId: 'x' }, CALL_CTX)).error).toContain('message');
  });
});

describe('取消传播', () => {
  it('父 abort → 子 abort：子会话 cancelled 收尾且事件照常落盘；父 tool/result 失败', async () => {
    const h = makeHarness([
      // 父 turn：调 subagent_start；子 turn：慢速流（被 abort 打断）
      { toolCalls: [{ id: 'c1', name: 'subagent_start', arguments: '{"prompt":"long task"}' }] },
      { textChunks: ['a', 'b', 'c', 'd', 'e'], chunkDelayMs: 120 },
      { text: 'unreachable' },
    ]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const result = await runTurn(h.parentWriter, {
      provider: h.provider,
      tools: h.registry,
      cwd: '.',
      userText: 'go',
      signal: ac.signal,
      maxSteps: 5,
    });
    expect(result.stopReason).toBe('cancelled');
    // 等子会话异步收尾落盘（父 turn 返回与子 finishCancelled 落盘之间无先后保证）
    let childDir = '';
    await waitFor(() => {
      childDir = childDirs(h.manager, h.parentId)[0] ?? '';
      if (!childDir) return false;
      return loadSession(childDir).events.at(-1)?.event.type === 'step/end';
    });
    // 父 tool/result：ok:false（取消路径 executor 语义）
    const parentSession = loadSession(h.parentWriter.dir);
    const tr = parentSession.events.find((e) => e.event.type === 'tool/result')!;
    expect((tr.event.payload as { ok: boolean }).ok).toBe(false);
    // 子会话：user/message 已落盘 + cancelled 收尾（assistant/attempt + step/end）
    expect(childDir).toBeTruthy();
    const childSession = loadSession(childDir);
    const types = childSession.events.map((e) => e.event.type);
    expect(types).toContain('user/message');
    expect(types).toContain('assistant/attempt');
    const attempt = childSession.events.find((e) => e.event.type === 'assistant/attempt')!;
    expect((attempt.event.payload as { error: string }).error).toContain('cancelled');
    expect(types).toContain('step/end');
    expect(types.at(-1)).toBe('step/end'); // append-only：取消也收口
    // 子事件经观察缝流出（hub 镜像桥接的依据）
    expect(h.childEvents.filter((e) => e.type === 'user/message')).toHaveLength(1);
  });
});

describe('SUBAGENT_TOOL_NAMES 契约', () => {
  it('工具名集合固定（装配层剔除依据）', () => {
    expect([...SUBAGENT_TOOL_NAMES]).toEqual(['subagent_start', 'subagent_continue']);
  });
});
