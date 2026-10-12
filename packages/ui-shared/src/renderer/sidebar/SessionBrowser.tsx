// 侧栏区域席位（D-23）：会话列表的宿主实现。
// 依据 refs-deepseek-harness.md D-23「sidebar.workspaces 区域席位 + 底部固定 sidebar.settings 席位」，
// 上游把会话列表放在 ui-workspace 填的 sidebar.workspaces 里；本仓暂不拆包，故在此提供默认占用方。
//
// Z8-1 信息架构（依据 docs/refs/refs-zcode-layout.md Z-07 #5～#8 / Z-08 / Z-09）：
//   任务工具栏（视图模式分段 + 全部展开/收起 + 筛选排序 + 归档开关）
//   → Pinned 区（有置顶才渲染；超 20 条折叠）
//   → 项目模式：项目区（cwd 归组）+ 会话区（活跃会话平铺）；分组模式：单区按 cwd 归组
//   → 归档视图：单「已归档」区。
// 偏好（视图模式/排序/筛选/折叠/展开态）**全部内存态**（D-14，不落盘；与 ZCode 落
// `zcode-sidebar-task-preferences` 是刻意差异）。Pinned 例外：走 session metadata（主进程文件）。
//
// 职责边界：
//   - 列表渲染、当前会话高亮、空态、分区/分组折叠；
//   - 轨道态（56px）不渲染列表，只给一枚「展开以浏览会话」图标按钮（D-13 轨道不是消失）；
//   - 滚动容器登记给外壳：D-24 的溢出判定与静默类由外壳统一决定（本组件只暴露 data 属性）。
import { useState } from 'react';
import { ContextMenu, ContextMenuTrigger } from '../../components/ui/context-menu.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import type { SidebarSessionItem } from './session-items.js';
import type { SidebarLabels } from './labels.js';
import { SessionRowMenuContent, rowMenuActions, type RowMenuCallbacks } from './session-row-menu.js';
import { TaskToolbar } from './TaskToolbar.js';
import {
  buildSidebarSections,
  DEFAULT_SIDEBAR_TASK_PREFERENCES,
  leadingSlot,
  relativeTime,
  type SidebarProjectGroup,
  type SidebarSection,
  type SidebarTaskPreferences,
} from './task-view.js';

/** 外壳传给区域席位的属主事实（D-23） */
export interface WorkspacesOwnerProps {
  /** 展开态渲染完整浏览器，轨道态渲染图标列（D-13） */
  wide: boolean;
  /** 轨道图标请求展开（展开后焦点随宽态翻转落到浏览器） */
  expandSidebar: () => void;
  /** 把内部滚动容器登记给外壳（D-24：溢出判定对象） */
  registerScrollRegion: (element: HTMLElement | null) => void;
  /** 外壳的滚动条结论（'quiet' = 不画） */
  scrollBars: 'drawn' | 'quiet';
}

export interface SessionBrowserProps extends WorkspacesOwnerProps {
  sessions: readonly SidebarSessionItem[];
  /** 已归档会话（归档视图里列出；缺省不渲染该区） */
  archived?: readonly SidebarSessionItem[];
  selectedId?: string | null;
  /** 搜索串（受控）；配合 onQueryChange 提供搜索框 */
  query?: string;
  onQueryChange?: ((query: string) => void) | undefined;
  onOpenSession: (id: string) => void;
  labels: SidebarLabels;
  /**
   * 行拖拽（Z2-06 / Z-19：把左栏会话拖进主区分屏）。
   * 缺省不传 = 行不可拖（web 壳与既有调用点行为不变，向后兼容）。
   */
  rowDrag?: SessionRowDrag | undefined;
  /**
   * 置顶切换（Z8-1：Pinned 行的「取消置顶」；置顶动作本体在 Z8-2 右键菜单）。
   * 缺省不传 = Pinned 行不渲染取消按钮（不摆无效入口）。
   */
  onTogglePin?: ((id: string, pinned: boolean) => void) | undefined;
  /** 相对时间基准（缺省 Date.now()；单测注入以钉死输出） */
  nowMs?: number | undefined;
  /** 任务偏好初值（缺省 Z-08 默认：project / updated / all）；之后由本组件内存持有 */
  initialTaskPreferences?: Partial<SidebarTaskPreferences> | undefined;
  /**
   * P0-2（Z-10）右键菜单动作回调：缺项 = 该项不渲染（不摆假入口）。
   * 重命名的输入对话框由本组件承载（两壳共享），提交经 onSubmitRename 回壳落盘。
   */
  rowMenu?: RowMenuCallbacks | undefined;
  /** 重命名提交（壳接 controller.renameSession；返回 Promise 以驱动对话框 loading/关闭） */
  onSubmitRename?: ((id: string, title: string) => Promise<void> | void) | undefined;
}

