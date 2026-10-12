// 任务工具栏（Z8-1 / Z-07 #5 / Z-08）：视图模式分段（分组 | 项目）+ 全部展开/收起
// + 筛选和排序（更新时间/名称 + 全部/运行中/未读）+ 归档开关。
// 纯展示 + 受控回调：偏好由 SessionBrowser 内存持有（D-14，不落盘）。
// ZCode 的 Automations / Plugin Store / 文件树入口**不在此**（不采纳，登记于阶段报告）。
import { useState } from 'react';
import type { SidebarLabels } from './labels.js';
import type { SidebarFilter, SidebarSortBy, SidebarTaskPreferences } from './task-view.js';

export interface TaskToolbarProps {
  prefs: SidebarTaskPreferences;
  /** 偏好变更（分段 / 排序 / 筛选）；调用方内存合并，不落盘 */
  onChange: (patch: Partial<SidebarTaskPreferences>) => void;
  /** 归档视图是否开启（Z-08：默认关闭，不持久化） */
  archivedView: boolean;
  onToggleArchived: () => void;
  /** 所有分组是否都已收起（决定「全部展开/收起」按钮文案） */
  allCollapsed: boolean;
  /** 全部展开/收起切换 */
  onToggleExpandAll: () => void;
  labels: SidebarLabels;
}

/**
 * 渲染任务工具栏。
 * @param props - 偏好、归档开关、展开态与回调。
 * @returns 工具栏元素。
 */
export function TaskToolbar({
  prefs,
  onChange,
  archivedView,
  onToggleArchived,
  allCollapsed,
  onToggleExpandAll,
  labels,
}: TaskToolbarProps): React.ReactNode {
  const [menuOpen, setMenuOpen] = useState(false);
  const pickSort = (sortBy: SidebarSortBy): void => {
    onChange({ sortBy });
    setMenuOpen(false);
  };
  const pickFilter = (filter: SidebarFilter): void => {
    onChange({ filter });
    setMenuOpen(false);
  };

  return (
    <div className="h2-sidebar-toolbar" data-testid="sidebar-task-toolbar">
      <div className="h2-sidebar-segmented" role="group" aria-label={labels.viewModeLabel}>
        <button
          type="button"
          className="h2-sidebar-segment"
          data-testid="sidebar-view-grouped"
          aria-pressed={prefs.viewMode === 'grouped'}
          onClick={() => onChange({ viewMode: 'grouped' })}
        >
          {labels.viewModeGrouped}
        </button>
        <button
          type="button"
          className="h2-sidebar-segment"
          data-testid="sidebar-view-project"
          aria-pressed={prefs.viewMode === 'project'}
          onClick={() => onChange({ viewMode: 'project' })}
        >
          {labels.viewModeProject}
        </button>
      </div>
      <div className="h2-sidebar-toolbar-actions">
        <button
          type="button"
          className="h2-sidebar-tool"
          data-testid="sidebar-expand-toggle"
          aria-label={allCollapsed ? labels.expandAll : labels.collapseAll}
          title={allCollapsed ? labels.expandAll : labels.collapseAll}
          onClick={onToggleExpandAll}
        >
          <span aria-hidden="true">{allCollapsed ? '⊞' : '⊟'}</span>
        </button>
        <div className="h2-sidebar-toolbar-menu-wrap">
          <button
            type="button"
            className="h2-sidebar-tool"
            data-testid="sidebar-filter-sort"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={labels.filterSort}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span aria-hidden="true">⇅</span>
          </button>
          {menuOpen && (
            <div className="h2-sidebar-toolbar-menu" role="menu" data-testid="sidebar-filter-sort-menu">
              <div className="h2-sidebar-menu-group" role="group" aria-label={labels.sortBy}>
                <span className="h2-sidebar-menu-title">{labels.sortBy}</span>
                <button
                  type="button"
                  role="menuitemradio"
                  className="h2-sidebar-menu-item"
                  data-testid="sidebar-sort-updated"
                  aria-checked={prefs.sortBy === 'updated'}
                  onClick={() => pickSort('updated')}
                >
                  {labels.sortByUpdated}
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  className="h2-sidebar-menu-item"
                  data-testid="sidebar-sort-name"
                  aria-checked={prefs.sortBy === 'name'}
                  onClick={() => pickSort('name')}
                >
                  {labels.sortByName}
                </button>
              </div>
              <div className="h2-sidebar-menu-group" role="group" aria-label={labels.filter}>
                <span className="h2-sidebar-menu-title">{labels.filter}</span>
                <button
                  type="button"
                  role="menuitemradio"
                  className="h2-sidebar-menu-item"
                  data-testid="sidebar-filter-all"
                  aria-checked={prefs.filter === 'all'}
                  onClick={() => pickFilter('all')}
                >
                  {labels.filterAll}
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  className="h2-sidebar-menu-item"
                  data-testid="sidebar-filter-running"
                  aria-checked={prefs.filter === 'running'}
                  onClick={() => pickFilter('running')}
                >
                  {labels.filterRunning}
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  className="h2-sidebar-menu-item"
                  data-testid="sidebar-filter-unread"
                  aria-checked={prefs.filter === 'unread'}
                  onClick={() => pickFilter('unread')}
                >
                  {labels.filterUnread}
                </button>
              </div>
            </div>
          )}
        </div>
        <button
          type="button"
          className="h2-sidebar-tool"
          data-testid="sidebar-archived-toggle"
          aria-pressed={archivedView}
          aria-label={labels.archiveView}
          title={labels.archiveView}
          onClick={onToggleArchived}
        >
          <span aria-hidden="true">🗄</span>
        </button>
      </div>
    </div>
  );
}
