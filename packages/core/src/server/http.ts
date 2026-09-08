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
import { resolveCompactionOptions } from '../agent/compaction.js';
import type { CompactionOptions } from '../agent/types.js';
import { getSharedBrowserPool } from '../tools/predefined/browser.js';
import { registerBuiltinTools } from '../tools/predefined/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { createApprovalPolicy } from '../approval/policy.js';
import { defaultMemoriesRoot, MemoryStore } from '../memory/store.js';
import { defaultPendingRoot, PendingMemoryStore } from '../memory/pending.js';
import { defaultSkillsRoot, projectSkillsRoot, SkillStore } from '../skills/store.js';
import { createSkillTool } from '../skills/tool.js';
import { SessionManager, defaultSessionsRoot } from '../session/manager.js';
import { CronScheduler, type CronFinishedFrame } from '../cron/scheduler.js';
import { defaultCronRoot } from '../cron/jobs.js';
import { PluginBus } from '../plugins/bus.js';
import { defaultPluginsRoot } from '../plugins/loader.js';
import { McpManager } from '../mcp/client.js';
import type { SessionHubSubagent } from './sessions.js';
import type { ChatProvider } from '../provider/types.js';
import type { ApprovalDecision, ApprovalInput } from '../tools/types.js';
import { SessionHub, HubError, type SessionHubHooks, type SessionHubMemory } from './sessions.js';
import { attachWsServer, type WsPlane } from './ws.js';
import { isTrustedHost, isTrustedOrigin, normalizeOriginHeader } from './trust.js';

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
  /** 注入记忆装配（mode ≠ off；mock/测试用）。缺省：配置加载成功时按 config.memory 派生 */
  memory?: SessionHubMemory;
  /** 注入上下文压缩装配（阶段 7；mock/测试用）。缺省：配置加载成功时按 roles.main 容量 + roles.small 派生 */
  compaction?: CompactionOptions;
  /** 注入浏览器装配（阶段 7；mock/测试用）。缺省：配置加载成功且 browser.enabled 时用共享池派生 */
  browser?: { pool: ReturnType<typeof getSharedBrowserPool> };
  /** 注入插件装配（阶段 8；mock/测试用）。缺省：config.plugins.enabled 时扫描装载 allow 名单 */
  plugins?: { bus: PluginBus };
  /** 注入 MCP 装配（阶段 8；mock/测试用）。缺省：config.mcpServers 非空时逐 server 连接 */
  mcp?: { manager: McpManager };
  /** 注入 subagent 装配（阶段 8；mock/测试用）。缺省：config.subagent 派生（provider 取 roles.subagent，缺失回退主） */
  subagent?: SessionHubSubagent;
  /** 注入 Skills 商店（阶段 10；mock/测试用）。缺省：项目 .harness2/skills/ + 全局 ~/.harness2/skills/ 两级派生 */
  skills?: SkillStore;
  /** hub 观察钩子透传（WS 事件面 / 测试用） */
  hooks?: SessionHubHooks;
  /** S3c1 → S3c2 接线缝：resume/cancel/submit 实际状态提供者（缺省未接线 → unknown/error） */
  resumeState?: import('./ws.js').ResumeStateProvider;
}

export interface ServeHandle {
  /** 实际监听端口（--port 0 时为随机分配值） */
  port: number;
  hub: SessionHub;
  server: Server;
  /** WS 事件面（路径 /ws） */
  ws: WsPlane;
  /** 定时任务调度器（serve 常驻 tick；close 时一并停止） */
  cron: CronScheduler;
  /** 插件总线（未启用插件时 undefined；close 时 dispose——工具/订阅逆序展开） */
  plugins?: PluginBus;
  /** MCP 管理器（未配置 server 时 undefined；close 时全部连接关闭 + 工具下线） */
  mcp?: McpManager;
  /** 优雅关闭：停止调度器 → 取消运行中 turn → 拒绝待审批 → 关 hub → 关 WS → 关 HTTP → 释放端口锁 */
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

  // 共享工具注册表（本地 → 插件 → MCP → subagent 的装配基底）
  const tools = new ToolRegistry();
  registerBuiltinTools(tools);

  // Skills 装配（阶段 10）：无 config 开关，两级目录按需读盘（空目录 = 零注入）；
  // skill 工具注册进共享注册表（turn 工具集随之携带，全文现读磁盘）
  let skills: SkillStore | undefined = options.skills;
  if (skills === undefined) {
    skills = new SkillStore(projectSkillsRoot(root), defaultSkillsRoot(home));
  }
  tools.register(createSkillTool(skills));