/** 会话行拖拽钩子（Z-19）：载荷由调用方决定（生产写 dataTransfer + 模块级回退） */
export interface SessionRowDrag {
  /** 拖拽开始（行已 `draggable`） */
  onDragStart?: ((id: string, event: React.DragEvent<HTMLButtonElement>) => void) | undefined;
  /** 拖拽结束（含被取消） */
  onDragEnd?: ((id: string, event: React.DragEvent<HTMLButtonElement>) => void) | undefined;
  /** 已在分屏中的会话：禁用拖拽（Z-19「已在分屏内的会话禁用拖拽」） */
  disabledIds?: ReadonlySet<string> | undefined;
}

/** 一行的元信息行（Z-09）：条数 + 相对时间 */
function rowMeta(item: SidebarSessionItem, nowMs: number, labels: SidebarLabels): string {
  return `${labels.messageCount(item.messageCount)} · ${relativeTime(item.mtimeMs, nowMs)}`;
}

/** leading 槽（Z-09）：unread 徽标 > running spinner > pinned 图钉；都无 → 空占位 */
function LeadingSlot({ item, labels }: { item: SidebarSessionItem; labels: SidebarLabels }): React.ReactNode {
  const kind = leadingSlot(item);
  if (kind === 'unread') {
    return (
      <span className="h2-sidebar-session-leading" data-testid="session-leading" data-kind="unread">
        <span className="h2-sidebar-unread" aria-label={labels.unreadLabel}>
          {item.unread}
        </span>
      </span>
    );
  }
  if (kind === 'running') {
    return (
      <span className="h2-sidebar-session-leading" data-testid="session-leading" data-kind="running">
        <span className="h2-sidebar-running" data-testid="session-running" aria-label={labels.runningLabel} />
      </span>
    );
  }
  if (kind === 'pinned') {
    return (
      <span className="h2-sidebar-session-leading" data-testid="session-leading" data-kind="pinned">
        <span className="h2-sidebar-pinned-mark" data-testid="session-pinned" aria-label={labels.pinnedMarkLabel}>
          📌
        </span>
      </span>
    );
  }
  return <span className="h2-sidebar-session-leading" data-testid="session-leading" data-kind="none" />;
}

interface RowContext {
  selectedId: string | null;
  labels: SidebarLabels;
  nowMs: number;
  onOpenSession: (id: string) => void;
  onTogglePin: ((id: string, pinned: boolean) => void) | undefined;
  rowDrag: SessionRowDrag | undefined;
  /** P0-2（Z-10）：右键菜单回调（缺位项不渲染） */
  rowMenu: RowMenuCallbacks | undefined;
}

