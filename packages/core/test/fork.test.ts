// 会话分叉测试（阶段 6 Task 5）：
//   全量/atSeq 截取分叉后投影一致、原会话字节级零变化、血缘 header、
//   影子事件与 rewind/marker 不复制、memory/snapshot 照常复制、边界（越界/未知/缺 cwd）、
//   hub.fork + HTTP POST /api/sessions/:id/fork + WS op fork。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSessionsRoot,
  forkSession,
  ForkError,
  MemoryStore,
  MockProvider,
  runTurn,
  SessionManager,
  SessionWriter,
  ToolRegistry,
  loadSession,
  computeProjection,
  startServe,
  type ServeHandle,
} from '../src/index.js';
import { SESSION_LOG_FILE } from '../src/session/types.js';

const dirs: string[] = [];
const handles: ServeHandle[] = [];
function tmpDir(prefix = 'h2-fork-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 组一个原始会话：header(1) u1(2) a1(3) u2(4) a2(5) tool(6) result(7) a3(8) */
function buildOriginal(root: string, withMemorySnapshot = false): { manager: SessionManager; id: string; dir: string } {
  const manager = new SessionManager(defaultSessionsRoot(root));
  const { id, writer } = manager.create(root);
  if (withMemorySnapshot) writer.append('memory/snapshot', { content: '冻结记忆快照' });
  writer.append('user/message', { text: 'u1', turnId: 't1' });
  writer.append('assistant/message', { text: 'a1', turnId: 't1' });
  writer.append('user/message', { text: 'u2', turnId: 't2' });
  writer.append('assistant/message', { text: 'a2', turnId: 't2' });
  writer.append('tool/call', { callId: 'c1', tool: 'bash', args: { cmd: 'ls' }, turnId: 't2' });
  writer.append('tool/result', { callId: 'c1', ok: true, output: 'f1', turnId: 't2' });
  writer.append('assistant/message', { text: 'a3', turnId: 't2' });
  writer.close();
  const dir = manager.locate(id);
  return { manager, id, dir };
}

function logBytes(dir: string): string {
  return readFileSync(join(dir, SESSION_LOG_FILE), 'utf8');
}

function projectionTexts(dir: string): string[] {
  const s = loadSession(dir);
  return computeProjection(s).messages.map((m) => `${m.role}:${m.text}`);
}

describe('forkSession 内核语义', () => {
  it('全量分叉：投影一致、血缘 header、原会话字节级零变化、rewind/影子不复制', () => {
    const root = tmpDir();
    const orig = buildOriginal(root, true);
    const before = logBytes(orig.dir);

    const r = forkSession(orig.manager, orig.id);
    expect(r.parentSession).toBe(orig.id);
    expect(r.copiedEvents).toBe(8); // snapshot + u1 a1 u2 a2 call result a3

    // 原会话零变化（字节级）
    expect(logBytes(orig.dir)).toBe(before);

    // 血缘 header
    const forked = loadSession(r.dir);
    expect(forked.header).toMatchObject({
      parentSession: orig.id,
      isSeeded: true,
      cwd: loadSession(orig.dir).header?.cwd,
    });

    // 投影一致（消息序列）
    expect(projectionTexts(r.dir)).toEqual(projectionTexts(orig.dir));

    // 新日志结构：header 开头、无 rewind/marker、memory/snapshot 照常复制（冻结语义延续）
    const events = forked.events.map((x) => x.event);
    expect(events[0]?.type).toBe('session/header');
    expect(events.some((e) => e.type === 'rewind/marker')).toBe(false);
    expect(events.filter((e) => e.type === 'memory/snapshot')).toHaveLength(1);
    // seq 从 2 连续编号（新 seq），payload 原样
    expect(events[1]?.seq).toBe(2);
    const u1 = events.find((e) => e.type === 'user/message');
    expect(u1 && u1.type === 'user/message' ? u1.payload.text : null).toBe('u1');
  });

  it('atSeq 截取：只复制 seq <= atSeq 的活动事件（新会话为前缀投影）', () => {
    const root = tmpDir();
    const orig = buildOriginal(root);
    // 结构：header(1) u1(2) a1(3) u2(4) a2(5) call(6) result(7) a3(8)；atSeq=3 → u1 a1
    const r = forkSession(orig.manager, orig.id, { atSeq: 3 });
    expect(r.copiedEvents).toBe(2);
    expect(projectionTexts(r.dir)).toEqual(['user:u1', 'assistant:a1']);
  });

  it('atSeq=1（只有 header）→ 空分叉合法；原会话含影子事件时分叉只带活动投影', () => {
    const root = tmpDir();
    const orig = buildOriginal(root);
    // 追加 rewind 到 seq 3：遮蔽 u1 之后的所有事件（4..8），随后 a9 属新分支活动
    const w = SessionWriter.open(orig.dir, { fsync: false });
    w.append('rewind/marker', { rewindToSeq: 3, reason: 'undo' });
    w.append('assistant/message', { text: '新分支回复' });
    w.close();

    const r = forkSession(orig.manager, orig.id);
    // 活动事件：header + u1(2) a1(3) + marker + 新分支 a（marker 不复制，a 复制）
    expect(r.copiedEvents).toBe(3); // u1 a1 新分支回复
    const forked = loadSession(r.dir);
    expect(forked.events.some((x) => x.event.type === 'rewind/marker')).toBe(false);
    expect(forked.events.every((x) => x.active)).toBe(true); // 新日志无影子
    expect(projectionTexts(r.dir)).toEqual(['user:u1', 'assistant:a1', 'assistant:新分支回复']);
  });

  it('空分叉（atSeq=1）得到只有 header 的新会话', () => {
    const root = tmpDir();
    const orig = buildOriginal(root);
    const r = forkSession(orig.manager, orig.id, { atSeq: 1 });
    expect(r.copiedEvents).toBe(0);
    expect(loadSession(r.dir).events).toHaveLength(1); // 仅 header
    expect(projectionTexts(r.dir)).toEqual([]);
  });

  it('边界：atSeq 越界（0/超尾/非整数）与未知会话/缺 cwd 分别报错', () => {
    const root = tmpDir();
    const orig = buildOriginal(root);
    for (const atSeq of [0, 99, 1.5]) {
      expect(() => forkSession(orig.manager, orig.id, { atSeq })).toThrow(ForkError);
      try {
        forkSession(orig.manager, orig.id, { atSeq });
      } catch (e) {
        expect((e as ForkError).code).toBe('invalid');
      }
    }
    expect(() => forkSession(orig.manager, 'nope-id')).toThrow(/session not found/);
    try {
      forkSession(orig.manager, 'nope-id');
    } catch (e) {
      expect((e as ForkError).code).toBe('not_found');
    }

    // 缺 header.cwd 的会话：无法确定分组 → invalid（须在 manager 根下才能被 locate 找到）
    const bareDir = join(defaultSessionsRoot(root), 'bare-group', 'bare-id');
    const w = SessionWriter.create(bareDir, { sessionId: 'bare-id' }, { fsync: false });
    w.append('user/message', { text: 'x' });
    w.close();
    expect(() => forkSession(orig.manager, 'bare-id')).toThrow(/header\.cwd/);
  });

  // —— 快照分支（审查覆盖缺口）：分叉与 memory/snapshot 冻结语义的交互 ——

  it('快照分支 A（atSeq 在快照之后）：分叉会话复用冻结内容，store 后续变化不注入', async () => {
    const root = tmpDir();
    const store = new MemoryStore(join(root, 'memories'));
    await store.apply([{ operation: 'add', target: 'memory', text: '分叉前的记忆' }]);
    const manager = new SessionManager(defaultSessionsRoot(root));
    const { id, writer } = manager.create(root);
    await runTurn(writer, {
      provider: new MockProvider([{ text: 'a1' }]),
      tools: new ToolRegistry(),
      cwd: root,
      userText: 'u1',
      memory: store,
    });
    writer.close();

    // 全量分叉（缺省 atSeq = 尾部）：memory/snapshot 是普通活动事件，照常复制
    const r = forkSession(manager, id);
    expect(r.copiedEvents).toBeGreaterThan(0);
    // 分叉后 store 变化：分叉会话的快照已冻结 → 请求 system 仍为复制来的快照
    await store.apply([{ operation: 'add', target: 'memory', text: '分叉后的新记忆' }]);
    const provider = new MockProvider([{ text: 'fork-a1' }]);
    await runTurn(r.dir, {
      provider,
      tools: new ToolRegistry(),
      cwd: root,
      userText: 'fork-u1',
      memory: store,
    });

    const snaps = loadSession(r.dir).events.filter((x) => x.event.type === 'memory/snapshot');
    expect(snaps).toHaveLength(1); // 复用冻结内容，未追加新快照
    const frozen = (snaps[0]!.event.payload as { content: string }).content;
    expect(frozen).toContain('分叉前的记忆');
    expect(provider.requests[0]!.system).toBe(frozen);
    expect(provider.requests[0]!.system).not.toContain('分叉后的新记忆');
  });

  it('快照分支 B（atSeq 截在快照之前）：下轮读当前 store 补落新快照并注入', async () => {
    const root = tmpDir();
    const store = new MemoryStore(join(root, 'memories'));
    await store.apply([{ operation: 'add', target: 'memory', text: '原会话的记忆' }]);
    const manager = new SessionManager(defaultSessionsRoot(root));
    const { id, writer } = manager.create(root);
    await runTurn(writer, {
      provider: new MockProvider([{ text: 'a1' }]),
      tools: new ToolRegistry(),
      cwd: root,
      userText: 'u1',
      memory: store,
    });
    writer.close();

    // atSeq=1：只有 header 的空分叉——快照事件（seq 2）不进新会话（等价于"原会话无快照"分支）
    const r = forkSession(manager, id, { atSeq: 1 });
    expect(r.copiedEvents).toBe(0);
    const provider = new MockProvider([{ text: 'fork-a1' }]);
    await runTurn(r.dir, {
      provider,
      tools: new ToolRegistry(),
      cwd: root,
      userText: 'fork-u1',
      memory: store,
    });

    const snaps = loadSession(r.dir).events.filter((x) => x.event.type === 'memory/snapshot');
    expect(snaps).toHaveLength(1); // 无冻结可复用 → 下轮读当前 store 补落
    const fresh = (snaps[0]!.event.payload as { content: string }).content;
    expect(fresh).toContain('原会话的记忆');
    expect(provider.requests[0]!.system).toBe(fresh);
  });
});

describe('hub / HTTP / WS 分叉入口', () => {
  it('hub.fork：返回新会话；events 投影一致；busy 会话也可分叉（只读日志）', async () => {
    const handle = await startServe({
      provider: new MockProvider([{ textChunks: ['回复。'] }, { textChunks: ['回复二。'] }]),
    });
    handles.push(handle);
    const root = tmpDir('h2-fork-root-');
    const { id } = handle.hub.create(root);
    handle.hub.sendUserMessage(id, '第一句');
    handle.hub.sendUserMessage(id, '第二句');
    while (handle.hub.isBusy(id)) await sleep(30);
    const r = handle.hub.fork(id);
    expect(r.parentSession).toBe(id);
    const forkedEvents = handle.hub.events(r.id);
    expect(forkedEvents.header).toMatchObject({ parentSession: id, isSeeded: true });
    const origEvents = handle.hub.events(id);
    const msgs = (p: typeof origEvents) =>
      p.events.filter((e) => e.active && (e.type === 'user/message' || e.type === 'assistant/message'));
    expect(msgs(forkedEvents).map((e) => (e.payload as { text: string }).text)).toEqual(
      msgs(origEvents).map((e) => (e.payload as { text: string }).text),
    );
    expect(msgs(forkedEvents).length).toBe(4); // 2 轮 × (user+assistant)
  }, 20000);

  it('HTTP：POST /api/sessions/:id/fork → 200；未知会话 404；非法 atSeq 400', async () => {
    const handle = await startServe({ provider: new MockProvider([{ textChunks: ['回复。'] }]) });
    handles.push(handle);
    const root = tmpDir('h2-fork-root-');
    const created = await api(handle, 'POST', '/api/sessions', { cwd: root });
    const id = created.json.id as string;
    handle.hub.sendUserMessage(id, '第一句');
    while (handle.hub.isBusy(id)) await sleep(30);

    const ok = await api(handle, 'POST', `/api/sessions/${id}/fork`, {});
    expect(ok.status).toBe(200);
    expect(ok.json.parentSession).toBe(id);
    expect(ok.json.copiedEvents).toBe(4); // 一轮 turn：user + step/start + assistant + step/end
    expect(ok.json.id).not.toBe(id);

    const cut = await api(handle, 'POST', `/api/sessions/${id}/fork`, { atSeq: 999 });
    expect(cut.status).toBe(400);

    // 合法格式但不存在的 id → 404（复审 P2-1 后：`nope` 等非法格式走 400，见 server.test.ts sessionId 校验测试）
    const nf = await api(handle, 'POST', '/api/sessions/20990101-000000-000000/fork', {});
    expect(nf.status).toBe(404);
  }, 20000);

  it('WS：op fork → forked 帧（新会话 id + 血缘 + 事件数）', async () => {
    const handle = await startServe({ provider: new MockProvider([{ textChunks: ['回复。'] }]) });
    handles.push(handle);
    const root = tmpDir('h2-fork-root-');
    const { id } = handle.hub.create(root);
    handle.hub.sendUserMessage(id, '第一句');
    while (handle.hub.isBusy(id)) await sleep(30);

    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const frames: Array<Record<string, unknown>> = [];
    ws.on('message', (data: unknown) => frames.push(JSON.parse(String(data))));
    ws.send(JSON.stringify({ op: 'fork', sessionId: id }));
    for (let i = 0; i < 100 && !frames.some((f) => f['type'] === 'forked'); i++) await sleep(10);
    const forked = frames.find((f) => f['type'] === 'forked');
    expect(forked).toMatchObject({ type: 'forked', parentSession: id, copiedEvents: 4 });
    expect(typeof forked?.['sessionId']).toBe('string');
    ws.close();
  }, 20000);
});

function sleep(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function api(
  handle: ServeHandle,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
}
