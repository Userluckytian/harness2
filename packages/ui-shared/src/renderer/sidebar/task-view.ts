// 侧栏任务视图纯逻辑（Z8-1：Z-07 #5 任务工具栏 / Z-08 视图模式 / Z-09 会话项）。
// 全部为纯函数：视图模式、排序、筛选、按 cwd（项目）归组、相对时间、leading 槽优先级、
// Pinned 超限折叠。组件只做渲染与内存态，规则一律在此，便于单测直接钉行为。
//
// D-14（无渲染端持久化）：本模块只描述「偏好形状」与默认值；偏好由调用方**内存持有**
// （SessionBrowser 的 useState），不落浏览器本地存储 —— 这是与 ZCode 的刻意差异（ZCode 把
// 视图偏好落 `zcode-sidebar-task-preferences`）。置顶例外：它走 session metadata（主进程文件），
// 不属渲染端存储。
import type { SidebarSessionItem } from './session-items.js';

/** 视图模式（Z-08）：`project` = ZCode 的 workspace/By Project（默认）；`grouped` = 分组。 */
export type SidebarViewMode = 'project' | 'grouped';

/** 排序键（Z-08 默认 sortBy:"updated"） */
export type SidebarSortBy = 'updated' | 'name';

/** 行筛选（工具栏「筛选和排序」的筛选半边；只用真实数据面 running/unread） */
export type SidebarFilter = 'all' | 'running' | 'unread';

/** 任务工具栏偏好（内存态；默认对齐 Z-08：project / updated） */
export interface SidebarTaskPreferences {
  viewMode: SidebarViewMode;
  sortBy: SidebarSortBy;
  filter: SidebarFilter;
}

/** Z-08 默认偏好：organizeBy:"project" / sortBy:"updated"（filter 为我们的加项，默认 all） */
export const DEFAULT_SIDEBAR_TASK_PREFERENCES: SidebarTaskPreferences = {
  viewMode: 'project',
  sortBy: 'updated',
  filter: 'all',
};

/** Pinned 超此条数折叠（Z-07 #6「超 20 条折叠」） */
export const PINNED_COLLAPSE_LIMIT = 20;

/**
 * 项目名 = cwd 末段（Windows/Unix 分隔符都认，忽略尾分隔符）。
 * @param cwd - 会话工作目录；缺省或为空 → 空串（调用方用「无项目」文案兜底）。
 * @returns 末段目录名。
 */
export function projectName(cwd?: string): string {
  if (cwd === undefined) return '';
  const trimmed = cwd.replace(/[\\/]+$/, '');
  if (trimmed.length === 0) return '';
  const parts = trimmed.split(/[\\/]+/);
  return parts[parts.length - 1] ?? '';
}

/**
 * 相对时间（Z-09 元信息行）：刚刚 / N分钟 / N小时 / N天 / N个月 / N年。
 * 纯函数（注入 nowMs，便于单测钉边界）。
 * @param mtimeMs - 会话 mtime（epoch ms）。
 * @param nowMs - 当前时刻（epoch ms）。
 * @returns 中文相对时间串。
 */
