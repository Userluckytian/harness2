// 会话服务控制面测试（阶段 5 Task 1）：
//   HTTP API 契约（创建/列表/全量事件/undo/redo/config 脱敏报告）
//   输入校验与错误路径（404/405/400 单行 {error}）
//   端口锁（存活拒绝 / 陈旧接管 / close 释放）
//   审批上抛（onAsk → 待处理表；超时拒绝 / allow / deny 往返）
//   崩溃安全（服务重启后 /events 全量重放）与 ensureOpen 恢复路径。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSessionsRoot,
  MemoryStore,
  MockProvider,
  SessionManager,
  startServe,
  ServeLockError,
  serveLockPath,
  type MockScript,
  type ServeHandle,
  type SessionHubHooks,
  type SessionHubMemory,
} from '../src/index.js';
import { acquireServeLock } from '../src/server/http.js';

const dirs: string[] = [];
const handles: ServeHandle[] = [];
function tmpDir(prefix = 'h2-serve-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.close().catch(() => {});
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Captured {
  turnEnds: Array<{ id: string; stopReason: string; error?: string }>;
  deltas: Array<{ id: string; kind: string }>;
  approvalRequests: Array<{ requestId: string; sessionId: string; tool: string }>;
  approvalSettled: Array<{ requestId: string; allowed: boolean; reason: string }>;
}

function captureHooks(): { c: Captured; hooks: SessionHubHooks } {
  const c: Captured = { turnEnds: [], deltas: [], approvalRequests: [], approvalSettled: [] };
  return {
    c,
    hooks: {
      onTurnEnd(id, result) {
        c.turnEnds.push({
          id,
          stopReason: result.stopReason,
          ...(result.error !== undefined ? { error: result.error } : {}),
        });
      },
      onDelta(id, delta) {
        c.deltas.push({ id, kind: delta.kind });
      },
      onApprovalRequest(a) {
        c.approvalRequests.push({ requestId: a.requestId, sessionId: a.sessionId, tool: a.tool });
      },
      onApprovalSettled(requestId, allowed, reason) {
        c.approvalSettled.push({ requestId, allowed, reason });
      },
    },
  };
}

/** 等待 hooks 里的事件数达标（轮询，最大 5s） */
async function waitFor(list: unknown[], n: number): Promise<void> {
  for (let i = 0; i < 500 && list.length < n; i++) await sleep(10);
  expect(list.length).toBeGreaterThanOrEqual(n);
}

function waitForTurnEnds(c: Captured, n: number): Promise<void> {
  return waitFor(c.turnEnds, n);
}

/** 一轮"工具调用 + 收尾文本"的 mock 脚本片段 */
function toolTurn(id: string): MockScript {
  return [
    { toolCalls: [{ id, name: 'glob', arguments: JSON.stringify({ pattern: '*' }) }] },
    { textChunks: [`ok ${id}`] },
  ];
}

interface StartOpts {
  provider?: MockProvider;
  script?: MockScript;
  decide?: (input: { tool: string; args: unknown }) => 'allow' | 'deny' | 'ask';
  approvalTimeoutMs?: number;
  home?: string;
  root?: string;
  hooks?: SessionHubHooks;
  memory?: SessionHubMemory;
}

async function start(opts: StartOpts = {}): Promise<ServeHandle> {
  const handle = await startServe({
    port: 0,
    home: opts.home ?? tmpDir('h2-serve-home-'),
    root: opts.root ?? tmpDir('h2-serve-root-'),
    provider: opts.provider ?? new MockProvider(opts.script ?? [{ textChunks: ['回复。'] }]),
    ...(opts.decide !== undefined ? { decide: opts.decide } : {}),
    ...(opts.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}),
    ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
    ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
  });
  handles.push(handle);
  return handle;
}

async function api(
  handle: ServeHandle,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : body === null
        ? { headers: { 'content-type': 'application/json' }, body: '{bad json' }
        : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
}

