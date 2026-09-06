// 出站渲染：serve 事件帧 → 平台文本消息（精简、有界、如实）。
// 策略：turn 结束一次性发送（不逐 delta）；工具行最多 3 行；超长截断提示 traj。
export const MAX_OUTBOUND_CHARS = 1800;
const MAX_TOOL_LINES = 3;

export interface RenderInput {
  finalText: string;
  toolLines: string[];
  stopReason: string;
  error?: string;
}

export function renderTurnEnd(input: RenderInput): string {
  const parts: string[] = [];
  if (input.toolLines.length > 0) {
    parts.push(...input.toolLines.slice(-MAX_TOOL_LINES), '');
  }
  if (input.finalText.length > 0) {
    parts.push(input.finalText);
  } else {
    parts.push(
      input.stopReason === 'cancelled'
        ? '(已取消)'
        : input.stopReason === 'error'
          ? `(出错：${input.error ?? '未知原因'})`
          : input.stopReason === 'max_steps'
            ? '(达到步数上限，摘要见轨迹)'
            : `(turn 结束：${input.stopReason})`,
    );
  }
  const text = parts.join('\n');
  return withTruncationNotice(text);
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
