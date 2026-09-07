// 会话「轻量展示态」覆层 schema（main/renderer 共享）：~/.harness2/desktop-metadata.json。
// 只存桌面端展示覆盖：会话标题（优先于 firstUserText 显示）、归档软删除标记、删除隐藏标记。
// **不碰会话事件溯源日志（session.v1.jsonl / rewind_points.jsonl）**——重命名/归档/删除都是
// 纯展示态，数据始终留在原会话目录；全量列表（listSessions）不变，由渲染端按标记分区显示。
// 删除语义（serve 无 delete API，2026-09-07 核实）：deleted 覆层标记 + 从侧栏隐藏，
// **绝不伪造物理删除**（事件日志原样保留；CLI 可物理清理会话目录）。
// normalizeMetadata 是文件读取与 IPC 保存两路的唯一校验口（仿 shared/preferences.ts 的
// normalizePreferences：非对象回落空对象；单条 entry 未知字段忽略、类型不符回落无该字段）。
export const METADATA_FILE = 'desktop-metadata.json';

/** 单会话展示态覆盖（title 可选；archived/deleted 可选——缺失 = false 语义） */
export interface SessionMetadataEntry {
  title?: string;
  /** 归档软删除：移出主列表，在「已归档」折叠区可见可恢复 */
  archived?: boolean;
  /** 删除隐藏（UI 二次确认后）：从侧栏移除；仅覆层标记，事件数据仍在 */
  deleted?: boolean;
}

export type SessionMetadataMap = Record<string, SessionMetadataEntry>;

/** 空覆层（映射中无任何条目） */
export function defaultMetadata(): SessionMetadataMap {
  return {};
}

/** title 规范化：非空字符串才保留，否则无该字段 */
function normalizeTitle(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** boolean 标记规范化：仅 boolean 保留 */
function normalizeFlag(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * 校验未知来源的 metadata（磁盘文件/IPC）：顶层非对象 → 空覆层；
 * 条目值非对象 → 忽略该条（字段缺失即回落默认展示）；单条内未知字段忽略、
 * 类型不符回落无该字段。空 title / 非布尔标记都被丢弃。
 */
export function normalizeMetadata(raw: unknown): SessionMetadataMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return defaultMetadata();
  const out: SessionMetadataMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null) continue; // 条目必须是对象
    const entry = value as Record<string, unknown>;
    const title = normalizeTitle(entry['title']);
    const archived = normalizeFlag(entry['archived']);
    const deleted = normalizeFlag(entry['deleted']);
    // 全部字段无效 → 该条无覆盖意义，不落条目
    if (title === undefined && archived === undefined && deleted === undefined) continue;
    out[key] = {
      ...(title !== undefined ? { title } : {}),
      ...(archived !== undefined ? { archived } : {}),
      ...(deleted !== undefined ? { deleted } : {}),
    };
  }
  return out;
}

/** 判断某会话是否已归档（覆盖层判定；缺失/非布尔 → false；已删除会话不应作为归档展示） */
export function isArchived(map: SessionMetadataMap, sessionId: string): boolean {
  const e = map[sessionId];
  return e?.archived === true && e?.deleted !== true;
}

/** 判断某会话是否已被删除隐藏（覆盖层判定） */
export function isDeleted(map: SessionMetadataMap, sessionId: string): boolean {
  return map[sessionId]?.deleted === true;
}

/** 取某会话展示标题（优先覆层 title；无 → null 表示回落 firstUserText） */
export function displayTitle(map: SessionMetadataMap, sessionId: string): string | null {
  const t = map[sessionId]?.title;
  return typeof t === 'string' && t.length > 0 ? t : null;
}

/**
 * 前端实时过滤（B3 纯函数）：query 匹配「展示标题」（覆层 title 优先、否则 firstUserText）
 * 的会话；按覆层标记分区：
 *   - active：未归档且未删除，且匹配 query
 *   - archived：已归档且未删除，且匹配 query（折叠区）
 *   - deleted 的会话不参与任何列表（删除 = 隐藏；数据仍在磁盘）
 */
export function filterSessionList<T extends { id: string; firstUserText: string }>(
  sessions: readonly T[],
  metadata: SessionMetadataMap,
  query: string,
): { active: T[]; archived: T[] } {
  const q = query.trim().toLowerCase();
  const matches = (s: T): boolean => {
    if (q.length === 0) return true;
    const title = displayTitle(metadata, s.id);
    const hay = title !== null ? `${title} ${s.firstUserText}` : s.firstUserText;
    return hay.toLowerCase().includes(q);
  };
  const active: T[] = [];
  const archived: T[] = [];
  for (const s of sessions) {
    if (isDeleted(metadata, s.id)) continue;
    if (!matches(s)) continue;
    if (isArchived(metadata, s.id)) archived.push(s);
    else active.push(s);
  }
  return { active, archived };
}