// 侧栏区域席位（D-23）：会话列表的宿主实现。
// 依据 refs-deepseek-harness.md D-23「sidebar.workspaces 区域席位 + 底部固定 sidebar.settings 席位」，
// 上游把会话列表放在 ui-workspace 填的 sidebar.workspaces 里；本仓暂不拆包，故在此提供默认占用方。
// 职责边界：
//   - 列表渲染、当前会话高亮、空态；
//   - 轨道态（56px）不渲染列表，只给一枚「展开以浏览会话」图标按钮（D-13 轨道不是消失）；
//   - 滚动容器登记给外壳：D-24 的溢出判定与静默类由外壳统一决定（本组件只暴露 data 属性）。
import { useState } from 'react';
import type { SidebarSessionItem } from './session-items.js';
import type { SidebarLabels } from './labels.js';

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
  /** 已归档会话（折叠区；缺省不渲染该区） */
  archived?: readonly SidebarSessionItem[];
  selectedId?: string | null;
  /** 搜索串（受控）；配合 onQueryChange 提供搜索框 */
  query?: string;
  onQueryChange?: ((query: string) => void) | undefined;
  onOpenSession: (id: string) => void;
  labels: SidebarLabels;
}

/** 一行的时间/条数摘要（本地化时间串，非「刚刚」这类伪造相对时间） */
function rowMeta(item: SidebarSessionItem): string {
  return `${item.messageCount} 条 · ${new Date(item.mtimeMs).toLocaleString()}`;
}

/**
 * 会话浏览器：区域席位的默认占用方。
 * @param props - 行数据、选中态、搜索与外壳给的宽窄/滚动条事实。
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
}: SessionBrowserProps): React.ReactNode {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const searching = query !== undefined && query.trim().length > 0;
  const total = sessions.length + archived.length;
  const emptyLabel = searching ? labels.noMatch : total === 0 ? labels.noSessions : labels.allArchived;

  const renderRow = (item: SidebarSessionItem): React.ReactNode => (
    <li key={item.id} className="h2-sidebar-row">
      <button
        type="button"
        className="h2-sidebar-session"
        data-session-id={item.id}
        data-selected={selectedId === item.id ? 'true' : 'false'}
        data-archived={item.archived ? 'true' : 'false'}
        aria-current={selectedId === item.id ? 'true' : undefined}
        title={item.title}
        onClick={() => onOpenSession(item.id)}
      >
        <span className="h2-sidebar-session-title">
          {item.title}
          {item.running && <span className="h2-sidebar-running" data-testid="session-running" />}
          {item.unread > 0 && <span className="h2-sidebar-unread">{item.unread}</span>}
        </span>
        <span className="h2-sidebar-session-meta">{rowMeta(item)}</span>
      </button>
    </li>
  );

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

  return (
    <section className="h2-sidebar-region" aria-label={labels.sessions}>
      <div className="h2-sidebar-region-head">
        <span className="h2-sidebar-region-title">{labels.sessions}</span>
      </div>
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
      <ul
        ref={registerScrollRegion}
        className="h2-sidebar-list"
        data-testid="sidebar-session-list"
        data-scroll-bars={scrollBars}
      >
        {sessions.length === 0 ? (
          <li className="h2-sidebar-empty" data-testid="sidebar-empty">
            {emptyLabel}
          </li>
        ) : (
          sessions.map(renderRow)
        )}
      </ul>
      {archived.length > 0 && (
        <div className="h2-sidebar-archived">
          <button
            type="button"
            className="h2-sidebar-archived-toggle"
            aria-expanded={archivedOpen}
            onClick={() => setArchivedOpen((open) => !open)}
          >
            <span className={`h2-sidebar-caret${archivedOpen ? ' h2-sidebar-caret-open' : ''}`}>▸</span>
            {labels.archived(archived.length)}
          </button>
          {archivedOpen && <ul className="h2-sidebar-list h2-sidebar-archived-list">{archived.map(renderRow)}</ul>}
        </div>
      )}
    </section>
  );
}
