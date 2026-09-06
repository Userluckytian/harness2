// 分屏布局引擎（纯函数，main/renderer 共享）：1/2/3 分栏，每栏绑定一个会话流（≤3 并发订阅渲染）。
// 持久化形态 = ~/.harness2/desktop-layout.json 的唯一 schema；normalizeLayout 是
// 文件读取与 IPC 保存两路的唯一校验口（损坏/越界一律回落默认布局）。
export const MAX_PANES = 3;

export interface PaneState {
  /** 绑定的会话 id；null = 空栏 */
  sessionId: string | null;
}

export interface DesktopLayout {
  panes: PaneState[];
}

export function defaultLayout(): DesktopLayout {
  return { panes: [{ sessionId: null }] };
}

/** 校验未知来源的布局数据（磁盘文件/IPC）：合法 1..3 栏、sessionId 为 string|null；否则回落默认 */
export function normalizeLayout(raw: unknown): DesktopLayout {
  if (typeof raw !== 'object' || raw === null) return defaultLayout();
  const panes = (raw as { panes?: unknown }).panes;
  if (!Array.isArray(panes) || panes.length < 1 || panes.length > MAX_PANES) return defaultLayout();
  const normalized: PaneState[] = [];
  for (const p of panes) {
    const sid = (p as { sessionId?: unknown } | null)?.sessionId;
    if (sid === null) normalized.push({ sessionId: null });
    else if (typeof sid === 'string' && sid.length > 0) normalized.push({ sessionId: sid });
    else return defaultLayout();
  }
  return { panes: normalized };
}

/** 改栏数：保留既有绑定（多余栏丢弃，同一会话只保留最靠前的一栏），新增栏为空 */
export function setPaneCount(layout: DesktopLayout, count: number): DesktopLayout {
  const n = Math.max(1, Math.min(MAX_PANES, Math.floor(count)));
  const kept: PaneState[] = [];
  const seen = new Set<string>();
  for (const pane of layout.panes.slice(0, n)) {
    if (pane.sessionId !== null) {
      if (seen.has(pane.sessionId)) continue; // 同会话去重：只留最靠前
      seen.add(pane.sessionId);
    }
    kept.push({ ...pane });
  }
  while (kept.length < n) kept.push({ sessionId: null });
  return { panes: kept };
}

/** 把会话拖入/分配到某栏：清掉其它栏的同一会话；sessionId=null = 清空该栏 */
export function assignSession(layout: DesktopLayout, paneIndex: number, sessionId: string | null): DesktopLayout {
  const panes = layout.panes.map((p) => ({ ...p }));
  if (paneIndex < 0 || paneIndex >= panes.length) return { panes };
  panes[paneIndex]!.sessionId = sessionId;
  if (sessionId !== null) {
    for (let i = 0; i < panes.length; i++) {
      if (i !== paneIndex && panes[i]!.sessionId === sessionId) panes[i]!.sessionId = null;
    }
  }
  return { panes };
}

/** 布局中已绑定的会话 id集合（后台会话判定用） */
export function boundSessionIds(layout: DesktopLayout): Set<string> {
  const out = new Set<string>();
  for (const p of layout.panes) {
    if (p.sessionId !== null) out.add(p.sessionId);
  }
  return out;
}