  let provider = options.provider;
  let decide = options.decide;
  let memory: SessionHubMemory | undefined = options.memory;
  let compaction: CompactionOptions | undefined = options.compaction;
  let browser: { pool: ReturnType<typeof getSharedBrowserPool> } | undefined = options.browser;
  let plugins: { bus: PluginBus } | undefined = options.plugins;
  let mcp: { manager: McpManager } | undefined = options.mcp;
  let subagent: SessionHubSubagent | undefined = options.subagent;
  let configWarnings: string[] = [];
  if (provider === undefined) {
    const loaded = loadConfig({ root, ...(home !== undefined ? { home } : {}) });
    if (loaded.config === null) {
      throw new ServeStartError(loaded.errors[0] ?? 'config 未加载成功（无可用配置）');
    }
    const paths = defaultConfigPaths(root, home);
    provider = createProvider(loaded.config, 'main', { authPath: paths.globalAuth });
    const policy = createApprovalPolicy(loaded.config.approval);
    decide ??= (input) => policy.decide(input);
    configWarnings = [...loaded.warnings];
    // 记忆装配：mode ≠ off 时派生（roles.small 复盘 provider；缺失回退主 provider）
    if (memory === undefined && loaded.config.memory.mode !== 'off') {
      const store = new MemoryStore(defaultMemoriesRoot(home));
      let reviewProvider: ChatProvider = provider;
      try {
        reviewProvider = createProvider(loaded.config, 'small', { authPath: paths.globalAuth });
      } catch {
        // roles.small 未配置 → 主 provider 兼任复盘（如实降级）
      }
      const mode = loaded.config.memory.mode;
      memory = {
        store,
        mode,
        nudgeInterval: loaded.config.memory.nudgeInterval,
        reviewProvider,
        ...(mode === 'ask' ? { pending: new PendingMemoryStore(defaultPendingRoot(home), store) } : {}),
      };
    }
    // 压缩装配（阶段 7）：contextWindow = roles.main 模型容量声明；摘要 provider = roles.small（缺失回落主）
    if (compaction === undefined) {
      let smallProvider: ChatProvider | undefined;
      try {
        smallProvider = createProvider(loaded.config, 'small', { authPath: paths.globalAuth });
      } catch {
        smallProvider = undefined; // 摘要回落主 provider（resolveCompactionOptions 不传 summarizer）
      }
      compaction = resolveCompactionOptions(loaded.config, (role) =>
        role === 'small' ? smallProvider : provider,
      );
    }
    // 浏览器装配（阶段 7）：config.browser.enabled 时用进程级共享池（资源红线参数来自配置）
    if (browser === undefined && loaded.config.browser.enabled) {
      browser = {
        pool: getSharedBrowserPool({
          idleDestroyMs: loaded.config.browser.idleDestroyMs,
          maxConcurrent: loaded.config.browser.maxConcurrent,
        }),
      };
    }
    // —— 插件装配（阶段 8）：enabled 时扫描 ~/.harness2/plugins 并按 allow 名单装载。
    //    注册顺序 = 本地 → 插件 → MCP（重名冲突时先注册者优先，冲突告警不中断）。
    if (plugins === undefined && loaded.config.plugins.enabled) {
      const bus = new PluginBus({ tools, config: loaded.config, logSink: (l) => console.error(l) });
      const report = await bus.loadAll(defaultPluginsRoot(home), loaded.config.plugins.allow);
      plugins = { bus };
      configWarnings.push(...report.warnings);
    }
    // —— MCP 装配（阶段 8）：逐 server 连接并注册 mcp__<server>__<tool> namespaced 工具。
    //    单 server 失败退避重启（上限 3），不拖垮启动；tools 注册表已被 bus/mcp 复用。
    if (mcp === undefined && Object.keys(loaded.config.mcpServers).length > 0) {
      const manager = new McpManager({ tools, logSink: (l) => console.error(l) });
      const report = await manager.connectAll(loaded.config.mcpServers);
      mcp = { manager };
      configWarnings.push(...report.warnings);
    }
    // —— subagent 装配（阶段 8）：provider 取 roles.subagent（缺失回退主）；深度红线来自 config
    if (subagent === undefined) {
      let subProvider: ChatProvider = provider;
      try {
        subProvider = createProvider(loaded.config, 'subagent', { authPath: paths.globalAuth });
      } catch {
        // roles.subagent 未配置 → 主 provider 兼任（如实降级）
      }
      subagent = {
        provider: subProvider,
        maxDepth: loaded.config.subagent.maxDepth,
        maxTurns: loaded.config.subagent.maxTurns,
      };
    }
  }

