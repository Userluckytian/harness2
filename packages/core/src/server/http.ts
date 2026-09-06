// HTTP 控制面（服务 API 契约 v1）+ 端口锁 + serve 启动器。
// 安全边界：
//   - 只绑 127.0.0.1（listen host 固定，不暴露局域网）；
//   - 端口锁 ~/.harness2/serve.lock（复用会话锁思路：pid 存活检查，陈旧锁接管）——
//     首个实例持有，第二个 serve 实例拒绝启动（桌面端遇此可读锁文件里的 port 复用既有实例）；
//   - 脱敏：错误出口过 redactSecrets；/api/config 报告只有 key 来源标签，绝无明文 key。
// 错误约定：全部 JSON 单行 {error}（400 输入校验 / 404 未知资源或路径 / 405 方法不符 /
// 409 忙碌或锁冲突 / 500 内部错误），消息一行中文，无堆栈。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildConfigReport } from '../config/report.js';
import { loadConfig, defaultConfigPaths } from '../config/load.js';
import { readAuthFile } from '../config/auth.js';
import { redactSecrets } from '../config/redact.js';
import { createProvider } from '../provider/factory.js';
import { registerBuiltinTools } from '../tools/predefined/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { createApprovalPolicy } from '../approval/policy.js';
import { SessionManager, defaultSessionsRoot } from '../session/manager.js';
import type { ChatProvider } from '../provider/types.js';
import type { ApprovalDecision, ApprovalInput } from '../tools/types.js';
import { SessionHub, HubError, type SessionHubHooks } from './sessions.js';
import { attachWsServer, type WsPlane } from './ws.js';

/** 默认监听端口（--port 0 = 随机端口，桌面端固定用 0） */
export const DEFAULT_SERVE_PORT = 46213;

/** 请求体大小上限（1 MiB；聊天文本远小于此） */
const MAX_BODY_BYTES = 1024 * 1024;

// —— 端口锁 ——

export const SERVE_LOCK_FILE = 'serve.lock';

export interface ServeLockContent {
  pid: number;
  port: number;
  ts: string;
}

export function serveLockPath(home?: string): string {
  return join(home ?? homedir(), '.harness2', SERVE_LOCK_FILE);
}

/** 进程存活检查（与会话锁同思路：EPERM = 存在但无权限发信号，视为存活） */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 端口锁被存活实例持有时抛出（携带 holder 信息，供桌面端复用既有实例） */
export class ServeLockError extends Error {
  constructor(
    readonly holderPid: number | null,
    readonly holderPort: number | null,
  ) {
    super(
      `serve 端口锁被占用（pid ${holderPid ?? '未知'}${holderPort !== null ? `, port ${holderPort}` : ''}）；如需接管请先停止既有 harness2 serve`,
    );
    this.name = 'ServeLockError';
  }
}

function readServeLock(path: string): ServeLockContent | null {
  if (!existsSync(path)) return null;
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServeLockContent>;
    if (typeof obj.pid !== 'number' || typeof obj.port !== 'number') return null;
    return { pid: obj.pid, port: obj.port, ts: typeof obj.ts === 'string' ? obj.ts : '' };
  } catch {
    return null; // 损坏锁 = 陈旧锁
  }
}

/**
 * 获取端口锁（listen 成功后调用）：持有者存活 → ServeLockError；
 * 陈旧/损坏锁 → 接管。返回 release（close 时删除锁文件；已不存在则静默）。
 */
export function acquireServeLock(port: number, home?: string): { release(): void } {
  const path = serveLockPath(home);
  const existing = readServeLock(path);
  if (existing && isPidAlive(existing.pid)) {
    throw new ServeLockError(existing.pid, existing.port);
  }
  mkdirSync(dirname(path), { recursive: true }); // ~/.harness2 链缺失时自动创建（与会话布局一致）
  writeFileSync(
    path,
    JSON.stringify({ pid: process.pid, port, ts: new Date().toISOString() } satisfies ServeLockContent),
    'utf8',
  );
  return {
    release(): void {
      try {
        unlinkSync(path);
      } catch {
        // 已被接管/删除：忽略
      }
    },
  };
}

// —— 启动器 ——

