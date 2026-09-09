// FixA S7 四契约真接线：桌面可查询只读接口（经 serve 端点真实查询，非纯函数自测）。
// 验收证据 = 真实 startServe + HTTP 请求命中四个只读端点：
//   GET /api/session/:id/run-config      → effectiveRunConfig（脱敏 + 深度冻结）
//   GET /api/session/:id/plan-state      → planState（账本重建，只读，不放行审批）
//   GET /api/session/:id/execution-view  → toolExecutionView（真实 shell/exitCode 归属）
//   GET /api/session/:id/change-review   → changeReview（外部修改标 dirty 不静默覆盖）
// 全部本地临时目录 + startServe（127.0.0.1 随机端口），无网络；原纯函数单元测试保留。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MockProvider, startServe, type ServeHandle } from '../src/index.js';
import { RuntimeJournal } from '../src/interaction/runtime-journal.js';
import type { WsServerMessage } from '../src/server/ws.js';

const dirs: string[] = [];
const handles: ServeHandle[] = [];
function tmpDir(prefix = 'h2-fq-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 实际 shell（Windows = %ComSpec%；POSIX = /bin/sh）——与 hub 记录来源同口径 */
function detectShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec ?? 'cmd.exe';
  return '/bin/sh';
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

async function createSession(handle: ServeHandle, cwd: string): Promise<string> {
  const { status, json } = await api(handle, 'POST', '/api/sessions', { cwd });
  expect(status).toBe(200);
  return json.id as string;
}

/** 最小 WS 客户端：发送 user-message 驱动真实 turn，等待 turn-end */
class WsClient {
  readonly frames: WsServerMessage[] = [];
  readonly ws: WebSocket;
  readonly open: Promise<void>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.open = new Promise<void>((resolveOpen, reject) => {
      this.ws.addEventListener('open', () => resolveOpen());
      this.ws.addEventListener('error', () => reject(new Error('ws 连接失败')));
    });
    this.ws.addEventListener('message', (ev) => {
      this.frames.push(JSON.parse(String(ev.data)) as WsServerMessage);
    });
  }
  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }
  close(): void {
    this.ws.close();
  }
  async waitFor(pred: (f: WsServerMessage) => boolean, description: string): Promise<WsServerMessage> {
    for (let i = 0; i < 500; i++) {
      const found = this.frames.find(pred);
      if (found) return found;
      await sleep(10);
    }
    throw new Error(`等待帧超时: ${description}`);
  }
}

/** 带 config/auth 的 home（真实装配路径：providerMeta/审批策略/容量从 config 派生） */
function writeConfigHome(home: string): void {
  const cfgDir = join(home, '.harness2');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      providers: {
        ds: {
          protocol: 'openai',
          baseUrl: 'https://api.test/v1',
          envKey: 'DS_KEY',
          models: { 'm-1': { contextWindow: 128000, maxOutputTokens: 4096 } },
        },
      },
      roles: { main: { channel: 'ds', model: 'm-1' } },
      approval: { mode: 'default', tools: { write: 'ask' } },
      memory: { mode: 'off', nudgeInterval: 10 },
    }),
    'utf8',
  );
  writeFileSync(
    join(cfgDir, 'auth.json'),
    JSON.stringify({ channels: { ds: { apiKey: 'sk-plain-secret-987654' } } }),
    'utf8',
  );
}

const SENSITIVE_NAMES = new Set([
  'apikey',
  'api_key',
  'api-key',
  'key',
  'token',
  'secret',
  'password',
  'authorization',
]);
function assertNoSensitiveKeys(value: unknown, path = 'json'): void {
  if (value === null || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    expect(SENSITIVE_NAMES.has(k.toLowerCase()), `${path}.${k} 是敏感字段名，不应出现在只读查询响应`).toBe(false);
    assertNoSensitiveKeys(v, `${path}.${k}`);
  }
}

