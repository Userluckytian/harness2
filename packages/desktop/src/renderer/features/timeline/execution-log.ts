// 时间线工具/命令行纯逻辑（D2）：把「聊天条目 + S7 执行视图」合成**真实命令日志**。
//
// 契约红线（toolExecutionView / 验收 F3）：
//   - 真实 shell 与 exitCode 归属清楚：`planned-only`（仅计划、从未执行）**不得**展示为已执行，
//     也不得虚构退出码；`executed` 才展示 actualCommand/shell/exitCode；
//   - 大输出**范围读取**（窗口 + 总数），不把全量输出灌进 DOM；
//   - 取消/失败/未执行/未知如实标注（cancel ≠ undo，不假报成功）。
import type { ChatItem } from '../../chat-model.js';
import type {
  ToolExecutionCommandSourceShape,
  ToolExecutionExitCodeSourceShape,
  ToolExecutionStatusShape,
  ToolExecutionViewShape,
} from '../../../shared/protocol.js';

/** 输出窗口默认行数（超出部分仅按需展开） */
export const OUTPUT_WINDOW_LINES = 200;

/** 滚动「贴底」判定阈值（px）：距底 ≤ 阈值视为贴底，新消息到达时保持在底部 */
export const STICK_TO_BOTTOM_THRESHOLD = 24;

export interface CommandOutputWindow {
  lines: string[];
  /** 窗口在全文中的起止行号（0 起始，含 from、不含 to） */
  from: number;
  to: number;
  total: number;
  /** 是否还有更早/更晚的内容（UI 据此给「加载更早/更晚」入口） */
  hasBefore: boolean;
  hasAfter: boolean;
}

/** 按行切分输出（保留空行；CRLF 归一为 LF） */
export function splitOutputLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\r\n/g, '\n').split('\n');
}

/** 大输出范围读取：取 [start, start+count) 行窗口 + 全文行数（纯函数，可单测） */
export function sliceOutputLines(text: string, start = 0, count: number = OUTPUT_WINDOW_LINES): CommandOutputWindow {
  const lines = splitOutputLines(text);
  const total = lines.length;
  const from = Math.max(0, Math.min(Number.isInteger(start) ? start : 0, total));
  const to = Math.max(from, Math.min(from + Math.max(1, count), total));
  return {
    lines: lines.slice(from, to),
    from,
    to,
    total,
    hasBefore: from > 0,
    hasAfter: to < total,
  };
}

/** 时间线里的工具/命令行 */
export interface TimelineToolRow {
  callId: string;
  tool: string;
  status: ToolExecutionStatusShape;
  commandSource: ToolExecutionCommandSourceShape;
  /** tool=bash 的真实执行命令（仅 commandSource='executed' 有值） */
  actualCommand?: string;
  /** tool=bash 的计划命令（仅计划，未执行时展示为「计划」） */
  plannedCommand?: string;
  cwd: string;
  /** 实际 shell（未记录则缺省，不臆造） */
  shell?: string;
  exitCode?: number;
  exitCodeSource: ToolExecutionExitCodeSourceShape;
  outputRef: string;
  outputTruncated: boolean;
  durationMs?: number;
  error?: string;
}

/**
 * 由「聊天条目 + 执行视图」构造工具行。
 * 视图缺失（旧 serve / 查询未到）→ 回退到条目自身的 result 语义，status 由 ok 推导，
 * 但**不猜** commandSource/shell/exitCode（保持 none/缺省）。
 */
export function buildToolRow(item: ChatItem, view: ToolExecutionViewShape | undefined): TimelineToolRow {
  if (view !== undefined) {
    return {
      callId: view.callId,
      tool: view.tool,
      status: view.status,
      commandSource: view.commandSource,
      ...(view.actualCommand !== undefined ? { actualCommand: view.actualCommand } : {}),
      ...(view.plannedCommand !== undefined ? { plannedCommand: view.plannedCommand } : {}),
      cwd: view.cwd,
      ...(view.shell !== undefined ? { shell: view.shell } : {}),
      ...(view.exitCode !== undefined ? { exitCode: view.exitCode } : {}),
      exitCodeSource: view.exitCodeSource,
      outputRef: view.outputRef,
      outputTruncated: view.outputTruncated,
      ...(view.durationMs !== undefined ? { durationMs: view.durationMs } : {}),
      ...(view.error !== undefined ? { error: view.error } : {}),
    };
  }
  const result = item.result;
  const status: ToolExecutionStatusShape = result === undefined ? 'running' : result.ok ? 'success' : 'failed';
  return {
    callId: item.callId ?? '',
    tool: item.tool ?? '',
    status,
    commandSource: 'none', // 无执行视图 → 不声明命令归属（不臆造）
    cwd: '',
    exitCodeSource: 'none',
    outputRef: result?.output ?? '',
    outputTruncated: false,
    ...(result?.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    ...(result?.error !== undefined ? { error: result.error } : {}),
  };
}

/** 命令归属的用户可读标签（未执行绝不显示为已执行） */
export function commandSourceLabel(source: ToolExecutionCommandSourceShape): string {
  switch (source) {
    case 'executed':
      return '已执行';
    case 'planned-only':
      return '仅计划（未执行）';
    case 'none':
      return '';
  }
}

/** 退出码标签：来源清楚；未执行/非命令工具为空（不虚构） */
export function exitCodeLabel(row: Pick<TimelineToolRow, 'exitCode' | 'exitCodeSource'>): string {
  if (row.exitCode === undefined) return '';
  const source = row.exitCodeSource === 'bash-error' ? '命令报错' : row.exitCodeSource === 'bash-ok' ? '零退出' : '';
  return source.length > 0 ? `exit ${row.exitCode}（${source}）` : `exit ${row.exitCode}`;
}

/** 状态标签（取消/失败/未执行/未知如实区分） */
export function statusLabel(status: ToolExecutionStatusShape): string {
  switch (status) {
    case 'running':
      return '运行中…';
    case 'success':
      return 'ok';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    case 'not-executed':
      return '未执行';
    case 'unknown':
      return '状态未知';
  }
}

export interface StickState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 是否贴底（距底 ≤ 阈值） */
export function isAtBottom(state: StickState, threshold = STICK_TO_BOTTOM_THRESHOLD): boolean {
  return state.scrollHeight - state.scrollTop - state.clientHeight <= threshold;
}

/**
 * 稳定滚动：只有**之前**就贴底时才跟随新内容滚到底；
 * 用户上滚阅读历史时不得被新帧拽回底部。返回应设置的 scrollTop（null = 不动）。
 */
export function nextScrollTop(
  before: StickState,
  after: { scrollHeight: number },
  wasAtBottom: boolean,
  threshold = STICK_TO_BOTTOM_THRESHOLD,
): number | null {
  if (!wasAtBottom && !isAtBottom(before, threshold)) return null;
  return after.scrollHeight;
}
