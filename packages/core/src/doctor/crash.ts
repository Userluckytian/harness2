// 崩溃报告（阶段 11 Task 4）：无遥测——报告只写本地 ~/.harness2/crash/，需要反馈时由
// 用户**手动**提供文件；零网络发送（Global Constraints）。
// 内容：版本 / 平台 / Node / 会话 id（装配层经 noteCrashSessionId 登记）/ 错误消息与栈，
// 全部出口过 redactSecrets（错误路径最后闸门，与 config/schema 同口径）。
// 文件名：ISO 时间中的冒号在 Windows 非法——统一替换为 '-'。
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactSecrets } from '../config/redact.js';
import { CORE_VERSION } from '../version.js';

/** 崩溃目录名（~/.harness2/crash） */
export const CRASH_DIR_NAME = 'crash';

/** 进程级会话上下文（chat REPL 会话切换时登记；serve 无单一会话不登记） */
const crashState: { sessionId?: string } = {};

/** 登记当前会话 id（崩溃报告写入"当前会话 id"字段；undefined = 清除） */
export function noteCrashSessionId(id: string | undefined): void {
  if (id === undefined) delete crashState.sessionId;
  else crashState.sessionId = id;
}

export function crashReportDir(home?: string): string {
  return join(home ?? homedir(), '.harness2', CRASH_DIR_NAME);
}

/** 崩溃报告文件名：ISO 时间冒号替换为 '-'（Windows 文件名合法），如 2026-09-07T01-23-45-678Z.log */
export function crashReportFileName(now: Date = new Date()): string {
  return `${now.toISOString().replace(/:/g, '-')}.log`;
}

/** 组装报告正文（全部经 redactSecrets；无遥测——仅本地落盘用） */
export function formatCrashReport(err: unknown, opts: { now?: Date } = {}): string {
  const e = err instanceof Error ? err : undefined;
  const lines = [
    `version: ${CORE_VERSION}`,
    `timestamp: ${(opts.now ?? new Date()).toISOString()}`,
    `platform: ${process.platform} ${process.arch}`,
    `node: ${process.version}`,
    `cwd: ${redactSecrets(process.cwd())}`,
    `session: ${crashState.sessionId ?? '-'}`,
    `error: ${redactSecrets(e?.message ?? String(err))}`,
    `stack:`,
    e?.stack === undefined ? '  (no stack)' : redactSecrets(e.stack)
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n'),
  ];
  return lines.join('\n') + '\n';
}

/**
 * 写崩溃报告到 ~/.harness2/crash/<ISO 时间>.log（目录不存在则创建；写失败不抛——
 * 崩溃路径上的尽力而为，失败信息打印 stderr）。返回报告路径（写失败返回 null）。
 */
export function writeCrashReport(err: unknown, opts: { home?: string; now?: Date } = {}): string | null {
  const dir = crashReportDir(opts.home);
  const path = join(dir, crashReportFileName(opts.now));
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, formatCrashReport(err, { ...(opts.now !== undefined ? { now: opts.now } : {}) }), 'utf8');
    return path;
  } catch (e) {
    console.error(`warning: 崩溃报告写盘失败: ${(e as Error)?.message ?? String(e)}`);
    return null;
  }
}

/**
 * CLI 顶层崩溃报告接线：uncaughtException → 落盘 + 控制台打印路径与手动反馈指引 → exit 1。
 * 幂等（重复调用只注册一次）；测试不安装本钩子，直接调 writeCrashReport。
 */
let installed = false;
export function installCrashReporter(opts: { home?: string } = {}): void {
  if (installed) return;
  installed = true;
  process.on('uncaughtException', (err) => {
    const path = writeCrashReport(err, opts);
    console.error(`发生未捕获异常：${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    if (path !== null) {
      console.error(`崩溃报告已写入本地：${path}`);
      console.error('harness2 无自动上报（零遥测）；如需反馈请手动提供该文件。');
    }
    process.exit(1);
  });
}