describe('FixA /run-config：有效运行配置真接线（装配来源 + root/cwd 不串 + 脱敏）', () => {
  it('provider/模型/角色/审批/容量来自 hub 装配；两 session 各自查到自己的 cwd；两个不同 root 不串', async () => {
    const homeA = tmpDir('h2-fq-homeA-');
    const homeB = tmpDir('h2-fq-homeB-');
    writeConfigHome(homeA);
    writeConfigHome(homeB);
    const rootA = tmpDir('h2-fq-rootA-');
    const rootB = tmpDir('h2-fq-rootB-');
    const cwdA = tmpDir('h2-fq-cwdA-');
    const cwdB = tmpDir('h2-fq-cwdB-');
    const cwdC = tmpDir('h2-fq-cwdC-');
    const serveA = await startServe({ port: 0, home: homeA, root: rootA });
    const serveB = await startServe({ port: 0, home: homeB, root: rootB });
    handles.push(serveA, serveB);
    const idA = await createSession(serveA, cwdA);
    const idB = await createSession(serveA, cwdB);
    const idC = await createSession(serveB, cwdC);

    // —— 端点真实命中（HTTP 查询） ——
    const a = await api(serveA, 'GET', `/api/session/${idA}/run-config`);
    expect(a.status).toBe(200);
    expect(a.json.redacted).toBe(true);
    // root/cwd 归属：A 会话 cwd = cwdA，root = rootA
    expect(a.json.session.sessionId).toBe(idA);
    expect(a.json.session.root).toBe(resolve(rootA));
    expect(a.json.session.cwd).toBe(resolve(cwdA));
    expect(a.json.session.perSessionCwd).toBe(true);
    // provider/模型/角色来自 hub 装配（config 派生）
    expect(a.json.provider).toEqual({
      role: 'main',
      channel: 'ds',
      model: 'm-1',
      protocol: 'openai',
      name: 'ds/m-1',
    });
    // 审批策略/容量来自装配
    expect(a.json.approval).toEqual({ mode: 'default', tools: { write: 'ask' } });
    expect(a.json.modes.memory).toBe('off');
    expect(a.json.context.contextWindow).toBe(128000);
    expect(a.json.context.maxOutputTokens).toBe(4096);
    // 工具集来自装配集（含 bash/write）
    expect(a.json.tools).toContain('bash');
    expect(a.json.tools).toContain('write');
    expect(a.json.connection.status).toBe('unknown');
    expect(a.json.snapshot.revision).toBe(0);

    // B 会话（同 serve，不同 cwd）：cwd 不串
    const b = await api(serveA, 'GET', `/api/session/${idB}/run-config`);
    expect(b.status).toBe(200);
    expect(b.json.session.cwd).toBe(resolve(cwdB));
    expect(b.json.session.root).toBe(resolve(rootA));
    expect(b.json.session.cwd).not.toBe(resolve(cwdA));

    // C 会话（另一 serve，不同 root）：root/cwd 各自归属
    const c = await api(serveB, 'GET', `/api/session/${idC}/run-config`);
    expect(c.status).toBe(200);
    expect(c.json.session.root).toBe(resolve(rootB));
    expect(c.json.session.cwd).toBe(resolve(cwdC));
    expect(c.json.session.root).not.toBe(resolve(rootA));

    // —— 脱敏：响应无 sk- 形态密钥、无敏感字段名 ——
    const json = JSON.stringify(a.json);
    expect(json).not.toContain('sk-plain-secret-987654');
    expect(json).not.toMatch(/sk-[A-Za-z0-9_-]{6,}/);
    assertNoSensitiveKeys(a.json);

    // —— 深度冻结（hub 装配视图本身不可改写；HTTP 序列化同一对象） ——
    const view = serveA.hub.runConfigView(idA);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.session)).toBe(true);
    expect(Object.isFrozen(view.tools)).toBe(true);
    expect(Object.isFrozen(view.context.retry)).toBe(true);

    // —— 错误帧：会话不存在 404 / 非法格式 400 / 方法不符 405 ——
    const unknown = await api(serveA, 'GET', '/api/sessions/20990101-000000-000000/run-config');
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toContain('session not found');
    const traversal = await api(serveA, 'GET', '/api/sessions/%2e%2e%2Fx/run-config');
    expect(traversal.status).toBe(400);
    expect(traversal.json.error).toContain('会话 id');
    const badMethod = await api(serveA, 'POST', `/api/sessions/${idA}/run-config`, {});
    expect(badMethod.status).toBe(405);
  });
});

