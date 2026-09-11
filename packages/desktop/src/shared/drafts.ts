// 会话草稿（D1）：纯逻辑 + 归一化。多会话并行时**草稿按会话隔离**（A/B 项目不串）。
//
// 持久化落点：~/.harness2/desktop-drafts.json（main/drafts-file.ts；与布局/偏好同策略：磁盘为事实源）。
// 红线：草稿是「原始输入」的一部分，与模型上下文分离——发送时才与 @引用块 合成 finalText，
// 草稿本身绝不写进会话日志（模型可见正文仍由 session.log 投影重建）。

/** 单会话草稿长度上限（防御性：避免渲染端/磁盘被超长字符串拖死） */
export const DRAFT_MAX_CHARS = 200_000;

export type DraftsMap = Record<string, string>;

function capText(text: string): string {
  return text.length <= DRAFT_MAX_CHARS ? text : text.slice(0, DRAFT_MAX_CHARS);
}

/** 归一化磁盘/ IPC 输入：只接受 sessionId → 非空字符串；超长截断；空串/非法值丢弃 */
export function normalizeDrafts(raw: unknown): DraftsMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: DraftsMap = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (id.length === 0 || typeof value !== 'string' || value.length === 0) continue;
    out[id] = capText(value);
  }
  return out;
}

/** 写入/清除单会话草稿（text 为空 → 删除该键，保持文件干净） */
export function setDraftValue(map: DraftsMap, sessionId: string, text: string): DraftsMap {
  if (sessionId.length === 0) return map;
  const next: DraftsMap = { ...map };
  if (text.length === 0) delete next[sessionId];
  else next[sessionId] = capText(text);
  return next;
}

/** 取单会话草稿（无 → 空串） */
export function getDraftValue(map: DraftsMap, sessionId: string): string {
  return map[sessionId] ?? '';
}

/** 丢弃指定会话的草稿（会话被物理移除时用） */
export function dropDraft(map: DraftsMap, sessionId: string): DraftsMap {
  if (map[sessionId] === undefined) return map;
  const next = { ...map };
  delete next[sessionId];
  return next;
}