describe('serve 启动与 /api/config', () => {
  it('随机端口监听（--port 0 语义）；无配置时 /api/config 返回 ok:false 与错误行', async () => {
    const handle = await start();
    expect(handle.port).toBeGreaterThan(0);
    const { status, json } = await api(handle, 'GET', '/api/config');
    expect(status).toBe(200);
    expect(json.ok).toBe(false);
    expect(json.errors.length).toBeGreaterThan(0);
    expect(json.errors[0]).toContain('未找到任何配置文件');
  });

  it('配置存在 → ok:true；报告含 providers/roles/approval/key 来源；明文 key 绝不出现在响应', async () => {
    const home = tmpDir('h2-serve-home-');
    const cfgDir = join(home, '.harness2');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({
        providers: {
          ds: { protocol: 'openai', baseUrl: 'https://api.test/v1', envKey: 'DS_KEY', models: { 'm-1': {} } },
        },
        roles: { main: { channel: 'ds', model: 'm-1' } },
        approval: { mode: 'default', tools: { write: 'ask' } },
      }),
      'utf8',
    );
    writeFileSync(
      join(cfgDir, 'auth.json'),
      JSON.stringify({ channels: { ds: { apiKey: 'sk-plain-secret-987654' } } }),
      'utf8',
    );
    const handle = await start({ home });
    const { status, json } = await api(handle, 'GET', '/api/config');
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.sources).toEqual({ global: true, project: false });
    expect(json.report.providers).toHaveLength(1);
    expect(json.report.providers[0]).toMatchObject({
      channel: 'ds',
      protocol: 'openai',
      baseUrl: 'https://api.test/v1',
      envKey: 'DS_KEY',
      models: ['m-1'],
      keySource: 'auth.json',
    });
    expect(json.report.roles).toEqual([{ role: 'main', channel: 'ds', model: 'm-1' }]);
    expect(json.report.approval).toEqual({ mode: 'default', tools: { write: 'ask' } });
    // 密钥三不：key 不出服务进程
    expect(JSON.stringify(json)).not.toContain('sk-plain-secret-987654');
  });
});

describe('sessions API', () => {
  it('POST 创建 → GET 列表（cwd 过滤与全库）→ GET /events 全量事件含 active 标记', async () => {
    const handle = await start();
    const root = tmpDir('h2-serve-cwd-');
    const { status, json } = await api(handle, 'POST', '/api/sessions', { cwd: root });
    expect(status).toBe(200);
    expect(typeof json.id).toBe('string');

    const withCwd = await api(handle, 'GET', `/api/sessions?cwd=${encodeURIComponent(root)}`);
    expect(withCwd.json.sessions.map((s: { id: string }) => s.id)).toContain(json.id);
    const all = await api(handle, 'GET', '/api/sessions');
    expect(all.json.sessions.map((s: { id: string }) => s.id)).toContain(json.id);

    const events = await api(handle, 'GET', `/api/sessions/${json.id}/events`);
    expect(events.status).toBe(200);
    expect(events.json.id).toBe(json.id);
    expect(events.json.events[0].type).toBe('session/header');
    expect(events.json.events[0].active).toBe(true);
    expect(events.json.header.cwd).toBeTruthy();
    expect(events.json.lastSeq).toBe(1);
    expect(events.json.warnings).toEqual([]);
  });

  it('输入校验与错误路径：400/404/405 全部单行 {error}', async () => {
    const handle = await start();
    const missingCwd = await api(handle, 'POST', '/api/sessions', {});
    expect(missingCwd.status).toBe(400);
    expect(missingCwd.json.error).toContain('cwd');

    const badCwd = await api(handle, 'POST', '/api/sessions', { cwd: 123 });
    expect(badCwd.status).toBe(400);

    const badJson = await api(handle, 'POST', '/api/sessions', null);
    expect(badJson.status).toBe(400);
    expect(badJson.json.error).toContain('JSON');

    const notFoundRoute = await api(handle, 'GET', '/api/nope');
    expect(notFoundRoute.status).toBe(404);
    expect(notFoundRoute.json.error).toContain('not found');

    const wrongMethod = await api(handle, 'DELETE', '/api/sessions');
    expect(wrongMethod.status).toBe(405);
    const wrongMethod2 = await api(handle, 'POST', '/api/config');
    expect(wrongMethod2.status).toBe(405);

    // 合法格式但不存在的 id → 404（复审 P2-1 后：非法格式走 400，见下方 sessionId 校验测试）
    const unknownSession = await api(handle, 'GET', '/api/sessions/20990101-000000-000000/events');
    expect(unknownSession.status).toBe(404);
    expect(unknownSession.json.error).toContain('session not found');

    // 复审 P2-1：sessionId 格式校验（路径穿越原语）——`../x` 类 id 400，不触达文件系统
    const traversal = await api(handle, 'GET', '/api/sessions/%2e%2e%2Fx/events');
    expect(traversal.status).toBe(400);
    expect(traversal.json.error).toContain('会话 id');
    const traversalFork = await api(handle, 'POST', '/api/sessions/%2e%2e%2Fx/fork', {});
    expect(traversalFork.status).toBe(400);
    const traversalUndo = await api(handle, 'POST', '/api/sessions/%2e%2e%2Fx/undo', {});
    expect(traversalUndo.status).toBe(400);
  });
});

