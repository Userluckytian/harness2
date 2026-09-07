// 任务完成系统通知的纯逻辑（main/renderer 共享；零依赖，可单测）：
//   - summaryForNotify：回复正文 → 通知摘要（80 字截断）
//   - shouldNotifyOnTurnEnd：触发判定（窗口非聚焦 + 该会话当前不可见）
// 渲染进程零 Node 红线：不引用任何 Node/Electron API，纯字符串/数据结构判断。
export const NOTIFY_WINDOW_TITLE = 'harness2';
/** 通知正文最大长度（计划：assistant 回复前 80 字摘要；超出加省略号） */
export const NOTIFY_BODY_MAX = 80;
/** 单行截断长度（含换行折叠/空白压缩后的首行上限） */
export const NOTIFY_LINE_MAX = 60;

/** 空白归一化：全角/半角空白折叠为单个空格（不破坏原始标点） */
function collapseWhitespace(text: string): string {
  return text.replace(/[\u3000\s]+/g, ' ').trim();
}

/** 全文换行折叠为单个候选分隔符（中文句号优先；无句号时取第一个换行为界） */
function firstLineBoundary(collapsed: string): number | -1 {
  const cnEnd = collapsed.indexOf('。');
  if (cnEnd >= 0) return cnEnd + 1;
  const newline = collapsed.indexOf('\n');
  return newline >= 0 ? newline : -1;
}

/** 按展示预算组织摘要：优先首行（标题行折叠 → 收成一行 ≤60），续行完整段落 + 追加省略号 */
function organizeSummary(collapsed: string): string {
  if (collapsed.length <= NOTIFY_BODY_MAX) return collapsed;
  const boundary = firstLineBoundary(collapsed);
  const firstSegment = boundary >= 0 ? collapsed.slice(0, boundary) : collapsed;
  const firstTrim = firstSegment.trim();
  if (firstTrim.length > 0 && firstTrim.length <= NOTIFY_LINE_MAX) {
    const remainder = collapsed.slice(boundary).trim();
    if (remainder.length === 0) return firstTrim;
    // 预算：首行 + 换行(1) + 省略号(1) + 续行截断（行内硬截断，中文无词边界）
    const tailBudget = NOTIFY_BODY_MAX - firstTrim.length - 2;
    const tail = remainder.length <= tailBudget ? remainder : remainder.slice(0, tailBudget);
    return `${firstTrim}\n${tail}…`;
  }
  if (collapsed.length <= NOTIFY_LINE_MAX) return collapsed;
  return `${collapsed.slice(0, NOTIFY_LINE_MAX - 1)}…`;
}

/**
 * 会话通知标题：覆层 title 或 firstUserText 非空 → 展示标题（截断）；
 * 否则固定「harness2」。正文 = 回复摘要（先折叠空白，再经 organizeSummary 截断）。
 */
export function composeNotifyContent(opts: {
  title?: string | null;
  firstUserText?: string | null;
  replyText: string;
}): { title: string; body: string } {
  const title = opts.title !== undefined && opts.title !== null && opts.title.trim().length > 0
    ? collapseWhitespace(opts.title)
    : opts.firstUserText !== undefined && opts.firstUserText !== null && opts.firstUserText.trim().length > 0
      ? collapseWhitespace(opts.firstUserText)
      : NOTIFY_WINDOW_TITLE;
  const body = organizeSummary(collapseWhitespace(opts.replyText));
  return { title, body };
}

/**
 * 触发判定：窗口非聚焦（document.hasFocus()=false）且该会话当前不可见
 * （非选中、也不在任一绑定分栏——可见会话由实时增量覆盖，无需系统通知）。
 */
export function shouldNotifyOnTurnEnd(opts: { windowFocused: boolean; visible: boolean }): boolean {
  return !opts.windowFocused && !opts.visible;
}