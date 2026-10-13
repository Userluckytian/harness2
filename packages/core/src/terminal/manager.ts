// Z9-1（2026-10-13）core 终端管理器（PTY）。冻结契约见
// docs/ai-framework/plans/2026-10-13-phase-Z9-terminal-and-web-settings.md §1.1。
//
// 纪律：
//   - 零 Electron / 零 serve 依赖：core 一份管理器，传输层（IPC / HTTP+WS）在薄壳各自实现；
//   - PTY 只在用户显式 spawn 时创建，不落盘、不常驻、不启动调度；
//   - PTY 不可用（平台不支持 / 依赖加载失败）→ 抛 TerminalUnavailableError 如实失败，
//     绝不静默降级成假终端（红线⑩）；
//   - spawnPty 注入点用于单测假 PTY；真实现 = @lydell/node-pty（平台二进制走 npm 可选依赖）。
import { createRequire } from 'node:module';

/** spawn 入参（冻结契约 §1.1，逐字） */
export interface TerminalSpawnOptions {
  cwd?: string;
  cols: number;
  rows: number;
  shell?: string;
  env?: Record<string, string>;
}

/** 管理器向订阅者转发的事件（冻结契约 §1.1，逐字） */
export type TerminalEvent =
  { type: 'data'; id: string; data: string } | { type: 'exit'; id: string; exitCode: number | undefined };

/** 便于注入假 PTY 单测；真实现 = @lydell/node-pty（冻结契约 §1.1，逐字） */
export interface PtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** 管理器对外端口（冻结契约 §1.1，逐字） */
export interface TerminalManager {
  spawn(opts: TerminalSpawnOptions): { id: string };
  write(id: string, data: string): boolean;
  resize(id: string, cols: number, rows: number): boolean;
  kill(id: string): boolean;
  list(): string[];
  onEvent(cb: (e: TerminalEvent) => void): () => void;
  dispose(): void;
}

/**
 * PTY 不可用（平台不支持 / @lydell/node-pty 平台二进制缺失 / spawn 失败）——如实失败，
 * 不静默降级成假终端。调用方（serve / 桌面主进程）据此回传 terminal/error。
 */
export class TerminalUnavailableError extends Error {
  constructor(detail?: string) {
    super(`终端不可用：无法创建 PTY${detail ? `；原始错误: ${detail}` : ''}`);
    this.name = 'TerminalUnavailableError';
  }
}

/** 默认 shell：Windows = ComSpec，其余平台 = $SHELL（冻结契约 §1.1） */
function platformDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec ?? 'cmd.exe';
  }
  return process.env.SHELL ?? '/bin/bash';
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 真实现：惰性 require @lydell/node-pty（CommonJS），失败抛 TerminalUnavailableError。
 * 惰性而非顶层 import：模块加载失败只影响 spawn 的显式调用，不当场炸掉整个 core 主入口。
 */
function defaultSpawnPty(file: string, args: string[], opts: Record<string, unknown>): PtyLike {
  try {
    const require = createRequire(import.meta.url);
    const nodePty = require('@lydell/node-pty') as typeof import('@lydell/node-pty');
    // encoding:'utf8' —— onData 直接给字符串（否则 Unix 侧给 Buffer，违反 PtyLike 契约）。
    // Windows/ConPTY 本就以字符串投递且不支持该选项，故仅在非 win32 显式设置。
    const spawnOptions: Record<string, unknown> =
      process.platform === 'win32' ? { ...opts } : { encoding: 'utf8', ...opts };
    const spawned = nodePty.spawn(file, args, spawnOptions as import('@lydell/node-pty').IPtyForkOptions);
    // 显式适配 IPty → PtyLike（不依赖结构化巧合，便于将来换实现）。
    return {
      onData: (cb) => {
        spawned.onData(cb);
      },
      onExit: (cb) => {
        spawned.onExit((e) => cb({ exitCode: e.exitCode }));
      },
      write: (data) => spawned.write(data),
      resize: (cols, rows) => spawned.resize(cols, rows),
      kill: () => spawned.kill(),
    };
  } catch (err) {
    throw new TerminalUnavailableError(errorDetail(err));
  }
}

interface Entry {
  pty: PtyLike;
  /** kill 已调用：不再转发 data（kill 后从表中摘除）。 */
  killed: boolean;
  /** exit 已发出：去重，保证每个 id 至多一次 exit。 */
  exited: boolean;
}

export function createTerminalManager(
  deps: {
    spawnPty?: (file: string, args: string[], opts: Record<string, unknown>) => PtyLike;
    defaultShell?: string;
  } = {},
): TerminalManager {
  const spawnPty = deps.spawnPty ?? defaultSpawnPty;
  const entries = new Map<string, Entry>();
  const listeners = new Set<(e: TerminalEvent) => void>();
  let nextId = 1;
  let disposed = false;

  const emit = (e: TerminalEvent): void => {
    if (disposed) return;
    for (const cb of [...listeners]) cb(e);
  };

  return {
    spawn(opts) {
      if (disposed) {
        throw new Error('终端管理器已 dispose，不能再 spawn');
      }
      const shell = opts.shell ?? deps.defaultShell ?? platformDefaultShell();
      const spawnOpts: Record<string, unknown> = {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        env: { ...process.env, ...(opts.env ?? {}) },
      };
      if (opts.cwd !== undefined) spawnOpts.cwd = opts.cwd;
      // spawnPty 自身的失败（平台不支持 / 依赖缺失）已由 defaultSpawnPty 包成
      // TerminalUnavailableError；注入的假 PTY 抛错则原样上抛（测试可断言）。
      const pty = spawnPty(shell, [], spawnOpts);
      const id = `t-${nextId++}`;
      const entry: Entry = { pty, killed: false, exited: false };
      entries.set(id, entry);

      pty.onData((data) => {
        if (entry.killed || entry.exited) return;
        emit({ type: 'data', id, data });
      });
      pty.onExit((e) => {
        if (entry.exited) return;
        entry.exited = true;
        entries.delete(id);
        emit({ type: 'exit', id, exitCode: e.exitCode });
      });

      return { id };
    },

    write(id, data) {
      const entry = entries.get(id);
      if (!entry) return false;
      entry.pty.write(data);
      return true;
    },

    resize(id, cols, rows) {
      const entry = entries.get(id);
      if (!entry) return false;
      entry.pty.resize(cols, rows);
      return true;
    },

    kill(id) {
      const entry = entries.get(id);
      if (!entry) return false;
      entries.delete(id);
      entry.killed = true;
      try {
        entry.pty.kill();
      } catch {
        // kill 失败（进程已退出等）不改写「已从表摘除」的事实；exit 事件仍由 PTY 侧决定。
      }
      return true;
    },

    list() {
      return [...entries.keys()];
    },

    onEvent(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [id, entry] of entries) {
        entry.killed = true;
        try {
          entry.pty.kill();
        } catch {
          // dispose 幂等：单个 kill 失败不阻断其余。
        }
        entries.delete(id);
      }
      listeners.clear();
    },
  };
}
