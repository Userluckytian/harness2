// Z9-3 桌面终端传输（主进程）：进程级**单例** TerminalManager 的薄壳。
//
// 形态（照 projects-file / cron-list 先例）：渲染端零 Node，唯一出口 = preload 的 IPC
// `terminal:*` → bridge 分发 → 本模块 → core `createTerminalManager`（同进程 PTY）。
// core 管理器不 import serve / Electron（冻结契约 §1.1），PTY 仅在此显式 open 时创建。
//
// 事件出口沿用既有事件通道形态（同 sendSettingsEvent）：core 的 `TerminalEvent`
// （`data`/`exit`）在此映射为**线协议命名**的 `terminal:data` / `terminal:exit`
// （阶段计划 §1.2 同口径），由 main.ts 的 sendTerminalEvent 推给渲染端。
//
// 安全（与 workspace-fs `listWorkspaceDir` 同口径，见 resolveTerminalCwd）：
// cwd 一律做 realpath 边界校验，只允许落在主进程持有的工作区根内；越界/非法一律拒绝。
import { createTerminalManager, type TerminalEvent, type TerminalManager } from './core.js';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpathSync, statSync } from 'node:fs';

/** 主进程 → 渲染端终端事件帧（线协议命名；阶段计划 §1.2 / §1.3） */
export type TerminalOutboundFrame =
  | { type: 'terminal:data'; id: string; data: string }
  | { type: 'terminal:exit'; id: string; exitCode: number | undefined };

export interface TerminalTransport {
  /** 起一个 PTY；非法 cols/rows 或越界 cwd → 抛可读错误（不伪装成功） */
  open(opts: { cols: number; rows: number; cwd?: string }): { id: string };
  /** 写输入；未知 id → false（如实，不抛） */
  write(id: string, data: string): boolean;
  /** 改尺寸；未知 id → false */
  resize(id: string, cols: number, rows: number): boolean;
  /** 杀 PTY；未知 id → false */
  close(id: string): boolean;
  /** 当前存活的终端 id 列表（诊断/冒烟用；无 IPC 命令） */
  list(): string[];
  /** 杀全部并摘监听（app 退出 / 冒烟收尾调用） */
  dispose(): void;
}

export interface TerminalTransportDeps {
  /** 主进程持有的工作区根（serve --root）：cwd 边界校验的基准，渲染端不可指定 */
  root: string;
  /** 事件出口（main.ts 推 webContents；窗口已销毁时实现侧自行忽略） */
  sendEvent: (frame: TerminalOutboundFrame) => void;
  /** 测试注入假 PTY 管理器；缺省 = core createTerminalManager()（真 @lydell/node-pty） */
  createManager?: () => TerminalManager;
}

/** 单终端尺寸上限（防渲染端传荒谬值拖垮 PTY；下限 1 由 core 契约隐含） */
const MAX_DIMENSION = 1000;

/**
 * cwd 边界校验（口径**照抄** `packages/desktop/src/main/workspace-fs.ts:listWorkspaceDir`）：
 *   - 字符串层先拒 NUL 字节与超长（快速失败）；
 *   - 根与目标各做 `realpathSync`（解析符号链接 / Windows junction / 大小写）；
 *   - 解析后必须仍落在根的真实路径之内（`relative` 结果不为 `..`/`../...`、非绝对路径）；
 *   - 目标必须是存在的目录（ENOENT / ENOTDIR 明确报错）。
 * 空 cwd = 工作区根本身。渲染端只可传绝对或相对路径，越界一律拒绝。
 */
export function resolveTerminalCwd(
  root: string,
  cwd: string | undefined,
): { ok: true; cwd: string } | { ok: false; error: string } {
  const raw = cwd ?? '';
  if (raw.includes('\0')) return { ok: false, error: '路径非法（含 NUL 字节）' };
  if (raw.length > 1024) return { ok: false, error: '路径过长' };

  let baseReal: string;
  try {
    baseReal = realpathSync(root);
  } catch {
    return { ok: false, error: '工作区根不存在或不可访问' };
  }

  const target = raw.length === 0 ? baseReal : resolve(baseReal, raw);
  let targetReal: string;
  try {
    targetReal = realpathSync(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, error: code === 'ENOENT' ? '目录不存在' : `目录不可访问: ${code ?? (e as Error).message}` };
  }

  // realpath 之后核对边界：符号链接 / junction 指向根外，或跨盘（relative 返回绝对路径）在此被拒
  const rel = relative(baseReal, targetReal);
  const relNormalized = rel.split(sep).join('/');
  if (!(
    relNormalized === '' ||
    (!relNormalized.startsWith('../') && relNormalized !== '..' && !isAbsolute(relNormalized))
  )) {
    return { ok: false, error: '路径越界（cwd 指向工作区外）' };
  }

  try {
    if (!statSync(targetReal).isDirectory()) return { ok: false, error: 'cwd 不是目录' };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, error: `目录不可访问: ${code ?? (e as Error).message}` };
  }

  return { ok: true, cwd: targetReal };
}

function isValidDimension(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_DIMENSION;
}

/** 建一个终端传输（非单例；单例见 startTerminal/getTerminalTransport）。 */
export function createTerminalTransport(deps: TerminalTransportDeps): TerminalTransport {
  const manager = (deps.createManager ?? createTerminalManager)();
  const off = manager.onEvent((e: TerminalEvent) => {
    if (e.type === 'data') deps.sendEvent({ type: 'terminal:data', id: e.id, data: e.data });
    else deps.sendEvent({ type: 'terminal:exit', id: e.id, exitCode: e.exitCode });
  });
  let disposed = false;

  return {
    open(opts) {
      if (!isValidDimension(opts.cols) || !isValidDimension(opts.rows)) {
        throw new Error(`terminal:open 的 cols/rows 非法（须为 1..${MAX_DIMENSION} 的整数）`);
      }
      const cwd = resolveTerminalCwd(deps.root, opts.cwd);
      if (!cwd.ok) throw new Error(cwd.error);
      // spawn 的失败（PTY 不可用）由 core 包成 TerminalUnavailableError，原样上抛（可读）
      return manager.spawn({ cols: opts.cols, rows: opts.rows, cwd: cwd.cwd });
    },
    write(id, data) {
      if (typeof id !== 'string' || id.length === 0 || typeof data !== 'string') return false;
      return manager.write(id, data);
    },
    resize(id, cols, rows) {
      if (typeof id !== 'string' || id.length === 0 || !isValidDimension(cols) || !isValidDimension(rows)) {
        return false;
      }
      return manager.resize(id, cols, rows);
    },
    close(id) {
      if (typeof id !== 'string' || id.length === 0) return false;
      return manager.kill(id);
    },
    list() {
      return manager.list();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      off();
      manager.dispose();
    },
  };
}

// —— 进程级单例（main.ts 启动时 start，before-quit / 冒烟收尾 stop） ——

let active: TerminalTransport | null = null;

/** 启动（或替换）进程级终端传输；重复调用先 dispose 旧的，避免泄漏 PTY。 */
export function startTerminal(deps: TerminalTransportDeps): TerminalTransport {
  stopTerminal();
  active = createTerminalTransport(deps);
  return active;
}

/** 取当前传输；未初始化（测试/异常时序）→ 抛可读错误，由 bridge 转 InvokeError 回传。 */
export function getTerminalTransport(): TerminalTransport {
  if (active === null) throw new Error('终端传输未初始化');
  return active;
}

/** 停用并清空单例（app 退出 / 冒烟收尾）；幂等。 */
export function stopTerminal(): void {
  active?.dispose();
  active = null;
}
