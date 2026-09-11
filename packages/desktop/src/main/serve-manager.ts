// serve 子进程管理（Electron 主进程）：
//   spawn `harness2 serve --port 0`（ELECTRON_RUN_AS_NODE 复用 Electron 运行时的 node 能力，
//   打包后无需系统 node）→ 解析 stdout 一行 JSON {"port":N,"pid":M} → 健康检查 /api/config
//   → ready。运行期意外退出与启动期退出（未打印端口行）都按退避自动重启（上限+退避，
//   见 backoffDelayMs / scheduleRestart）：启动期退出仍向首次 start() 的调用方 reject
//   （提示由调用方决定），但计入同一条退避链；重启链中的 spawn 失败不再被无声吞掉，
//   而是调度下一次退避重试，达上限才 offline。
//   端口锁被既有实例占用（serve 退出码 1）→ 尝试按锁文件采纳既有实例端口。
// 纯函数（端口行解析/退避/重启决策/锁文件读取）拆出以便单测。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectionStatus, StatusDetail } from '../shared/protocol.js';

// —— 纯函数 ——

export const SERVE_LOCK_FILE = 'serve.lock';

export interface ServeLockShape {
  pid: number;
  port: number;
  ts?: string;
  /** P2：严格鉴权下的一次性 token（桌面据此携带；旧版锁文件可能无此字段） */
  token?: string;
}

/** 解析一行 serve stdout：JSON {"port":1..65535,"pid":n}；其他行返回 null */
export function parseServePortLine(line: string): ServeLockShape | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const { port, pid } = obj;
    if (
      typeof port !== 'number' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      typeof pid !== 'number' ||
      !Number.isInteger(pid)
    ) {
      return null;
    }
    return { port, pid, ...(typeof obj['ts'] === 'string' ? { ts: obj['ts'] } : {}) };
  } catch {
    return null;
  }
}

/** 从一段 stdout（可能多行/分片）提取第一处有效端口行 */
export function extractServePort(stdout: string): ServeLockShape | null {
  for (const line of stdout.split(/\r?\n/)) {
    const parsed = parseServePortLine(line);
    if (parsed) return parsed;
  }
  return null;
}

/** 重启退避：1s → 2s → 4s → 8s → 封顶 15s（attempt 从 0 计） */
export function backoffDelayMs(attempt: number, baseMs = 1000, maxMs = 15000): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt), maxMs);
}

/** 重启决策：主动 stop 不重启；其余任何退出（含端口锁冲突退出码 1、启动期退出）都按退避重试 */
export function shouldRestartChild(intentionalStop: boolean): boolean {
  return !intentionalStop;
}

/** 读取 serve.lock（损坏/缺失返回 null）——采纳既有实例端口用 */
export function readServeLock(home: string): ServeLockShape | null {
  const path = join(home, '.harness2', SERVE_LOCK_FILE);
  if (!existsSync(path)) return null;
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (typeof obj['pid'] !== 'number' || typeof obj['port'] !== 'number') return null;
    return {
      pid: obj['pid'],
      port: obj['port'],
      ...(typeof obj['ts'] === 'string' ? { ts: obj['ts'] } : {}),
      ...(typeof obj['token'] === 'string' && obj['token'].length > 0 ? { token: obj['token'] } : {}),
    };
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** stdout 累积上限：端口行解析只需头部内容，长驻进程的后续输出不无限增长（保留尾部 8KB） */
const STDOUT_TAIL_MAX_BYTES = 8 * 1024;

// —— 健康检查 ——

/**
 * 轮询 GET /api/config；**仅 2xx 视为健康**，超时抛错。
 * P2（A3 P1-2）：修复前 `res.status > 0` 把 `401` 也当健康 → 桌面显示「已连接」但所有 API/WS 失败。
 * tokenProvider 提供当前一次性 token（桌面从 serve.lock 读）：
 *   - 无 token + 401 → 继续等待（锁尚未写入的启动竞态可自愈）；
 *   - 有 token 仍 401 → token 不匹配，立即明确报错（不再干等）。
 */
export async function waitForHealth(
  port: number,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  intervalMs = 200,
  tokenProvider?: () => string | undefined,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    const token = tokenProvider?.();
    try {
      const res = await fetchImpl(
        `http://127.0.0.1:${port}/api/config`,
        token !== undefined ? { headers: { 'x-harness2-token': token } } : undefined,
      );
      if (res.status >= 200 && res.status < 300) return; // 服务已应答（ok:false = 配置未就绪，也是活的）
      if (res.status === 401 && token !== undefined) {
        throw new Error('serve 健康检查 401：token 无效（serve.lock 与实例不匹配）');
      }
      lastError = `HTTP ${res.status}（严格鉴权下需携带 serve token）`;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.startsWith('serve 健康检查 401')) throw e; // 明确错误立即上抛，不进重试
      lastError = msg;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`serve 健康检查超时（${timeoutMs}ms）：${lastError || '无响应'}`);
}