describe('undo/redo 经 HTTP 接入 Ph4 内核', () => {
  async function sessionWithTwoTurns(
    opts: StartOpts & { script: MockScript },
  ): Promise<{ handle: ServeHandle; id: string; c: Captured }> {
    const { c, hooks } = captureHooks();
    const handle = await start({ ...opts, hooks });
    const root = tmpDir('h2-serve-cwd-');
    const created = await api(handle, 'POST', '/api/sessions', { cwd: root });
    const id = created.json.id as string;
    handle.hub.sendUserMessage(id, '第一轮');
    handle.hub.sendUserMessage(id, '第二轮');
    await waitForTurnEnds(c, 2);
    return { handle, id, c };
  }

  it('dryRun 只预览不落盘；undo 追加 rewind/marker；redo 复活', async () => {
    const script: MockScript = [{ textChunks: ['一轮回复'] }, { textChunks: ['二轮回复'] }];
    const { handle, id } = await sessionWithTwoTurns({ script });

    const before = await api(handle, 'GET', `/api/sessions/${id}/events`);
    const lastSeqBefore = before.json.lastSeq;

    const dry = await api(handle, 'POST', `/api/sessions/${id}/undo`, { dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.json.results).toHaveLength(1);
    expect(dry.json.results[0].dryRun).toBe(true);
    expect(dry.json.results[0].messages).toBe(2); // 第二轮 user + assistant
    expect(dry.json.results[0].files).toEqual([]);
    const afterDry = await api(handle, 'GET', `/api/sessions/${id}/events`);
    expect(afterDry.json.lastSeq).toBe(lastSeqBefore); // dryRun 无副作用

    const undo = await api(handle, 'POST', `/api/sessions/${id}/undo`, {});
    expect(undo.status).toBe(200);
    expect(undo.json.results[0].dryRun).toBe(false);
    const afterUndo = await api(handle, 'GET', `/api/sessions/${id}/events`);
    expect(afterUndo.json.lastSeq).toBe(lastSeqBefore + 1);
    const marker = afterUndo.json.events.at(-1);
    expect(marker.type).toBe('rewind/marker');
    expect(marker.payload.reason).toBe('undo');
    // 投影收缩：影子事件 active=false
    expect(afterUndo.json.events.filter((e: { active: boolean }) => e.active).length).toBeLessThan(
      afterUndo.json.events.length,
    );

    const redo = await api(handle, 'POST', `/api/sessions/${id}/redo`, {});
    expect(redo.status).toBe(200);
    const afterRedo = await api(handle, 'GET', `/api/sessions/${id}/events`);
    expect(afterRedo.json.lastSeq).toBe(lastSeqBefore + 2);
    expect(afterRedo.json.events.at(-1).payload.reason).toBe('redo');
    // redo 复活后：全部非 marker 事件回到活动投影
    expect(
      afterRedo.json.events.filter((e: { active: boolean; type: string }) => e.active && e.type !== 'rewind/marker')
        .length,
    ).toBe(before.json.events.length);
  });

  it('undo n=2 连续撤两轮；撤空后再 undo → 400（UndoRedoError 单行）', async () => {
    const script: MockScript = [{ textChunks: ['一轮回复'] }, { textChunks: ['二轮回复'] }];
    const { handle, id } = await sessionWithTwoTurns({ script });
    const undo2 = await api(handle, 'POST', `/api/sessions/${id}/undo`, { n: 2 });
    expect(undo2.status).toBe(200);
    expect(undo2.json.results).toHaveLength(2);

    const undoAgain = await api(handle, 'POST', `/api/sessions/${id}/undo`, {});
    expect(undoAgain.status).toBe(400);
    expect(undoAgain.json.error).toContain('没有可撤回的用户消息');

    // 重做一轮后再 undo 5 层：1 层成功、第 2 层失败 → 部分结果 + error
    await api(handle, 'POST', `/api/sessions/${id}/redo`, {});
    const partial = await api(handle, 'POST', `/api/sessions/${id}/undo`, { n: 5 });
    expect(partial.status).toBe(200);
    expect(partial.json.results).toHaveLength(1);
    expect(partial.json.error).toContain('没有可撤回的用户消息');
  });

  it('turn 进行中 undo → 409；abort 后 turn 以 cancelled 收尾', async () => {
    const { c, hooks } = captureHooks();
    const handle = await start({
      hooks,
      provider: new MockProvider([{ textChunks: ['慢', '慢', '慢'], chunkDelayMs: 80 }]),
    });
    const root = tmpDir('h2-serve-cwd-');
    const id = (await api(handle, 'POST', '/api/sessions', { cwd: root })).json.id as string;
    handle.hub.sendUserMessage(id, '长任务');
    await sleep(30); // turn 已启动

    const busyUndo = await api(handle, 'POST', `/api/sessions/${id}/undo`, {});
    expect(busyUndo.status).toBe(409);
    expect(busyUndo.json.error).toContain('turn 进行中');

    expect(handle.hub.abort(id)).toBe(true);
    await waitForTurnEnds(c, 1);
    expect(c.turnEnds[0]!.stopReason).toBe('cancelled');
    expect(handle.hub.abort(id)).toBe(false); // 已结束
  });

  it('未知会话先 ensureOpen 恢复（服务重启后可继续操作既有会话）', async () => {
    const home = tmpDir('h2-serve-home-');
    const root = tmpDir('h2-serve-root-');
    // 直接经内核造一个带一轮对话的会话（模拟服务重启前的存量会话）
    const mgr = new SessionManager(defaultSessionsRoot(home));
    const { id, writer } = mgr.create(root, { fsync: false });
    writer.append('user/message', { text: '历史消息' });
    writer.append('assistant/message', { text: '历史回复' });
    writer.close();

    const handle = await start({ home, root });
    const undo = await api(handle, 'POST', `/api/sessions/${id}/undo`, {});
    expect(undo.status).toBe(200);
    const events = await api(handle, 'GET', `/api/sessions/${id}/events`);
    expect(events.json.events.at(-1).type).toBe('rewind/marker');
  });
});

describe('审批上抛（onAsk → 待处理请求表）', () => {
  it('无响应 → 超时拒绝（默认即 120s 可配短）；tool/result 落盘 ok:false', async () => {
    const { c, hooks } = captureHooks();
    const script: MockScript = [...toolTurn('c1'), { textChunks: ['收尾'] }];
    const handle = await start({
      hooks,
      provider: new MockProvider(script),
      decide: () => 'ask',
      approvalTimeoutMs: 60,
    });
    const root = tmpDir('h2-serve-cwd-');
    const id = (await api(handle, 'POST', '/api/sessions', { cwd: root })).json.id as string;
    handle.hub.sendUserMessage(id, '触发审批');

    await waitFor(c.approvalRequests, 1);
    expect(c.approvalRequests[0]!.tool).toBe('glob');
    expect(handle.hub.listPendingApprovals()).toHaveLength(1);

    await waitFor(c.approvalSettled, 1);
    expect(c.approvalSettled[0]!).toMatchObject({ allowed: false, reason: 'timeout' });
    await waitForTurnEnds(c, 1);
    const events = await api(handle, 'GET', `/api/sessions/${id}/events`);
    const toolResult = events.json.events.find((e: { type: string }) => e.type === 'tool/result');
    expect(toolResult.payload.ok).toBe(false);
    expect(toolResult.payload.error).toContain('denied by approval policy');
  });

  it('allow / deny 往返：respondApproval 明确 ack 落定审批；未知 requestId 返回 unknown', async () => {
    const { c, hooks } = captureHooks();
    const script: MockScript = [...toolTurn('c-allow'), ...toolTurn('c-deny')];
    const handle = await start({ hooks, provider: new MockProvider(script), decide: () => 'ask' });
    const root = tmpDir('h2-serve-cwd-');
    const id = (await api(handle, 'POST', '/api/sessions', { cwd: root })).json.id as string;

    // 第一轮：allow → 工具真实执行
    handle.hub.sendUserMessage(id, '第一个审批');
    await waitFor(c.approvalRequests, 1);
    expect(handle.hub.respondApproval('no-such-request-id', 'allow')).toEqual({
      requestId: 'no-such-request-id',
      state: 'unknown',
    });
    expect(handle.hub.respondApproval(c.approvalRequests[0]!.requestId, 'allow')).toEqual({
      requestId: c.approvalRequests[0]!.requestId,
      state: 'applied',
    });
    expect(c.approvalSettled[0]!).toMatchObject({ allowed: true, reason: 'response' });
    await waitForTurnEnds(c, 1);

    // 第二轮：deny → 按拒绝处理
    handle.hub.sendUserMessage(id, '第二个审批');
    await waitFor(c.approvalRequests, 2);
    expect(handle.hub.respondApproval(c.approvalRequests[1]!.requestId, 'deny')).toEqual({
      requestId: c.approvalRequests[1]!.requestId,
      state: 'applied',
    });
    await waitForTurnEnds(c, 2);

    const events = await api(handle, 'GET', `/api/sessions/${id}/events`);
    const results = events.json.events.filter((e: { type: string }) => e.type === 'tool/result');
    expect(results).toHaveLength(2);
    expect(results[0]!.payload.ok).toBe(true); // glob 在空目录执行成功
    expect(results[1]!.payload.ok).toBe(false); // deny → 拒绝
    expect(results[1]!.payload.error).toContain('denied by approval policy');
  });

  it('turn 取消时挂起的审批按拒绝收尾（不悬挂）', async () => {
    const { c, hooks } = captureHooks();
    const script: MockScript = [
      { toolCalls: [{ id: 'c-abort', name: 'glob', arguments: JSON.stringify({ pattern: '*' }) }] },
      { textChunks: ['不该到达'] },
    ];
    const handle = await start({ hooks, provider: new MockProvider(script), decide: () => 'ask' });
    const root = tmpDir('h2-serve-cwd-');
    const id = (await api(handle, 'POST', '/api/sessions', { cwd: root })).json.id as string;
    handle.hub.sendUserMessage(id, '取消我');
    await waitFor(c.approvalRequests, 1);

    handle.hub.abort(id);
    await waitFor(c.approvalSettled, 1);
    expect(c.approvalSettled[0]!).toMatchObject({ allowed: false, reason: 'cancelled' });
    await waitForTurnEnds(c, 1);
    expect(c.turnEnds[0]!.stopReason).toBe('cancelled');
  });
});

describe('端口锁（~/.harness2/serve.lock）', () => {
  it('首实例持锁（写 pid/port）；第二实例拒绝启动（携带 holder 信息）', async () => {
    const home = tmpDir('h2-serve-home-');
    const handle = await start({ home });
    const lockPath = serveLockPath(home);
    expect(existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(handle.port);

    await expect(start({ home })).rejects.toBeInstanceOf(ServeLockError);
    // in-process 重复取锁同样拒绝
    expect(() => acquireServeLock(handle.port, home)).toThrowError(ServeLockError);
  });

  it('陈旧锁（持有进程已死）接管；close 释放锁后可重新启动', async () => {
    const home = tmpDir('h2-serve-home-');
    const lockPath = serveLockPath(home);
    mkdirSync(join(home, '.harness2'), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 40, port: 1, ts: 'stale' }), 'utf8');

    const handle = await start({ home });
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid); // 接管

    await handle.close();
    expect(existsSync(lockPath)).toBe(false); // 释放

    const again = await start({ home });
    expect(again.port).toBeGreaterThan(0);
  });

  it('崩溃安全：服务重启后 /events 全量重放恢复（turn 事件由日志兜底）', async () => {
    const home = tmpDir('h2-serve-home-');
    const root = tmpDir('h2-serve-root-');
    const { c, hooks } = captureHooks();
    const first = await start({
      home,
      root,
      hooks,
      provider: new MockProvider([{ textChunks: ['重启前回复', '第二段'] }]),
    });
    const id = (await api(first, 'POST', '/api/sessions', { cwd: root })).json.id as string;
    first.hub.sendUserMessage(id, '重启前消息');
    await waitForTurnEnds(c, 1);
    const before = await api(first, 'GET', `/api/sessions/${id}/events`);
    await first.close();
    handles.splice(handles.indexOf(first), 1);

    // "重启"：同 home/root 新服务实例（模拟崩溃后的新进程）
    const second = await start({ home, root });
    const after = await api(second, 'GET', `/api/sessions/${id}/events`);
    expect(after.status).toBe(200);
    expect(after.json.events).toEqual(before.json.events);
    // 恢复后的会话可继续 undo（ensureOpen 路径）
    const undo = await api(second, 'POST', `/api/sessions/${id}/undo`, { dryRun: true });
    expect(undo.status).toBe(200);
  });
});