export function relativeTime(mtimeMs: number, nowMs: number): string {
  const deltaMs = Math.max(0, nowMs - mtimeMs);
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}个月`;
  return `${Math.floor(days / 365)}年`;
}

/** 行左侧 16px leading 槽的图标种类（Z-09 优先级：unread > running > pinned）。 */
export type SidebarLeadingKind = 'unread' | 'running' | 'pinned';

/**
 * leading 槽优先级（Z-09）：unread 蓝点 > running spinner > pinned 图钉。
 * ZCode 首项是 error 红点——**我们无 error 态，如实不做**（登记于阶段报告）。
 * @param item - 会话行。
 * @returns 该行在槽里显示的唯一种类；都无 → null（槽留空占位，不画）。
 */
export function leadingSlot(item: SidebarSessionItem): SidebarLeadingKind | null {
  if (item.unread > 0) return 'unread';
  if (item.running) return 'running';
  if (item.pinned) return 'pinned';
  return null;
}

/**
 * 排序（不改原数组）：`updated` = mtime 降序；`name` = 标题升序（中文按拼音）。
 * @param items - 行数据。
 * @param sortBy - 排序键。
 * @returns 新数组。
 */
export function sortSessionItems(items: readonly SidebarSessionItem[], sortBy: SidebarSortBy): SidebarSessionItem[] {
  const copy = [...items];
  if (sortBy === 'name') {
    copy.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  } else {
    copy.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }
  return copy;
}

/**
 * 筛选（真实数据面）：`running` 只留运行中；`unread` 只留未读；`all` 原样。
 * @param items - 行数据。
 * @param filter - 筛选键。
 * @returns 新数组（all 也复制，避免调用方误改原数组）。
 */
export function filterSessionItems(items: readonly SidebarSessionItem[], filter: SidebarFilter): SidebarSessionItem[] {
  if (filter === 'running') return items.filter((item) => item.running);
  if (filter === 'unread') return items.filter((item) => item.unread > 0);
  return [...items];
}

/** 一个项目分组（Z-08 grouped 组 / project 模式的「项目」区） */
export interface SidebarProjectGroup {
  /** 分组键 = cwd（'' 表示无项目） */
  key: string;
  /** 项目名 = cwd 末段（无 cwd → 空串，组件用「无项目」文案） */
  name: string;
  cwd?: string;
  items: SidebarSessionItem[];
}

/**
 * 按 cwd 归组（保持输入顺序：先出现的 cwd 先成组）。无 cwd 的会话归到 key='' 的组。
 * @param items - 已排序的行数据。
 * @returns 分组列表。
 */
export function groupSessionsByProject(items: readonly SidebarSessionItem[]): SidebarProjectGroup[] {
  const groups: SidebarProjectGroup[] = [];
  const index = new Map<string, SidebarProjectGroup>();
  for (const item of items) {
    const key = item.cwd ?? '';
    let group = index.get(key);
    if (group === undefined) {
      group = {
        key,
        name: projectName(item.cwd),
        ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
        items: [],
      };
      index.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/**
 * Pinned 折叠（Z-07 #6：超 limit 条折叠为 "show all"）。
 * @param items - 置顶行。
 * @param limit - 折叠阈值（缺省 20）。
 * @returns 可见与溢出两段（未超限时溢出为空数组）。
 */
export function splitPinned(
  items: readonly SidebarSessionItem[],
  limit: number = PINNED_COLLAPSE_LIMIT,
): { visible: SidebarSessionItem[]; overflow: SidebarSessionItem[] } {
  if (items.length <= limit) return { visible: [...items], overflow: [] };
  return { visible: items.slice(0, limit), overflow: items.slice(limit) };
}

/** 归档视图是否开启（Z-08：归档按钮进入，默认关闭，不持久化） */
export type SidebarTaskViewMode = SidebarViewMode | 'archived';

/**
 * 解析实际视图模式（Z-08：归档按钮优先于分段控件）。
 * @param viewMode - 分段控件当前值。
 * @param archivedView - 归档开关。
 * @returns 生效的视图模式。
 */
export function resolveTaskViewMode(viewMode: SidebarViewMode, archivedView: boolean): SidebarTaskViewMode {
  return archivedView ? 'archived' : viewMode;
}

/** 渲染用的分区描述（组件按 kind 分派） */
export type SidebarSection =
  | { kind: 'pinned'; items: SidebarSessionItem[]; overflow: SidebarSessionItem[]; total: number }
  | { kind: 'projects'; groups: SidebarProjectGroup[] }
  | { kind: 'conversations'; items: SidebarSessionItem[] }
  | { kind: 'grouped'; groups: SidebarProjectGroup[] }
  | { kind: 'archived'; items: SidebarSessionItem[] };

export interface SidebarSectionsInput {
  /** 未归档、未删除的会话（已含展示标题与运行态） */
  active: readonly SidebarSessionItem[];
  /** 已归档会话 */
  archived: readonly SidebarSessionItem[];
  prefs: SidebarTaskPreferences;
  archivedView: boolean;
}

/**
 * 装配侧栏分区（纯函数，组件只渲染返回值）：
 *   - Pinned（有置顶才出现；归档视图下不出现）；
 *   - 归档视图：单个「已归档」区（取代项目/会话区）；
 *   - 项目模式（Z-08 默认）：**项目区**（有 cwd 的会话按 cwd 归组）+ **会话区**（全部活跃会话平铺）；
 *   - 分组模式：单个「会话」区，全部会话按 cwd 归组（等价于把两区合并）。
 * 排序/筛选对两区一致生效。
 * @param input - 活跃/归档行 + 偏好 + 归档开关。
 * @returns 有序分区列表。
 */
export function buildSidebarSections(input: SidebarSectionsInput): SidebarSection[] {
  const sections: SidebarSection[] = [];
  const pinned = input.active.filter((item) => item.pinned);
  if (pinned.length > 0 && !input.archivedView) {
    const { visible, overflow } = splitPinned(pinned);
    sections.push({ kind: 'pinned', items: visible, overflow, total: pinned.length });
  }

  const sorted = sortSessionItems(filterSessionItems(input.active, input.prefs.filter), input.prefs.sortBy);

  if (input.archivedView) {
    sections.push({ kind: 'archived', items: sortSessionItems(input.archived, input.prefs.sortBy) });
    return sections;
  }

  if (input.prefs.viewMode === 'grouped') {
    // 分组模式（合并两区）：全部会话按 cwd 归组（无 cwd 归入「无项目」组）。
    const groups = groupSessionsByProject(sorted);
    if (groups.length > 0) sections.push({ kind: 'grouped', groups });
    return sections;
  }

  // 项目模式（Z-08 默认，= ZCode workspace/By Project）：
  //   项目区 = 有 cwd 的会话按 cwd 归组（嵌套）；会话区 = 不属于任何项目（无 cwd）的会话。
  // 两区**不重复**同一会话（同一行只出现一次）；空分区不渲染（红线⑩），两区都空 → 调用方给全局空态。
  // 说明：ZCode 的 Projects（workspace）↔ 我们的「项目区（cwd）」；Conversations ↔ 我们的「会话区」。
  const projectGroups = groupSessionsByProject(sorted.filter((item) => item.cwd !== undefined));
  const looseItems = sorted.filter((item) => item.cwd === undefined);
  if (projectGroups.length > 0) sections.push({ kind: 'projects', groups: projectGroups });
  if (looseItems.length > 0) sections.push({ kind: 'conversations', items: looseItems });
  return sections;
}