// —— ServeManager ——

export type ServeManagerStatus = ConnectionStatus;
export interface ServeManagerOptions {
  /** serve CLI 入口（dev = 仓库内 packages/cli/dist/index.js；打包 = resources/cli/dist/index.js） */
  cliEntry: string;
  root?: string;
  home?: string;
  /** 'mock' = 传 --provider mock（零 key 冒烟）；'config' = 按配置 roles.main（默认） */
  provider?: 'mock' | 'config';
  /** 复写可执行文件（默认 process.execPath + ELECTRON_RUN_AS_NODE=1；测试注入 node） */
  executablePath?: string;
  /** 健康检查超时 ms（默认 15000） */
  healthTimeoutMs?: number;
  /** 自动重启次数上限（默认 5） */
  restartAttempts?: number;
  /** 退避基准 ms（默认 1000；测试可调小） */
  restartBaseDelayMs?: number;
  /** 启动时尝试采纳既有实例（读 serve.lock；默认 true） */
  adoptExisting?: boolean;
  /** 复写 spawn（测试注入假 serve 子进程；默认 node:child_process.spawn） */
  spawnImpl?: typeof spawn;
  onStatus?: (status: ServeManagerStatus, detail?: StatusDetail) => void;
}

export class ServeManager {
  private child: ChildProcess | null = null;
  private stdoutBuf = '';
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartCount = 0;
  private adoptedPort: number | null = null;
  private port: number | null = null;
  /** P2：本实例/采纳实例的一次性 token（从 serve.lock 读；渲染端不出网，仅主进程用于 HTTP/WS 鉴权） */
  private token: string | null = null;

  status: ServeManagerStatus = 'offline';
  /** 最近一次状态详情（供 getStatus 主动查询；port/error/attemptsLeft） */
  private statusDetail: StatusDetail | undefined;

  constructor(private readonly options: ServeManagerOptions) {}

  /** 当前状态 + 详情（渲染端启动时经 getStatus 主动查询，避免只靠可能错过的 onStatus 事件） */
  getStatus(): { status: ServeManagerStatus; detail?: StatusDetail } {
    return { status: this.status, detail: this.statusDetail };
  }

  get baseUrl(): string {
    if (this.port === null) throw new Error('serve 未就绪');
    return `http://127.0.0.1:${this.port}`;
  }

  get wsUrl(): string {
    if (this.port === null) throw new Error('serve 未就绪');
    return `ws://127.0.0.1:${this.port}/ws`;
  }

  get currentPort(): number | null {
    return this.port;
  }

  /** P2：serve 一次性 token（未就绪/旧版锁无 token 时为 null）；供 bridge 携带 HTTP/WS 鉴权 */
  get authToken(): string | null {
    return this.token;
  }

  /** 从 serve.lock 重读 token（每次健康检查重读：兼容锁文件晚于 stdout 端口行的极短竞态） */
  private tokenFromLock(): string | undefined {
    if (this.options.home === undefined) return undefined;
    return readServeLock(this.options.home)?.token;
  }

  private setStatus(status: ServeManagerStatus, detail?: StatusDetail): void {
    this.status = status;
    this.statusDetail = detail;
    this.options.onStatus?.(status, detail);
  }

  /** 启动（或采纳）serve 实例；失败抛错（失败会计入退避链自动重试，达上限才 offline） */
  async start(): Promise<{ port: number; adopted: boolean }> {
    this.stopping = false;
    // 新一轮 start：清除上一轮遗留的重启定时器并把退避计数归零（计数只在 stop()/start() 归零）
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.restartCount = 0;
    this.token = null;
    this.setStatus('connecting');
    // 端口锁被既有实例持有 → 采纳（避免与 CLI serve 双实例互踢）
    if ((this.options.adoptExisting ?? true) && this.options.home !== undefined) {
      const lock = readServeLock(this.options.home);
      if (lock && isPidAlive(lock.pid)) {
        try {
          await waitForHealth(lock.port, 3000, fetch, 200, () => lock.token);
          this.adoptedPort = lock.port;
          this.port = lock.port;
          this.token = lock.token ?? null;
          this.setStatus('connected', { port: lock.port });
          return { port: lock.port, adopted: true };
        } catch {
          // 锁信息陈旧（持有者未监听）/token 不匹配 → 忽略，走自建
        }
      }
    }
    return this.spawnServe();
  }

