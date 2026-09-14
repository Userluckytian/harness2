// 工具卡纯模型（D-6x `ui-tool` 对应物）：工具名分类、目标文件/参数摘要、D-86 单视图口径。
//
// D-86（2026-09-13 增补）「工具卡单视图」：
//   - 卡片直接在调用树内查看，选中调用**不再打开第二个全高详情视图**（本仓从未有
//     `conversation.details.tool`，details 席位在 P4 已随三栅移除 → 单视图是既有事实，本模块把它显式钉住）；
//   - 文件路径经 owner `openFile` 路由右栏文本预览；
//   - `inspect` 开轨迹视图（走 `ui-trajectory`，视图未装配时不渲染按钮，见 tool-navigation）。
//
// 纯函数、无 DOM/IPC 依赖（node 环境可测）。
import type { ChatItem } from '../chat-model.js';

/** 前台终端类工具（D-86：运行中的 bash/pwsh 也用 terminal 卡片，不能只认 bash） */
export const TERMINAL_TOOL_NAMES: readonly string[] = ['bash', 'pwsh', 'powershell', 'cmd', 'sh', 'zsh'];

/** 写文件类工具（有会话内文件快照 → diff 卡片） */
export const DIFF_TOOL_NAMES: readonly string[] = ['write', 'edit', 'multiedit'];

/** 工具名分类：终端类（命令日志卡） */
export function isTerminalTool(tool: string | undefined): boolean {
  if (tool === undefined) return false;
  return TERMINAL_TOOL_NAMES.includes(tool.toLowerCase());
}

/** 工具名分类：写文件类（diff 卡） */
export function isDiffTool(tool: string | undefined): boolean {
  if (tool === undefined) return false;
  return DIFF_TOOL_NAMES.includes(tool.toLowerCase());
}

/** 工具卡单视图口径（D-86）：卡片内联在调用树里；不存在「第二个全高详情视图」的开关 */
export const TOOL_CARD_SINGLE_VIEW = true;

function argOf(args: unknown, keys: readonly string[]): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const rec = args as Record<string, unknown>;
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** 工具卡要打开的**文件路径**（write/edit 的 file_path；read 等工具的 path；缺失 → undefined） */
export function toolFileTarget(args: unknown): string | undefined {
  return argOf(args, ['file_path', 'path', 'file']);
}

/** diff 卡片的目标文件（沿用既有口径：只认 file_path，缺省让 DiffCard 用快照里的 file） */
export function toolDiffTargetFile(args: unknown): string | undefined {
  return argOf(args, ['file_path']);
}

/** 工具参数摘要（工具行/内联条共用；单行，超出截断） */
export function summarizeToolArgs(args: unknown, maxLength = 80): string {
  if (args === undefined) return '';
  const one = JSON.stringify(args) ?? '';
  return one.length <= maxLength ? one : `${one.slice(0, maxLength)}…`;
}

/** 工具结果状态（工具行的 ok / FAILED / 运行中 判据） */
export type ToolStatus = 'running' | 'ok' | 'failed';

/** 从结果字段取状态（结果未落 = 运行中；ok=false = failed） */
export function toolStatusOf(result: { ok: boolean } | undefined): ToolStatus {
  if (result === undefined) return 'running';
  return result.ok ? 'ok' : 'failed';
}

/** 工具行状态文案（失败带错误原因；与既有 UI 文案一致） */
export function toolStatusLabel(result: { ok: boolean; error?: string } | undefined): string {
  if (result === undefined) return '运行中…';
  if (result.ok) return 'ok';
  return `FAILED${result.error !== undefined ? `: ${result.error}` : ''}`;
}

/** 是否渲染命令日志卡（D-86：终端类工具、有输出、或被取消时都要用 terminal 卡片如实呈现） */
export function shouldRenderCommandLog(row: { tool: string; outputRef: string; status: string } | undefined): boolean {
  if (row === undefined) return false;
  return isTerminalTool(row.tool) || row.outputRef.length > 0 || row.status === 'cancelled';
}

/** 工具卡数据（由 ChatItem 的 tool 条目折出；渲染层不做推断） */
export interface ToolCardModel {
  readonly tool?: string;
  readonly args?: unknown;
  readonly result?: { ok: boolean; output?: string; error?: string; durationMs?: number };
  readonly callId?: string;
  readonly seq?: number;
  /** subagent 工具的子会话 id（跳转子会话） */
  readonly childSessionId?: string;
}

/** ChatItem → 工具卡数据（拿不到 tool 条目的字段一律不带，不在渲染层臆造） */
export function toolCardFromItem(
  item: Pick<ChatItem, 'tool' | 'args' | 'result' | 'callId' | 'seq' | 'childSessionId'>,
): ToolCardModel {
  return {
    ...(item.tool !== undefined ? { tool: item.tool } : {}),
    ...(item.args !== undefined ? { args: item.args } : {}),
    ...(item.result !== undefined ? { result: item.result } : {}),
    ...(item.callId !== undefined ? { callId: item.callId } : {}),
    ...(item.seq !== undefined ? { seq: item.seq } : {}),
    ...(item.childSessionId !== undefined ? { childSessionId: item.childSessionId } : {}),
  };
}