/** 单行渲染（列表区与 Pinned 区共用）；showUnpin 只在 Pinned 区为 true（取消置顶入口只此一处） */
function SessionRow({
  item,
  ctx,
  showUnpin = false,
}: {
  item: SidebarSessionItem;
  ctx: RowContext;
  showUnpin?: boolean;
}): React.ReactNode {
  const { selectedId, labels, nowMs, onOpenSession, onTogglePin, rowDrag, rowMenu } = ctx;
  const onDragStart = rowDrag?.onDragStart;
  const onDragEnd = rowDrag?.onDragEnd;
  const dragDisabled = rowDrag?.disabledIds?.has(item.id) === true;
  const draggable = onDragStart !== undefined && !dragDisabled;
  const unpin = showUnpin && onTogglePin !== undefined && item.pinned;
  // P0-2：菜单动作可用才包装（一个回调都没有 → 不挂 ContextMenu，右键无空菜单）
  const menuActions =
    rowMenu === undefined
      ? []
      : rowMenuActions({
          pinned: item.pinned,
          archived: item.archived,
          canPin: rowMenu.onPin !== undefined,
          canRename: rowMenu.onRename !== undefined,
          canArchive: rowMenu.onArchive !== undefined,
          canSplit: rowMenu.onOpenInSplit !== undefined,
          canTrajectory: rowMenu.onInspectTrajectory !== undefined,
        });
  const rowButton = (
    <button
      type="button"
      className="h2-sidebar-session"
      data-session-id={item.id}
      data-selected={selectedId === item.id ? 'true' : 'false'}
      data-archived={item.archived ? 'true' : 'false'}
      data-drag-disabled={dragDisabled ? 'true' : undefined}
      aria-current={selectedId === item.id ? 'true' : undefined}
      title={item.title}
      {...(draggable ? { draggable: true } : {})}
      {...(draggable && onDragStart !== undefined
        ? { onDragStart: (event: React.DragEvent<HTMLButtonElement>) => onDragStart(item.id, event) }
        : {})}
      {...(onDragEnd !== undefined
        ? { onDragEnd: (event: React.DragEvent<HTMLButtonElement>) => onDragEnd(item.id, event) }
        : {})}
      onClick={() => onOpenSession(item.id)}
    >
      <LeadingSlot item={item} labels={labels} />
      <span className="h2-sidebar-session-body">
        <span className="h2-sidebar-session-title">
          {item.title}
          {/* Z2-09b（场景④）：待审批 attention 徽标 —— 无审批不渲染（字段没有就不显示）。 */}
          {item.pendingApprovals > 0 && (
            <span className="h2-sidebar-attention" data-testid="session-attention" title="有待审批事项">
              {item.pendingApprovals}
            </span>
          )}
        </span>
        <span className="h2-sidebar-session-meta">{rowMeta(item, nowMs, labels)}</span>
      </span>
    </button>
  );
  return (
    <li className={`h2-sidebar-row${unpin ? ' h2-sidebar-row-pinned' : ''}`}>
      {menuActions.length > 0 && rowMenu !== undefined ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{rowButton}</ContextMenuTrigger>
          <SessionRowMenuContent item={item} labels={labels} callbacks={rowMenu} />
        </ContextMenu>
      ) : (
        rowButton
      )}
      {unpin && (
        <button
          type="button"
          className="h2-sidebar-unpin"
          data-testid={`session-unpin-${item.id}`}
          aria-label={labels.unpin}
          title={labels.unpin}
          onClick={() => onTogglePin?.(item.id, false)}
        >
          <span aria-hidden="true">✕</span>
        </button>
      )}
    </li>
  );
}

