// serve 子进程管理（Electron 主进程）：
//   spawn `harness2 serve --port 0`（ELECTRON_RUN_AS_NODE 复用 Electron 运行时的 node 能力，
//   打包后无需系统 node）→ 解析 stdout 一行 JSON {"port":N,"pid":M} → 健康检查 /api/config
//   → ready。意外退出按退避自动重启（上限+退避，见 backoffDelayMs）；
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

/** 重启决策：主动 stop 不重启；其余任何退出（含端口锁冲突退出码 1）都按退避重试 */
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
    return { pid: obj['pid'], port: obj['port'], ...(typeof obj['ts'] === 'string' ? { ts: obj['ts'] } : {}) };
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

// —— 健康检查 ——

/** 轮询 GET /api/config（任何 HTTP 响应即视为服务可用）；超时抛错 */
export async function waitForHealth(
  port: number,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/api/config`);
      if (res.status > 0) return; // 服务已应答（ok:false = 配置未就绪，也是活的）
      return;
    } catch (e) {
      lastError = (e as Error).message;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
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

  status: ServeManagerStatus = 'offline';

  constructor(private readonly options: ServeManagerOptions) {}

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

  private setStatus(status: ServeManagerStatus, detail?: StatusDetail): void {
    this.status = status;
    this.options.onStatus?.(status, detail);
  }

  /** 启动（或采纳）serve 实例；失败抛错 */
  async start(): Promise<{ port: number; adopted: boolean }> {
    this.stopping = false;
    this.setStatus('connecting');
    // 端口锁被既有实例持有 → 采纳（避免与 CLI serve 双实例互踢）
    if ((this.options.adoptExisting ?? true) && this.options.home !== undefined) {
      const lock = readServeLock(this.options.home);
      if (lock && isPidAlive(lock.pid)) {
        try {
          await waitForHealth(lock.port, 3000);
          this.adoptedPort = lock.port;
          this.port = lock.port;
          this.setStatus('connected', { port: lock.port });
          return { port: lock.port, adopted: true };
        } catch {
          // 锁信息陈旧（持有者未监听）→ 忽略，走自建
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
        this.stdoutBuf += chunk.toString('utf8');
        const line = extractServePort(this.stdoutBuf);
        if (!line || settled) return;
        settled = true;
        this.port = line.port;
        waitForHealth(line.port, this.options.healthTimeoutMs ?? 15000)
          .then(() => {
            // 注意：这里不重置 restartCount——连续失败计数只在 stop() 后由新一轮 start 归零，
            // 保证"必崩"服务也会按上限停止（退避封顶 15s），不会无限重启循环。
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
        this.setStatus('offline', { error: e.message });
        reject(e);
      });

      child.on('exit', (code, signal) => {
        this.child = null;
        if (!settled) {
          settled = true;
          const detail = `serve 启动期退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`;
          this.setStatus('offline', { error: detail });
          reject(new Error(detail));
          return;
        }
        this.handleUnexpectedExit(code, signal);
      });
    });
  }

  private handleUnexpectedExit(code: number | null, signal: string | null): void {
    if (this.stopping) return;
    this.adoptedPort = null;
    this.setStatus('reconnecting', { error: `serve 退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）` });
    if (!shouldRestartChild(this.stopping)) return;
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
      void this.spawnServe().catch(() => {
        // spawnServe 失败已在内部发 offline；等待下一次 exit/重试
      });
    }, delay);
  }

  /** 优雅停止：不再重启，杀掉子进程并等待退出 */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.adoptedPort = null;
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