export interface StartServeOptions {
  /** 监听端口（默认 46213；0 = 随机可用端口） */
  port?: number;
  /** 工具执行 cwd + 新会话分组目录（默认 process.cwd()） */
  root?: string;
  /** 用户数据根：配置/会话存储/端口锁（默认用户 home；测试注入） */
  home?: string;
  /** 注入 provider（测试/mock）；缺省按配置 roles.main 构造（无配置抛错） */
  provider?: ChatProvider;
  /** 注入审批决策（缺省 = config.approval 策略；无注入且无配置 = allow-all） */
  decide?: (input: ApprovalInput) => ApprovalDecision;
  /** 审批等待超时 ms（默认 120_000） */
  approvalTimeoutMs?: number;
  /** hub 观察钩子透传（WS 事件面 / 测试用） */
  hooks?: SessionHubHooks;
}

export interface ServeHandle {
  /** 实际监听端口（--port 0 时为随机分配值） */
  port: number;
  hub: SessionHub;
  server: Server;
  /** WS 事件面（路径 /ws） */
  ws: WsPlane;
  /** 优雅关闭：取消运行中 turn → 拒绝待审批 → 关 hub → 关 WS → 关 HTTP → 释放端口锁 */
  close(): Promise<void>;
}

/** 配置不可用等启动期错误（CLI 一行输出 exit 1） */
export class ServeStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServeStartError';
  }
}

/**
 * 启动会话服务：构造 hub（provider/工具/审批策略）→ listen 127.0.0.1:port → 取端口锁。
 * 锁被存活实例持有 → 关闭 listener 并抛 ServeLockError（不留半启动状态）。
 */
export async function startServe(options: StartServeOptions = {}): Promise<ServeHandle> {
  const root = options.root ?? process.cwd();
  const home = options.home;
  const port = options.port ?? DEFAULT_SERVE_PORT;

  let provider = options.provider;
  let decide = options.decide;
  if (provider === undefined) {
    const loaded = loadConfig({ root, ...(home !== undefined ? { home } : {}) });
    if (loaded.config === null) {
      throw new ServeStartError(loaded.errors[0] ?? 'config 未加载成功（无可用配置）');
    }
    const paths = defaultConfigPaths(root, home);
    provider = createProvider(loaded.config, 'main', { authPath: paths.globalAuth });
    const policy = createApprovalPolicy(loaded.config.approval);
    decide ??= (input) => policy.decide(input);
  }

  const tools = new ToolRegistry();
  registerBuiltinTools(tools);
  const hub = new SessionHub({
    manager: new SessionManager(defaultSessionsRoot(home)),
    provider,
    tools,
    cwd: root,
    ...(decide !== undefined ? { decide } : {}),
    ...(options.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: options.approvalTimeoutMs } : {}),
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
  });

  const server = createServer((req, res) => {
    void handleRequest(hub, { root, home }, req, res).catch(() => {
      // handleRequest 内部已兜底；这里防御 handler 本身抛错
      if (!res.headersSent) sendJson(res, 500, { error: '内部错误' });
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const actualPort = (server.address() as { port: number }).port;

  let lock: { release(): void };
  try {
    lock = acquireServeLock(actualPort, home);
  } catch (e) {
    hub.close().catch(() => {});
    server.close();
    throw e;
  }

  // WS 事件面与 HTTP 共用监听（upgrade 升级到 /ws）
  const ws = attachWsServer(server, hub);

  return {
    port: actualPort,
    hub,
    server,
    ws,
    async close(): Promise<void> {
      await hub.close();
      await ws.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      lock.release();
    },
  };
}

// —— 请求处理 ——

interface ServeEnv {
  root: string;
  home?: string;
}

async function handleRequest(hub: SessionHub, env: ServeEnv, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    await route(hub, env, req, res, url.pathname);
  } catch (e) {
    if (e instanceof HubError) {
      sendJson(res, hubErrorStatus(e.code), { error: redactSecrets(e.message) });
      return;
    }
    sendJson(res, 500, { error: redactSecrets(`内部错误: ${(e as Error)?.message ?? String(e)}`) });
  }
}

function hubErrorStatus(code: HubError['code']): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'locked':
    case 'busy':
      return 409;
    case 'invalid':
      return 400;
  }
}