/** 分组列表（项目区 / 分组模式共用）：组头可折叠，默认展开 */
function GroupList({
  groups,
  collapsedGroups,
  onToggleGroup,
  ctx,
  noProjectLabel,
}: {
  groups: readonly SidebarProjectGroup[];
  collapsedGroups: ReadonlySet<string>;
  onToggleGroup: (key: string) => void;
  ctx: RowContext;
  noProjectLabel: string;
}): React.ReactNode {
  return (
    <div className="h2-sidebar-groups">
      {groups.map((group) => {
        const collapsed = collapsedGroups.has(group.key);
        const name = group.name.length > 0 ? group.name : noProjectLabel;
        return (
          <div className="h2-sidebar-group" key={group.key} data-group-key={group.key}>
            <button
              type="button"
              className="h2-sidebar-group-head"
              data-testid="sidebar-group-head"
              aria-expanded={!collapsed}
              title={group.cwd ?? name}
              onClick={() => onToggleGroup(group.key)}
            >
              <span className={`h2-sidebar-caret${collapsed ? '' : ' h2-sidebar-caret-open'}`} aria-hidden="true">
                ▸
              </span>
              <span className="h2-sidebar-group-name">{name}</span>
              <span className="h2-sidebar-group-count">{group.items.length}</span>
            </button>
            {!collapsed && (
              <ul className="h2-sidebar-group-list">
                {group.items.map((item) => (
                  <SessionRow key={item.id} item={item} ctx={ctx} />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 会话浏览器：区域席位的默认占用方。
 * @param props - 行数据、选中态、搜索、置顶回调与外壳给的宽窄/滚动条事实。
 * @returns 区域元素树。
 */
export function SessionBrowser({
  wide,
  expandSidebar,
  registerScrollRegion,
  scrollBars,
  sessions,
  archived = [],
  selectedId = null,
  query,
  onQueryChange,
  onOpenSession,
  labels,
  rowDrag,
  onTogglePin,
  nowMs = Date.now(),
  initialTaskPreferences,
  /** P0-2（Z-10）右键菜单动作（壳注入；本组件包装 onRename 为打开对话框） */
  rowMenu: rowMenuProp,
  onSubmitRename,
}: SessionBrowserProps): React.ReactNode {
  const [prefs, setPrefs] = useState<SidebarTaskPreferences>({
    ...DEFAULT_SIDEBAR_TASK_PREFERENCES,
    ...initialTaskPreferences,
  });
  // 折叠态全部内存（D-14）：归档视图默认关闭且不持久化（Z-08）。
  const [archivedView, setArchivedView] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(new Set());
  const [pinnedExpanded, setPinnedExpanded] = useState(false);
  // P0-2：重命名对话框目标行（null=关）；右键菜单「重命名」设置，Dialog 提交后清。
  const [renameTarget, setRenameTarget] = useState<SidebarSessionItem | null>(null);

  // 菜单回调：壳给了 onSubmitRename 而没给 onRename → 本组件接管（打开内置对话框）；
  // 壳自带 onRename（如自绘内联编辑）则以壳为准，本组件不截胡。其余透传壳。
  const rowMenu: RowMenuCallbacks | undefined =
    rowMenuProp === undefined && onSubmitRename === undefined
      ? undefined
      : {
          ...rowMenuProp,
          ...(rowMenuProp?.onRename === undefined && onSubmitRename !== undefined
            ? { onRename: (item: SidebarSessionItem) => setRenameTarget(item) }
            : {}),
        };

  if (!wide) {
    // 轨道态：列表让位给一枚图标按钮（D-13 保留 56px 轨道 + 展开入口）。
    return (
      <button
        type="button"
        className="h2-sidebar-rail-icon"
        data-testid="sidebar-region-rail"
        aria-label={labels.sessionsRail}
        title={labels.sessionsRail}
        onClick={expandSidebar}
      >
        <span aria-hidden="true">≡</span>
      </button>
    );
  }

  const searching = query !== undefined && query.trim().length > 0;
  const sections = buildSidebarSections({ active: sessions, archived, prefs, archivedView });
  const groupKeys = sections.flatMap((section) =>
    section.kind === 'projects' || section.kind === 'grouped' ? section.groups.map((g) => g.key) : [],
  );
  const allCollapsed = groupKeys.length > 0 && groupKeys.every((key) => collapsedGroups.has(key));

  const ctx: RowContext = { selectedId, labels, nowMs, onOpenSession, onTogglePin, rowDrag, rowMenu };

  const updatePrefs = (patch: Partial<SidebarTaskPreferences>): void => {
    setPrefs((current) => ({ ...current, ...patch }));
  };
  const toggleGroup = (key: string): void => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleExpandAll = (): void => {
    setCollapsedGroups(allCollapsed ? new Set() : new Set(groupKeys));
  };
  const toggleSection = (kind: string): void => {
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const renderSection = (section: SidebarSection): React.ReactNode => {
    if (section.kind === 'pinned') {
      const rows = pinnedExpanded ? [...section.items, ...section.overflow] : section.items;
      return (
        <section className="h2-sidebar-section h2-sidebar-section-pinned" key="pinned" data-testid="sidebar-pinned">
          <div className="h2-sidebar-section-head">
            <span className="h2-sidebar-section-title">{labels.pinned}</span>
            <span className="h2-sidebar-section-count">{section.total}</span>
          </div>
          <ul className="h2-sidebar-list-inner">
            {rows.map((item) => (
              <SessionRow key={item.id} item={item} ctx={ctx} showUnpin />
            ))}
          </ul>
          {section.overflow.length > 0 && !pinnedExpanded && (
            <button
              type="button"
              className="h2-sidebar-show-all"
              data-testid="sidebar-pinned-show-all"
              onClick={() => setPinnedExpanded(true)}
            >
              {labels.pinnedShowAll(section.overflow.length)}
            </button>
          )}
        </section>
      );
    }
    if (section.kind === 'projects' || section.kind === 'grouped') {
      const title = section.kind === 'projects' ? labels.projects : labels.conversations;
      const collapsed = collapsedSections.has(section.kind);
      return (
        <section
          className="h2-sidebar-section"
          key={section.kind}
          data-testid={section.kind === 'projects' ? 'sidebar-projects' : 'sidebar-grouped'}
        >
          <button
            type="button"
            className="h2-sidebar-section-head h2-sidebar-section-head-toggle"
            data-testid="sidebar-section-head"
            aria-expanded={!collapsed}
            onClick={() => toggleSection(section.kind)}
          >
            <span className={`h2-sidebar-caret${collapsed ? '' : ' h2-sidebar-caret-open'}`} aria-hidden="true">
              ▸
            </span>
            <span className="h2-sidebar-section-title">{title}</span>
          </button>
          {!collapsed && (
            <GroupList
              groups={section.groups}
              collapsedGroups={collapsedGroups}
              onToggleGroup={toggleGroup}
              ctx={ctx}
              noProjectLabel={labels.noProject}
            />
          )}
        </section>
      );
    }
    if (section.kind === 'conversations') {
      const collapsed = collapsedSections.has('conversations');
      return (
        <section className="h2-sidebar-section" key="conversations" data-testid="sidebar-conversations">
          <button
            type="button"
            className="h2-sidebar-section-head h2-sidebar-section-head-toggle"
            data-testid="sidebar-section-head"
            aria-expanded={!collapsed}
            onClick={() => toggleSection('conversations')}
          >
            <span className={`h2-sidebar-caret${collapsed ? '' : ' h2-sidebar-caret-open'}`} aria-hidden="true">
              ▸
            </span>
            <span className="h2-sidebar-section-title">{labels.conversations}</span>
          </button>
          {!collapsed && (
            <ul className="h2-sidebar-list-inner">
              {section.items.map((item) => (
                <SessionRow key={item.id} item={item} ctx={ctx} />
              ))}
            </ul>
          )}
        </section>
      );
    }
    // archived
    return (
      <section className="h2-sidebar-section" key="archived" data-testid="sidebar-archived-section">
        <div className="h2-sidebar-section-head">
          <span className="h2-sidebar-section-title">{labels.archived(archived.length)}</span>
        </div>
        <ul className="h2-sidebar-list-inner">
          {section.items.map((item) => (
            <SessionRow key={item.id} item={item} ctx={ctx} />
          ))}
        </ul>
      </section>
    );
  };

  const hasRows = sections.some((section) =>
    section.kind === 'pinned'
      ? section.items.length + section.overflow.length > 0
      : section.kind === 'projects' || section.kind === 'grouped'
        ? section.groups.some((group) => group.items.length > 0)
        : section.items.length > 0,
  );
  const emptyLabel = searching
    ? labels.noMatch
    : archivedView
      ? labels.noArchived
      : sessions.length === 0 && archived.length > 0
        ? labels.allArchived
        : labels.noSessions;

  return (
    <section className="h2-sidebar-region" aria-label={labels.sessions}>
      <TaskToolbar
        prefs={prefs}
        onChange={updatePrefs}
        archivedView={archivedView}
        onToggleArchived={() => setArchivedView((open) => !open)}
        allCollapsed={allCollapsed}
        onToggleExpandAll={toggleExpandAll}
        labels={labels}
      />
      {onQueryChange !== undefined && (
        <input
          className="h2-sidebar-search"
          type="search"
          value={query ?? ''}
          placeholder={labels.searchPlaceholder}
          aria-label={labels.searchPlaceholder}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      )}
      <div
        ref={registerScrollRegion}
        className="h2-sidebar-list"
        data-testid="sidebar-session-list"
        data-scroll-bars={scrollBars}
      >
        {hasRows ? (
          sections.map(renderSection)
        ) : (
          <div className="h2-sidebar-empty" data-testid="sidebar-empty">
            {emptyLabel}
          </div>
        )}
      </div>
      {renameTarget !== undefined && renameTarget !== null && onSubmitRename !== undefined ? (
        <RenameSessionDialog
          item={renameTarget}
          labels={labels}
          onSubmit={onSubmitRename}
          onClose={() => setRenameTarget(null)}
        />
      ) : null}
    </section>
  );
}

/**
 * 重命名对话框（P0-2；ZCode 无此项像素规格，按本仓 dialog 族做，登记于 issue-log）。
 * 空/全空白名 → 如实拒绝提交（不写脏 title）；提交成功才关闭。
 */
function RenameSessionDialog({
  item,
  labels,
  onSubmit,
  onClose,
}: {
  item: SidebarSessionItem;
  labels: SidebarLabels;
  onSubmit: (id: string, title: string) => Promise<void> | void;
  onClose: () => void;
}): React.ReactNode {
  const [value, setValue] = useState(item.title);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && !submitting;
  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(item.id, trimmed);
      onClose();
    } catch (e) {
      // 失败不关窗，如实显示原因（不静默吞掉）
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md" aria-describedby={undefined} data-testid="rename-session-dialog">
        <DialogHeader>
          <DialogTitle>{labels.renameTitle}</DialogTitle>
        </DialogHeader>
        <input
          className="h2-sidebar-rename-input"
          data-testid="rename-session-input"
          value={value}
          placeholder={labels.renamePlaceholder}
          aria-label={labels.renameTitle}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />
        {error !== null && (
          <p className="h2-sidebar-rename-error" data-testid="rename-session-error">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" size="lg" onClick={onClose}>
            {labels.renameCancel}
          </Button>
          <Button type="button" size="lg" disabled={!canSubmit} onClick={() => void submit()}>
            {labels.renameConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
