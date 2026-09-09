// toolExecutionView 只读契约（S7b）：把「执行记录来源」投影为桌面可读的命令执行视图。
// 契约（计划 S7 / 验收 #7b）：
//   - 输出：callId/taskId/turnId、tool、参数、cwd、实际 shell、开始/结束、
//     输出引用（截断）、exitCode、状态；
//   - 归属语义：**真实 shell 与 exitCode 归属清楚**——不得把「计划中命令」当「已执行命令」；
//     未执行（审批拒绝/取消前门/未知工具）/失败/截断如实标注；
//   - 只读视图，不重跑：本模块纯投影，无任何执行/文件 I/O。
// 来源（调用方装配，本模块只投影——复用既有 executor 生命周期观察与 session 日志）：
//   - executor 观察缝（ExecutionLifecycleObserver，真正启动才 onExecuteStart）：
//     started/ended 时点、executedArgs（真实执行参数）、终态 ok/output/error/durationMs；
//   - session 日志 tool/call：plannedArgs、turnId；
//   - env：cwd、shell（实际 shell 真值，如 Windows %ComSpec%；缺省不臆造）。
// 红线：不新建第二套执行器；不写任何事件；输出经 redactObject 脱敏且深度冻结。
import { redactObject, redactSecrets } from '../config/redact.js';
import { CANCELLED_RESULT, UNKNOWN_RESULT } from '../tools/executor.js';

/** 输出引用视图级上限：展示入口一律不要给桌面灌全量输出 */
export const EXECUTION_OUTPUT_REF_MAX = 4096;

export type ToolExecutionStatus = 'not-executed' | 'running' | 'success' | 'failed' | 'cancelled' | 'unknown';

/** 命令归属：executed=真实执行（有 lifecycle start）；planned-only=仅计划从未执行；none=非命令工具 */
export type ToolExecutionCommandSource = 'executed' | 'planned-only' | 'none';

/** exitCode 归属：bash-error=从工具 error「exit code N」解析；bash-ok=bash ok ⇔ 零退出的契约归因；none=无 */
export type ToolExecutionExitCodeSource = 'bash-error' | 'bash-ok' | 'none';

/** 执行记录来源（调用方装配；观察缝 + session 日志 + env 三重来源合并） */
export interface ToolExecutionTrace {
  callId: string;
  taskId?: string;
  turnId?: string;
  tool: string;
  /** 计划参数（session 日志 tool/call 的 args，写入时由调用方已消毒） */
  plannedArgs: unknown;
  /** 真实执行的参数（onExecuteStart 捕获；缺省 = 未启动/未采样） */
  executedArgs?: unknown;
  /** 执行环境 cwd（per-session 真值） */
  cwd: string;
  /** 实际 shell（记录来源，如 Windows %ComSpec%；缺省 = 未记录，不臆造） */
  shell?: string;
  /** onExecuteStart 时点（ISO8601；出现 = 工具真正启动） */
  startedAt?: string;
  /** onExecuteEnd 时点（ISO8601） */
  endedAt?: string;
  /** 终态 ok（onExecuteEnd result.ok） */
  ok?: boolean;
  output?: string;
  error?: string;
  durationMs?: number;
}

export interface ToolExecutionView {
  callId: string;
  taskId?: string;
  turnId?: string;
  tool: string;
  /** 计划参数视图（脱敏深拷贝，不与 trace 共享引用） */
  args: unknown;
  /** tool=bash：计划中的命令（计划参数）；其余工具无 */
  plannedCommand?: string;
  /** tool=bash：真实执行的命令（onExecuteStart 采样；未启动无） */
  actualCommand?: string;
  commandSource: ToolExecutionCommandSource;
  cwd: string;
  /** 实际 shell（记录来源；未记录则缺省，不臆造） */
  shell?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** 输出展示引用（脱敏后视图级截断；超长带截断标记） */
  outputRef: string;
  /** 来源已截断（bash 32KB 截断标记）或视图级截断 */
  outputTruncated: boolean;
  /** 真实命令退出码（归属见 exitCodeSource；未执行/非命令工具不虚构） */
  exitCode?: number;
  exitCodeSource: ToolExecutionExitCodeSource;
  status: ToolExecutionStatus;
  error?: string;
  /** 契约钉：只读视图 */
  readonly readOnly: true;
}

/** bash 工具 error 形态：`exit code N` / `exit code N (signal SIGTERM)`（见 tools/predefined/bash.ts） */
const EXIT_CODE_ERROR_RE = /^exit code (\d+)(?: \(signal ([^)]+)\))?/;
/** truncateText 的来源截断标记（tools/predefined/common.ts） */
const SOURCE_TRUNCATED_RE = /\[truncated \d+ chars\]$/;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const k of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[k]);
  }
  return Object.freeze(value);
}

function commandOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const v = (args as Record<string, unknown>)['command'];
  return typeof v === 'string' ? v : undefined;
}

function resolveStatus(trace: ToolExecutionTrace): ToolExecutionStatus {
  // 从未真正启动：即使有 onExecuteEnd（拒绝/取消前门），也不算「已执行」
  if (trace.startedAt === undefined) return 'not-executed';
  if (trace.endedAt === undefined) return 'running';
  if (trace.error === CANCELLED_RESULT) return 'cancelled';
  if (trace.error === UNKNOWN_RESULT) return 'unknown'; // 不合作工具：取消归一 unknown
  return trace.ok === true ? 'success' : 'failed';
}

function resolveExitCode(trace: ToolExecutionTrace): {
  exitCode?: number;
  exitCodeSource: ToolExecutionExitCodeSource;
} {
  if (trace.tool !== 'bash') return { exitCodeSource: 'none' };
  // 未启动/未结束：绝不虚构退出码
  if (trace.startedAt === undefined || trace.endedAt === undefined) return { exitCodeSource: 'none' };
  if (trace.error !== undefined) {
    const m = EXIT_CODE_ERROR_RE.exec(trace.error);
    if (m !== null) return { exitCode: Number(m[1]), exitCodeSource: 'bash-error' };
  }
  // bash 契约归因：close 阶段 code===0 才 ok（ok ⇔ 零退出）——如实给 0，来源标注契约推导
  if (trace.ok === true) return { exitCode: 0, exitCodeSource: 'bash-ok' };
  return { exitCodeSource: 'none' };
}

function referenceOutput(output: string | undefined): { ref: string; truncated: boolean } {
  if (output === undefined || output.length === 0) return { ref: '', truncated: false };
  const redacted = redactSecrets(output);
  const hadSourceMarker = SOURCE_TRUNCATED_RE.test(redacted);
  if (redacted.length <= EXECUTION_OUTPUT_REF_MAX) {
    return { ref: redacted, truncated: hadSourceMarker };
  }
  const marker = `...[truncated ${redacted.length - EXECUTION_OUTPUT_REF_MAX} chars]`;
  return { ref: `${redacted.slice(0, EXECUTION_OUTPUT_REF_MAX)}${marker}`, truncated: true };
}

/**
 * 构建命令执行只读视图：纯投影（不执行、不写盘）。
 * 命令归属：
 *   - 未启动（无 startedAt）→ commandSource='planned-only'，actualCommand 缺省（仅计划，未执行）；
 *   - 已启动 → commandSource='executed'，actualCommand 优先取 executedArgs 采样值
 *     （执行器契约：onExecuteStart 的 req 即真实参数；无采样回填计划命令，provenance 仍为 executed）。
 * 退出码：仅 bash 且已启动已结束时按上述归属提供；其余不虚构。
 */
export function buildToolExecutionView(trace: ToolExecutionTrace): ToolExecutionView {
  const isBash = trace.tool === 'bash';
  const started = trace.startedAt !== undefined;

  const plannedCommand = isBash ? commandOf(trace.plannedArgs) : undefined;
  const sampledCommand = isBash ? commandOf(trace.executedArgs) : undefined;
  const commandSource: ToolExecutionCommandSource = !isBash ? 'none' : started ? 'executed' : 'planned-only';
  const actualCommand = commandSource === 'executed' ? (sampledCommand ?? plannedCommand) : undefined;

  const { exitCode, exitCodeSource } = resolveExitCode(trace);
  const { ref, truncated } = referenceOutput(trace.output);

  const view: ToolExecutionView = {
    callId: trace.callId,
    ...(trace.taskId !== undefined ? { taskId: trace.taskId } : {}),
    ...(trace.turnId !== undefined ? { turnId: trace.turnId } : {}),
    tool: trace.tool,
    args: trace.plannedArgs,
    ...(plannedCommand !== undefined ? { plannedCommand } : {}),
    ...(actualCommand !== undefined ? { actualCommand } : {}),
    commandSource,
    cwd: trace.cwd,
    ...(trace.shell !== undefined ? { shell: trace.shell } : {}),
    ...(trace.startedAt !== undefined ? { startedAt: trace.startedAt } : {}),
    ...(trace.endedAt !== undefined ? { endedAt: trace.endedAt } : {}),
    ...(trace.durationMs !== undefined ? { durationMs: trace.durationMs } : {}),
    outputRef: ref,
    outputTruncated: truncated,
    ...(exitCode !== undefined ? { exitCode } : {}),
    exitCodeSource,
    status: resolveStatus(trace),
    ...(trace.error !== undefined ? { error: trace.error } : {}),
    readOnly: true,
  };
  // 出口统一脱敏（深拷贝）+ 深度冻结（桌面展示契约，同 run-config 口径）
  return deepFreeze(redactObject(view));
}