describe('FixA /plan-state：账本重建只读 + 展示不触发审批放行', () => {
  it('真实 startServe：种 task/transition 账本 → 端点重建计划；查询不改 journal；挂起审批不被展示放行', async () => {
    const handle = await startServe({
      port: 0,
      home: tmpDir('h2-fq-home-'),
      root: tmpDir('h2-fq-root-'),
      provider: new MockProvider([
        {
          toolCalls: [
            { id: 'call-w', name: 'write', arguments: JSON.stringify({ file_path: 'hello.txt', content: 'v2' }) },
          ],
        },
        { textChunks: ['完成'] },
      ]),
      decide: () => 'ask',
    });
    handles.push(handle);
    const cwd = tmpDir('h2-fq-plan-cwd-');
    const id = await createSession(handle, cwd);
    const dir = handle.hub.locate(id);

    // 种账本：root 完成 + child 停在 waiting-approval（计划不放宽权限场景）
    const journal = RuntimeJournal.create(dir, { fsync: false });
    try {
      const tx = (taskId: string, parentTaskId: string | undefined, from: string, to: string): void => {
        journal.append({
          kind: 'task/transition',
          taskId,
          ...(parentTaskId !== undefined ? { parentTaskId } : {}),
          from: from as never,
          to: to as never,
        });
      };
      tx('task-root', undefined, 'registered', 'queued');
      tx('task-root', undefined, 'queued', 'starting');
      tx('task-root', undefined, 'starting', 'running');
      tx('task-root', undefined, 'running', 'completed');
      tx('task-child', 'task-root', 'registered', 'queued');
      tx('task-child', 'task-root', 'queued', 'starting');
      tx('task-child', 'task-root', 'starting', 'running');
      tx('task-child', 'task-root', 'running', 'waiting-approval');
    } finally {
      journal.close();
    }

    // 触发真实 ask 审批挂起（write 工具进等待）
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    const settled: Array<{ requestId: string; allowed: boolean }> = [];
    handle.hub.addHooks({ onApprovalSettled: (requestId, allowed) => settled.push({ requestId, allowed }) });
    client.send({ op: 'subscribe', sessionId: id });
    client.send({ op: 'user-message', sessionId: id, text: '写入一个文件' });
    let requestId = '';
    for (let i = 0; i < 500 && requestId === ''; i++) {
      await sleep(10);
      requestId = handle.hub.listPendingApprovals()[0]?.requestId ?? '';
    }
    expect(requestId.length).toBeGreaterThan(0);

    // —— 端点真实命中：账本重建计划（含 waiting-approval 步骤） ——
    const lineCountBefore = RuntimeJournal.readEntries(dir).watermark.lineCount;
    const plan = await api(handle, 'GET', `/api/session/${id}/plan-state`);
    expect(plan.status).toBe(200);
    expect(plan.json.readOnly).toBe(true);
    expect(plan.json.planId).toBe('task-root');
    expect(plan.json.steps.map((s: { stepId: string }) => s.stepId)).toEqual(['task-root', 'task-child']);
    expect(plan.json.steps.find((s: { stepId: string }) => s.stepId === 'task-child').state).toBe('waiting-approval');
    // 证据 id：每一步都可指回 journal task/transition seq
    for (const step of plan.json.steps) {
      expect(step.evidence.source).toBe('runtime-journal');
      expect(step.evidence.taskId).toBe(step.stepId);
      expect(step.evidence.journalSeqs.length).toBeGreaterThan(0);
    }
    // —— 只读：查询不改 journal ——
    expect(RuntimeJournal.readEntries(dir).watermark.lineCount).toBe(lineCountBefore);
    // —— 展示计划不触发审批放行：挂起审批仍在队列、未落定 ——
    expect(handle.hub.listPendingApprovals().map((a) => a.requestId)).toContain(requestId);
    expect(settled).toEqual([]);
    // 再次查询 run-config/plan-state 也不放行
    await api(handle, 'GET', `/api/session/${id}/run-config`);
    await api(handle, 'GET', `/api/session/${id}/plan-state`);
    expect(handle.hub.listPendingApprovals().map((a) => a.requestId)).toContain(requestId);
    expect(settled).toEqual([]);

    // 清理：放行让 turn 收尾
    client.send({ op: 'approval-response', requestId, decision: 'allow' });
    await client.waitFor((f) => f.type === 'turn-end', 'turn-end');
    client.close();
  });

  it('无账本 → 明确 error 帧 404（会话暂无计划数据），不臆造空计划', async () => {
    const handle = await startServe({
      port: 0,
      home: tmpDir('h2-fq-home-'),
      root: tmpDir('h2-fq-root-'),
      provider: new MockProvider([{ textChunks: ['回复'] }]),
    });
    handles.push(handle);
    const id = await createSession(handle, tmpDir('h2-fq-no-plan-cwd-'));
    const res = await api(handle, 'GET', `/api/session/${id}/plan-state`);
    expect(res.status).toBe(404);
    expect(res.json.error).toContain('暂无计划数据');
  });
});