async function route(hub: SessionHub, env: ServeEnv, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  // GET /api/sessions?cwd=
  if (pathname === '/api/sessions' && req.method === 'GET') {
    const cwd = urlQueryParam(req, 'cwd');
    sendJson(res, 200, { sessions: hub.list(cwd) });
    return;
  }
  // POST /api/sessions {cwd}
  if (pathname === '/api/sessions' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const cwd = body['cwd'];
    sendJson(res, 200, hub.create(requireNonEmptyString(cwd, 'cwd')));
    return;
  }
  if (pathname === '/api/sessions') {
    sendJson(res, 405, { error: `方法 ${req.method} 不被支持（可用：GET/POST /api/sessions）` });
    return;
  }
  // /api/sessions/:id/*
  const sessionMatch = /^\/api\/sessions\/([^/]+)(\/events|\/undo|\/redo)?$/.exec(pathname);
  if (sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]!);
    const sub = sessionMatch[2] ?? '';
    if (sub === '/events' && req.method === 'GET') {
      sendJson(res, 200, hub.events(id));
      return;
    }
    if (sub === '/undo' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const n = body['n'] === undefined ? undefined : requireUndoN(body['n']);
      const dryRun = body['dryRun'] === undefined ? undefined : requireBoolean(body['dryRun'], 'dryRun');
      sendJson(
        res,
        200,
        hub.undo(id, {
          ...(n !== undefined ? { n } : {}),
          ...(dryRun !== undefined ? { dryRun } : {}),
        }),
      );
      return;
    }
    if (sub === '/redo' && req.method === 'POST') {
      sendJson(res, 200, hub.redo(id));
      return;
    }
    if (sub === '') {
      sendJson(res, 405, { error: `方法 ${req.method} 不被支持（可用：GET /api/sessions/:id/events）` });
      return;
    }
    sendJson(res, 405, { error: `方法 ${req.method} 不被支持` });
    return;
  }
  // GET /api/config（脱敏报告，config check 同源）
  if (pathname === '/api/config') {
    if (req.method === 'GET') {
      sendJson(res, 200, buildConfigPayload(env));
      return;
    }
    sendJson(res, 405, { error: `方法 ${req.method} 不被支持（可用：GET /api/config）` });
    return;
  }
  sendJson(res, 404, { error: `not found: ${req.method} ${pathname}` });
}

/** /api/config 载荷：loadConfig + readAuthFile（与 config check 同源），报告只含来源标签 */
function buildConfigPayload(env: ServeEnv): Record<string, unknown> {
  const paths = defaultConfigPaths(env.root, env.home);
  const loaded = loadConfig({
    root: env.root,
    ...(env.home !== undefined ? { home: env.home } : {}),
    globalPath: paths.globalConfig,
    projectPath: paths.projectConfig,
  });
  const auth = readAuthFile(paths.globalAuth);
  const errors = [...loaded.errors, ...(auth.error ? [auth.error] : [])];
  const base = {
    ok: errors.length === 0 && loaded.config !== null,
    errors,
    warnings: loaded.warnings,
    sources: loaded.sources,
    globalConfigPath: paths.globalConfig,
    projectConfigPath: paths.projectConfig,
  };
  if (!base.ok || loaded.config === null) return base;
  return { ...base, report: buildConfigReport(loaded.config, auth.auth) };
}

// —— 小工具 ——

function urlQueryParam(req: IncomingMessage, name: string): string | undefined {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const v = url.searchParams.get(name);
  return v !== null && v.length > 0 ? v : undefined;
}

function requireNonEmptyString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new HubError('invalid', `${name} 必须是非空字符串`);
  }
  return v;
}

function requireUndoN(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100) {
    throw new HubError('invalid', 'n 必须是 1..100 的整数');
  }
  return v;
}

function requireBoolean(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') throw new HubError('invalid', `${name} 必须是布尔值`);
  return v;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HubError('invalid', '请求体过大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          reject(new HubError('invalid', '请求体必须是 JSON 对象'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HubError('invalid', '请求体不是合法 JSON'));
      }
    });
    req.on('error', (e) => reject(new HubError('invalid', `请求读取失败: ${(e as Error).message}`)));
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
