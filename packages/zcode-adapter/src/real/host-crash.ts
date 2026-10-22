/**
 * host-crash —— adapter host 进程崩溃归因接线（ZS5-T2）。
 *
 * 职责：把 host 进程的 `uncaughtException` / `unhandledRejection` 接到 core 已有的
 * `writeCrashReport`（零遥测、redact 闸门、本地 `~/.harness2/crash/` 落盘），**不改 core**。
 *
 * 处置语义依据（ZCode 原版 host）：
 *   - `D:/AI_Projects/harness2-zs1-build/ZCode/packages/desktop/src/host/hostUncaughtExceptionGuard.ts:1-34`
 *     （recoverable = RangeError "Failed to allocate memory" → 仅隔离；其余 fatal）
 *   - `D:/AI_Projects/harness2-zs1-build/ZCode/packages/desktop/src/host/index.ts:2921-2940`
 *     （fatal → logger.error + disposeHostResources + process.exit(1)）
 *   - `D:/AI_Projects/harness2-zs1-build/ZCode/packages/desktop/src/main/index.ts:309-311`
 *     （main 进程 unhandledRejection → logger.error，**不退出**）
 *
 * 本适配层决策：adapter host 无等价资源释放器，且为避免连坐杀死壳/测试进程，
 * 两类钩子均**写报告后吞掉**（不 process.exit）；recoverable 分配失败仅 warn。
 * 依据行号已标于上；两类钩子写报告后均吞、不退出（对齐 ZCode main 仅记日志语义）。
 *
 * 测试缝：home / writeCrashReport / now 全可注入；导出的 handle* 函数可被单测直接调用，
 * 不真正注册 process 监听、不真杀进程。
 */
import process from 'node:process';
import { resolveHarness2Home, writeCrashReport as defaultWriteCrashReport } from './core-bridge.js';

export interface CrashHookOptions {
  /** 崩溃报告 home 根（默认 resolveHarness2Home()，读 HARNESS2_HOME） */
  home?: string;
  /** 覆盖 writer（测试注入 mock） */
  writeCrashReport?: (err: unknown, opts?: { home?: string; now?: Date }) => string | null;
  /** 时钟（测试注入以生成多文件） */
  now?: () => Date;
}

let installed = false;

function resolveHome(home?: string): string {
  return home ?? resolveHarness2Home();
}

function isRecoverableAllocationError(err: unknown): boolean {
  return err instanceof RangeError && (err as Error).message === 'Failed to allocate memory';
}

export function handleUncaughtException(err: unknown, options: CrashHookOptions = {}): string | null {
  const home = resolveHome(options.home);
  const writer = options.writeCrashReport ?? defaultWriteCrashReport;
  let reportPath: string | null = null;
  try {
    reportPath = writer(err, { home, now: options.now?.() });
  } catch (e) {
    try {
      console.error('[host-crash] writeCrashReport failed:', (e as Error)?.message ?? String(e));
    } catch {
      // 绝不从崩溃钩子里再抛
    }
    reportPath = null;
  }

  if (isRecoverableAllocationError(err)) {
    try {
      console.warn('[host-crash] contained recoverable allocation failure:', err);
    } catch {
      // ignore
    }
  }
  // 两类钩子写报告后均吞、不退出（对齐 ZCode main 仅记日志语义）
  return reportPath;
}

export function handleUnhandledRejection(reason: unknown, options: CrashHookOptions = {}): string | null {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  const home = resolveHome(options.home);
  const writer = options.writeCrashReport ?? defaultWriteCrashReport;
  let reportPath: string | null = null;
  try {
    reportPath = writer(err, { home, now: options.now?.() });
  } catch (e) {
    try {
      console.error('[host-crash] writeCrashReport failed:', (e as Error)?.message ?? String(e));
    } catch {
      // ignore
    }
    reportPath = null;
  }
  // main 进程 unhandledRejection 仅记日志不退出（ZCode main/index.ts:309-311）；此处同口径吞掉
  return reportPath;
}

export function installCrashHooks(options: CrashHookOptions = {}): void {
  if (installed) return;
  installed = true;
  try {
    process.on('uncaughtException', (err) => {
      try {
        handleUncaughtException(err, options);
      } catch {
        // 钩子内绝不能再抛
      }
    });
  } catch {
    // ignore
  }
  try {
    process.on('unhandledRejection', (reason) => {
      try {
        handleUnhandledRejection(reason, options);
      } catch {
        // 钩子内绝不能再抛
      }
    });
  } catch {
    // ignore
  }
}

export function registerCrashHooks(options: CrashHookOptions = {}): void {
  installCrashHooks(options);
}

export function wireCrashHooks(options: CrashHookOptions = {}): void {
  installCrashHooks(options);
}

export function attachCrashHooks(options: CrashHookOptions = {}): void {
  installCrashHooks(options);
}

// 测试辅助：重置 installed 标志（仅测试使用；生产不应调用）
export function __resetCrashHooksForTest(): void {
  installed = false;
}