// —— 阶段 5 补独立复审修复回归（P2） ——

describe('复审修复回归（P2）', () => {
  it('P2-2 close 进入即清排队消息：排队中的 turn 在 close 后不再执行', async () => {
    const { c, hooks } = captureHooks();
    const provider = new MockProvider([{ textChunks: ['一', '二'], chunkDelayMs: 300 }]);
    const handle = await start({ provider, hooks });
    const root = tmpDir('h2-serve-cwd-');
    const id = (await api(handle, 'POST', '/api/sessions', { cwd: root })).json.id as string;
    handle.hub.sendUserMessage(id, '第一轮'); // turn 运行中（300ms/片）
    handle.hub.sendUserMessage(id, '第二轮'); // 排队
    await handle.close();
    handles.splice(handles.indexOf(handle), 1);
    // 运行中第一轮被取消收口；排队第二轮被 close 清空，不再执行新 turn
    await waitForTurnEnds(c, 1);
    expect(c.turnEnds).toHaveLength(1);
    expect(c.turnEnds[0]!.stopReason).toBe('cancelled');
    expect(provider.consumed).toBe(1); // 第二条消息从未消耗脚本
    await sleep(200);
    expect(c.turnEnds).toHaveLength(1); // 关闭后无新 turn-end
  });

  it('P2-3 runOne 非预期异常 → 客户端收到 turn-end（stopReason=error，消息脱敏）', async () => {
    const { c, hooks } = captureHooks();
    // 注入 read 即抛错的记忆 store：resolveMemorySystem 在 runTurn 内、provider 调用前抛出
    // （非 provider 异常路径，修复前被 pump 的静默 catch 吞掉、无任何 turn-end）
    const throwingStore = {
      read: () => Promise.reject(new Error('记忆存储 IO 故障 sk-plain-secret-999999')),
    };
    const handle = await start({
      provider: new MockProvider([{ textChunks: ['不应到达'] }]),
      hooks,
      memory: { store: throwingStore as unknown as MemoryStore, mode: 'auto', nudgeInterval: 100 },
    });
    const root = tmpDir('h2-serve-cwd-');
    const id = (await api(handle, 'POST', '/api/sessions', { cwd: root })).json.id as string;
    handle.hub.sendUserMessage(id, '触发异常');
    await waitForTurnEnds(c, 1);
    expect(c.turnEnds[0]!.stopReason).toBe('error');
    const err = c.turnEnds[0]!.error ?? '';
    expect(err).toContain('记忆存储 IO 故障');
    expect(err).toContain('[REDACTED]'); // redactSecrets 已滤掉 sk- 密钥形态
    expect(err).not.toContain('sk-plain-secret-999999');
  });

  it('P2-4a 请求体超限 → 400 请求体过大（服务端停读，响应后销毁连接）', async () => {
    const handle = await start();
    const big = await fetch(`http://127.0.0.1:${handle.port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: 'x', pad: 'x'.repeat(1024 * 1024 + 64) }),
    });
    expect(big.status).toBe(400);
    expect(((await big.json()) as { error: string }).error).toContain('请求体过大');
  });

  it('P2-4b 畸形百分号编码 → 400 输入错误而非 500', async () => {
    const handle = await start();
    // 截断的 UTF-8 序列（修复前 decode URIError → 500）
    const malformed = await api(handle, 'GET', '/api/sessions/%E0%A4%A/events');
    expect(malformed.status).toBe(400);
    expect(malformed.json.error).toContain('编码非法');
  });

  it('P2-4c POST 缺 content-type → 400（JSON 接口不盲读 body）', async () => {
    const handle = await start();
    const noCt = await fetch(`http://127.0.0.1:${handle.port}/api/sessions`, {
      method: 'POST',
      body: JSON.stringify({ cwd: 'x' }),
    });
    expect(noCt.status).toBe(400);
    expect(((await noCt.json()) as { error: string }).error).toContain('content-type');
  });
});
