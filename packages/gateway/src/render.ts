// 出站渲染：serve 事件帧 → 平台文本消息（精简、有界、如实）。
// 策略：turn 结束一次性发送（不逐 delta）；工具行最多 3 行；超长截断提示 traj。
export const MAX_OUTBOUND_CHARS = 1800;
const MAX_TOOL_LINES = 3;

export interface RenderInput {
  finalText: string;
  /** P3-b：不完整 attempt 的半截文本（非空时必须标注「未完成」，不得冒充完整正文） */
  partialText?: string;
  /** P3-a/P3-b：终态文本展示判别（与 core WS `turn-end` 帧同契约；缺省按文本推断，兼容旧调用） */
  textOutcome?: 'final' | 'partial' | 'empty';
  toolLines: string[];
  stopReason: string;
  error?: string;
}

export function renderTurnEnd(input: RenderInput): string {
  const parts: string[] = [];
  if (input.toolLines.length > 0) {
    parts.push(...input.toolLines.slice(-MAX_TOOL_LINES), '');
  }
  const partial = input.partialText ?? '';
  const outcome =
    input.textOutcome ?? (input.finalText.length > 0 ? 'final' : partial.length > 0 ? 'partial' : 'empty');
  if (outcome === 'final' && input.finalText.length > 0) {
    parts.push(input.finalText);
  } else if (outcome === 'partial' && partial.length > 0) {
    // P3-b：半截文本 + 明确中断标注（与终端/桌面同一语义）
    parts.push(partial, `（未完成：${input.error ?? emptyReason(input.stopReason)}）`);
  } else {
    // P3-a：无最终文本但有可行动结果——工具行已在上面，这里只给原因，不造空白正文
    parts.push(emptyReason(input.stopReason, input.error));
  }
  const text = parts.join('\n');
  return withTruncationNotice(text);
}

/** empty 收尾的原因行（stopReason + 可选 error） */
function emptyReason(stopReason: string, error?: string): string {
  if (stopReason === 'cancelled') return '(已取消)';
  if (stopReason === 'error') return `(出错：${error ?? '未知原因'})`;
  if (stopReason === 'max_steps') return '(达到步数上限，摘要见轨迹)';
  return `(turn 结束：${stopReason})`;
}

/** 审批请求 → 平台文本（回复 1/2 决策） */
export function renderApprovalRequest(tool: string, args: unknown): string {
  const argsPreview = truncate(safeStringify(args), 200);
  return [`⚙ 工具请求执行：${tool}`, argsPreview, '—', '回复 [1] 允许 / [2] 拒绝'].join('\n');
}

/** 解析审批回复文本；非审批回复返回 undefined */
export function parseApprovalReply(text: string): 'allow' | 'deny' | undefined {
  const t = text.trim();
  if (t === '1' || t === '允许' || t.toLowerCase() === 'y') return 'allow';
  if (t === '2' || t === '拒绝' || t.toLowerCase() === 'n') return 'deny';
  return undefined;
}

function withTruncationNotice(text: string): string {
  if (text.length <= MAX_OUTBOUND_CHARS) return text;
  return `${text.slice(0, MAX_OUTBOUND_CHARS)}\n…（已截断，完整内容用 harness2 traj 查看会话日志）`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '<无法序列化>';
  }
}
