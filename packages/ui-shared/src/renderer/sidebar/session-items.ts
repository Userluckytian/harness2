// 会话行视图模型（D-23 区域席位的数据适配）：
//   把桌面 store 的会话摘要 + 展示态覆层（共享模块 shared/metadata.js，只读复用，
//   不复制过滤规则）折算成侧栏行需要的形状。纯函数，便于装配层直接调用与单测。
import { displayTitle, filterSessionList, type SessionMetadataMap } from '../../shared/metadata.js';

/** 装配层给出的会话摘要（store.SessionMeta 的结构子集） */
export interface SidebarSessionSource {
  id: string;
  cwd?: string;
  mtimeMs: number;
  firstUserText: string;
  messageCount: number;
}

/** 行的运行态（来自 store 的会话流；缺省 = 不在跑、无未读） */
export interface SidebarSessionFlags {
  running?: boolean;
  unread?: number;
}

/** 侧栏一行（已是纯展示数据，不含 store 引用） */
export interface SidebarSessionItem {
  id: string;
  title: string;
  cwd?: string;
  messageCount: number;
  mtimeMs: number;
  /** 展示态覆层判定为已归档 */
  archived: boolean;
  /** turn 进行中 */
  running: boolean;
  /** 非当前视图期间新增的落盘事件数 */
  unread: number;
}

/** 空会话的回落标题（firstUserText 为空且无覆层标题时显示，不摆假标题） */
export const UNTITLED_SESSION_LABEL = '（空会话）';

/**
 * 单行换算：标题 = 覆层 title > firstUserText > 空会话占位。
 * @param source - 会话摘要。
 * @param opts - 覆层映射、归档标记、运行态与占位标题。
 * @returns 侧栏行数据。
 */
export function toSessionItem(
  source: SidebarSessionSource,
  opts: {
    metadata: SessionMetadataMap;
    archived?: boolean;
    flags?: SidebarSessionFlags | undefined;
    untitled?: string;
  },
): SidebarSessionItem {
  const override = displayTitle(opts.metadata, source.id);
  const firstUserText = source.firstUserText.trim();
  const title = override ?? (firstUserText.length > 0 ? firstUserText : (opts.untitled ?? UNTITLED_SESSION_LABEL));
  return {
    id: source.id,
    title,
    ...(source.cwd !== undefined ? { cwd: source.cwd } : {}),
    messageCount: source.messageCount,
    mtimeMs: source.mtimeMs,
    archived: opts.archived === true,
    running: opts.flags?.running === true,
    unread: opts.flags?.unread ?? 0,
  };
}

/**
 * 批量换算（含分区与搜索）：过滤/分区复用 shared/metadata 的 filterSessionList，
 * 本函数只负责把命中的行折成展示数据。
 * @param input - 会话列表、覆层、查询串与逐行运行态取数。
 * @returns 活跃与已归档两组行数据（已删除会话两处都不出现）。
 */
export function buildSessionItems(input: {
  sessions: readonly SidebarSessionSource[];
  metadata: SessionMetadataMap;
  query?: string;
  flagsOf?: ((id: string) => SidebarSessionFlags | undefined) | undefined;
  untitled?: string;
}): { active: SidebarSessionItem[]; archived: SidebarSessionItem[] } {
  const { active, archived } = filterSessionList(input.sessions, input.metadata, input.query ?? '');
  const map = (source: SidebarSessionSource, isArchived: boolean): SidebarSessionItem =>
    toSessionItem(source, {
      metadata: input.metadata,
      archived: isArchived,
      flags: input.flagsOf?.(source.id),
      ...(input.untitled !== undefined ? { untitled: input.untitled } : {}),
    });
  return {
    active: active.map((s) => map(s, false)),
    archived: archived.map((s) => map(s, true)),
  };
}