describe('FixA /execution-view：真实 shell/exitCode 归属 + cwd 归属 + 脱敏', () => {
  it('真实 serve turn 执行 bash（exit 7 + 输出含密钥）→ 端点如实归属 shell/exitCode，密钥被脱敏', async () => {
    const handle = await startServe({
      port: 0,
      home: tmpDir('h2-fq-home-'),
      root: tmpDir('h2-fq-root-'),
      provider: new MockProvider([
        {
          toolCalls: [
            {
              id: 'call-bash',
              name: 'bash',
              arguments: JSON.stringify({
                command: `node -e "console.log('marker-exec-view'); console.log('sk-abcdefgh123456'); process.exit(7)"`,
              }),
            },
          ],
        },
        { textChunks: ['完成'] },
      ]),
      decide: () => 'allow',
    });
    handles.push(handle);
    const cwd = tmpDir('h2-fq-exec-cwd-');
    const id = await createSession(handle, cwd);
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.send({ op: 'subscribe', sessionId: id });
    client.send({ op: 'user-message', sessionId: id, text: '执行命令' });
    await client.waitFor((f) => f.type === 'turn-end', 'turn-end');
    client.close();

    // —— 端点真实命中：视图含真实 bash 归属 ——
    const res = await api(handle, 'GET', `/api/session/${id}/execution-view`);
    expect(res.status).toBe(200);
    const views = res.json.views as any[];
    const view = views.find((v) => v.callId === 'call-bash');
    expect(view).toBeTruthy();
    expect(view.tool).toBe('bash');
    expect(view.commandSource).toBe('executed'); // 真正启动
    expect(view.actualCommand).toContain('process.exit(7)');
    expect(view.cwd).toBe(resolve(cwd)); // cwd 归属该会话
    expect(view.shell).toBe(detectShell()); // 真实 shell（记录来源）
    expect(view.status).toBe('failed');
    expect(view.exitCode).toBe(7); // 真实退出码（bash-error 归属）
    expect(view.exitCodeSource).toBe('bash-error');
    expect(view.outputRef).toContain('marker-exec-view');
    expect(view.outputRef).not.toContain('sk-abcdefgh123456'); // 脱敏
    expect(view.readOnly).toBe(true);
    const json = JSON.stringify(res.json);
    expect(json).not.toMatch(/sk-[A-Za-z0-9_-]{6,}/);
    assertNoSensitiveKeys(res.json);

    // 深度冻结（hub 装配视图）
    const viewsInProcess = handle.hub.executionViews(id);
    expect(Object.isFrozen(viewsInProcess[0])).toBe(true);

    // 错误帧：未知会话 404
    const unknown = await api(handle, 'GET', '/api/sessions/20990101-000000-000000/execution-view');
    expect(unknown.status).toBe(404);
  });
});

describe('FixA /change-review：外部修改标 dirty 不静默覆盖', () => {
  it('真实 serve turn 写文件 → 端点 changeSet；外部修改后 dirty=true、matchesPlan=false、不覆盖', async () => {
    const handle = await startServe({
      port: 0,
      home: tmpDir('h2-fq-home-'),
      root: tmpDir('h2-fq-root-'),
      provider: new MockProvider([
        {
          toolCalls: [
            { id: 'call-w', name: 'write', arguments: JSON.stringify({ file_path: 'hello.txt', content: 'v2' }) },
          ],
        },
        { textChunks: ['完成'] },
      ]),
      decide: () => 'allow',
    });
    handles.push(handle);
    const cwd = tmpDir('h2-fq-review-cwd-');
    const id = await createSession(handle, cwd);
    const file = join(cwd, 'hello.txt');
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.send({ op: 'subscribe', sessionId: id });
    client.send({ op: 'user-message', sessionId: id, text: '写入一个文件' });
    await client.waitFor((f) => f.type === 'turn-end', 'turn-end');
    client.close();
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('v2');

    // —— 干净态：拟议 = 真实落盘 ——
    const clean = await api(handle, 'GET', `/api/session/${id}/change-review`);
    expect(clean.status).toBe(200);
    expect(clean.json.readOnly).toBe(true);
    expect(clean.json.changedFiles).toBe(1);
    expect(clean.json.dirtyFiles).toBe(0);
    expect(clean.json.files[0]).toMatchObject({
      file: resolve(file),
      planned: { before: null, after: 'v2' },
      current: 'v2',
      lastKnown: 'v2',
      dirty: false,
      matchesPlan: true,
    });

    // —— 外部修改：标 dirty、拟议与真实分离、不静默覆盖 ——
    writeFileSync(file, 'v3', 'utf8');
    const dirty = await api(handle, 'GET', `/api/session/${id}/change-review`);
    expect(dirty.status).toBe(200);
    expect(dirty.json.changedFiles).toBe(1);
    expect(dirty.json.dirtyFiles).toBe(1);
    expect(dirty.json.files[0]).toMatchObject({
      planned: { before: null, after: 'v2' },
      current: 'v3',
      lastKnown: 'v2',
      dirty: true,
      matchesPlan: false,
    });
    // 端点查询不触发恢复/覆盖：外部内容原样保留
    expect(readFileSync(file, 'utf8')).toBe('v3');

    // 深度冻结（hub 装配视图）
    expect(Object.isFrozen(handle.hub.changeReviewView(id))).toBe(true);
  });
});