  const hub = new SessionHub({
    manager: new SessionManager(defaultSessionsRoot(home)),
    provider,
    tools,
    cwd: root,
    ...(decide !== undefined ? { decide } : {}),
    ...(memory !== undefined ? { memory } : {}),
    ...(compaction !== undefined ? { compaction } : {}),
    ...(browser !== undefined ? { browser } : {}),
    ...(subagent !== undefined ? { subagent } : {}),
    ...(plugins !== undefined ? { plugins } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(options.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: options.approvalTimeoutMs } : {}),
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
  });
  if (configWarnings.length > 0) {
    for (const w of configWarnings) console.error(`warning: ${w}`);
  }

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
  const ws = attachWsServer(
    server,
    hub,
    options.resumeState !== undefined ? { resumeState: options.resumeState } : {},
  );

  // 定时任务调度器（阶段 7）：常驻 tick + 文件锁 + at-most-once；完成帧经 WS 广播
  const cron = new CronScheduler({
    root: defaultCronRoot(home),
    cwd: root,
    provider,
    toolsForSession: (sessionKey) => hub.toolsForSession(sessionKey),
    ...(decide !== undefined ? { decide } : {}),
    onFinished: (frame: CronFinishedFrame) => ws.broadcastCron(frame),
  });
  cron.start();

  return {
    port: actualPort,
    hub,
    server,
    ws,
    cron,
    ...(plugins !== undefined ? { plugins: plugins.bus } : {}),
    ...(mcp !== undefined ? { mcp: mcp.manager } : {}),
    async close(): Promise<void> {
      await cron.stop();
      await hub.close();
      await ws.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (mcp !== undefined) await mcp.manager.close();
      if (plugins !== undefined) plugins.bus.dispose();
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
    // —— 信任域校验（一切路由之前；M2 发布前加固，Task 4）——
    // P2-5（阶段 7 审查）：重复 Origin 头可能解析为 string[]——先取首值规范化再校验，不容绕过
    const origin = normalizeOriginHeader(req.headers.origin);
    if (typeof origin === 'string' && !isTrustedOrigin(origin)) {
      sendJson(res, 403, { error: '拒绝访问：Origin 不在信任域（仅允许 file:// 与本地 http 源）' });
      return;
    }
    const port = portOfServer(req);
    if (port !== undefined && !isTrustedHost(typeof req.headers.host === 'string' ? req.headers.host : undefined, port)) {
      sendJson(res, 403, { error: '拒绝访问：Host 校验失败（仅允许 127.0.0.1:<端口>）' });
      return;
    }
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

/** 从 socket 取本机监听端口（socket 未就绪时 undefined → 跳过 Host 校验） */
function portOfServer(req: IncomingMessage): number | undefined {
  const localPort = (req.socket as { localPort?: number }).localPort;
  return typeof localPort === 'number' ? localPort : undefined;
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
    const body = await readJsonBody(req, res);
    const cwd = body['cwd'];
    sendJson(res, 200, hub.create(requireNonEmptyString(cwd, 'cwd')));
    return;
  }
  if (pathname === '/api/sessions') {
    sendJson(res, 405, { error: `方法 ${req.method} 不被支持（可用：GET/POST /api/sessions）` });
    return;
  }
  // /api/sessions/:id/*
  const sessionMatch = /^\/api\/sessions\/([^/]+)(\/events|\/undo|\/redo|\/fork)?$/.exec(pathname);
  if (sessionMatch) {
    // 复审 P2-4：畸形百分号编码（如 %E0%A4%A）decode 抛 URIError——按 400 输入错误处理，而非 500
    let id: string;
    try {
      id = decodeURIComponent(sessionMatch[1]!);
    } catch {
      throw new HubError('invalid', 'sessionId 编码非法（百分号编码畸形）');
    }
    const sub = sessionMatch[2] ?? '';
    if (sub === '/events' && req.method === 'GET') {
      sendJson(res, 200, hub.events(id));
      return;
    }
    if (sub === '/fork' && req.method === 'POST') {
      const body = await readJsonBody(req, res);
      const atSeq = body['atSeq'] === undefined ? undefined : requireAtSeq(body['atSeq']);
      sendJson(res, 200, hub.fork(id, atSeq !== undefined ? { atSeq } : {}));
      return;
    }
    if (sub === '/undo' && req.method === 'POST') {
      const body = await readJsonBody(req, res);
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

function requireAtSeq(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new HubError('invalid', 'atSeq 必须是 >= 1 的整数（上界按原会话 lastSeq 校验）');
  }
  return v;
}

function requireBoolean(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') throw new HubError('invalid', `${name} 必须是布尔值`);
  return v;
}

function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown>> {
  // 复审 P2-4：JSON 接口只接受 application/json（缺失/错误类型 400），不盲读 body
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('application/json')) {
    return Promise.reject(new HubError('invalid', 'content-type 必须是 application/json'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 复审 P2-4：超限立即停止读取（摘监听 + 背压，不再累积分片）；
        // 400 响应发出后销毁连接（请求体未读完，连接不可复用）——直接 destroy 会把 400 一并掐断
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        req.pause();
        res.once('close', () => req.destroy());
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