  private buildServeArgs(): string[] {
    return [
      this.options.cliEntry,
      'serve',
      '--port',
      '0',
      ...(this.options.provider === 'mock' ? ['--provider', 'mock'] : []),
      ...(this.options.root !== undefined ? ['--root', this.options.root] : []),
      ...(this.options.home !== undefined ? ['--home', this.options.home] : []),
    ];
  }

  private spawnServe(): Promise<{ port: number; adopted: boolean }> {
    const attempt = this.doSpawnServe();
    // 重启链唯一失败出口：一次 spawn 尝试的任何失败（启动期退出 / spawn 错误 / 健康检查超时）
    // 都计入退避链自动重试（达上限才 offline），不再被 `.catch(() => {})` 无声吞掉。
    // 首次 start() 的失败仍向上 reject（提示由调用方 main.ts 决定），重试照常进行。
    // scheduleRestart 自带防重（stopping / 已有挂起重试 / 存活子进程），
    // 过期尝试的迟到失败（如健康检查超时晚于子进程退出并被重启取代）不会触发额外重启。
    void attempt.catch((e: Error) => this.scheduleRestart(e.message));
    return attempt;
  }

  private doSpawnServe(): Promise<{ port: number; adopted: boolean }> {
    return new Promise((resolve, reject) => {
      const spawnImpl = this.options.spawnImpl ?? spawn;
      const child = spawnImpl(this.options.executablePath ?? process.execPath, this.buildServeArgs(), {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      this.stdoutBuf = '';
      let settled = false;

      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return; // 端口行已解析：停止累积（防长驻进程 stdout 无限增长）
        // 端口行打印前的噪声输出过大时只保留尾部 8KB
        this.stdoutBuf = (this.stdoutBuf + chunk.toString('utf8')).slice(-STDOUT_TAIL_MAX_BYTES);
        const line = extractServePort(this.stdoutBuf);
        if (!line) return;
        settled = true;
        this.port = line.port;
        waitForHealth(line.port, this.options.healthTimeoutMs ?? 15000, fetch, 200, () => this.tokenFromLock())
          .then(() => {
            // 注意：这里不重置 restartCount——连续失败计数只在 stop()/新一轮 start() 归零，
            // 保证"必崩"服务也会按上限停止（退避封顶 15s），不会无限重启循环。
            this.token = this.tokenFromLock() ?? null;
            this.setStatus('connected', { port: line.port });
            resolve({ port: line.port, adopted: false });
          })
          .catch((e: Error) => {
            this.setStatus('offline', { error: e.message });
            reject(e);
          });
      });

      child.on('error', (e: Error) => {
        if (settled) return;
        settled = true;
        this.child = null; // spawn 失败（如 ENOENT）：子进程不可用，允许退避链继续
        this.setStatus('offline', { error: e.message });
        reject(e);
      });

      child.on('exit', (code, signal) => {
        this.child = null;
        if (!settled) {
          settled = true;
          const detail = `serve 启动期退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`;
          this.setStatus('offline', { error: detail });
          // 首次 start() 仍 reject（调用方决定提示）；重试由 spawnServe 的统一失败出口
          // 调度（与运行期意外退出同一条退避链），不再"启动期退出 = 永远 offline"。
          reject(new Error(detail));
          return;
        }
        this.handleUnexpectedExit(code, signal);
      });
    });
  }

  private handleUnexpectedExit(code: number | null, signal: string | null): void {
    this.scheduleRestart(`serve 退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`);
  }

  /** 退避重试调度（重启链唯一入口）：主动停止不重启；已有挂起重试/存活子进程时不重复调度 */
  private scheduleRestart(reason: string): void {
    if (this.stopping || this.restartTimer !== null || this.child !== null) return;
    if (!shouldRestartChild(this.stopping)) return;
    this.adoptedPort = null;
    this.setStatus('reconnecting', { error: reason });
    const attempts = this.options.restartAttempts ?? 5;
    if (this.restartCount >= attempts) {
      this.setStatus('offline', { error: `serve 自动重启已达上限（${attempts} 次）` });
      return;
    }
    const delay = backoffDelayMs(this.restartCount, this.options.restartBaseDelayMs ?? 1000);
    this.restartCount += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      // 失败出口在 spawnServe 内统一调度下一次退避重试（达上限才 offline）
      void this.spawnServe();
    }, delay);
  }

  /** 优雅停止：不再重启，杀掉子进程并等待退出；重启退避计数归零（新一轮 start 从头计） */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.restartCount = 0;
    const child = this.child;
    this.adoptedPort = null;
    this.token = null;
    if (child === null) {
      this.setStatus('offline');
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 已退出
        }
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    this.child = null;
    this.setStatus('offline');
  }
}
