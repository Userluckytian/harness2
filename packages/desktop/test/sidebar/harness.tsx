// 侧栏测试夹具（非测试文件：不被 vitest include 匹配）。
// 提供：默认 props 渲染、可交互的收起/展开宿主、溢出与降动效的桩。
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { SidebarRoot, type SidebarRootProps } from '../../src/renderer/sidebar/SidebarRoot.js';
import type { SidebarSessionItem } from '../../src/renderer/sidebar/session-items.js';

/** 最小可用 props：收起态由各自宿主控制，回调默认空实现 */
export const BASE_SIDEBAR_PROPS: SidebarRootProps = {
  collapsed: false,
  onToggleCollapse: () => {},
  onNewSession: () => {},
};

/** 渲染一个受控（固定收起态）的侧栏 */
export function renderSidebar(overrides: Partial<SidebarRootProps> = {}): ReturnType<typeof render> {
  return render(<SidebarRoot {...BASE_SIDEBAR_PROPS} {...overrides} />);
}

/** 收起切换宿主：点击 toggle 真的切换 collapsed（收起动画需要真实的状态来回） */
export function renderCollapsibleSidebar(overrides: Partial<SidebarRootProps> = {}): {
  root: () => HTMLElement;
  toggle: () => void;
  /** 点轨道态的区域图标（展开入口） */
  clickRailRegion: () => void;
} {
  function Harness(props: Partial<SidebarRootProps>): React.ReactNode {
    const [collapsed, setCollapsed] = useState(props.collapsed ?? false);
    return (
      <SidebarRoot
        {...BASE_SIDEBAR_PROPS}
        {...props}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((value) => !value)}
      />
    );
  }
  render(<Harness {...overrides} />);
  return {
    root: () => screen.getByTestId('sidebar-root'),
    toggle: () => fireEvent.click(screen.getByTestId('sidebar-toggle')),
    clickRailRegion: () => fireEvent.click(screen.getByTestId('sidebar-region-rail')),
  };
}

/** 构造一行会话数据（默认：未归档、未运行、无未读） */
export function sessionItem(id: string, overrides: Partial<SidebarSessionItem> = {}): SidebarSessionItem {
  return {
    id,
    title: `会话 ${id}`,
    messageCount: 3,
    mtimeMs: 1_700_000_000_000,
    archived: false,
    running: false,
    unread: 0,
    ...overrides,
  };
}

/** 把元素量成「溢出」（jsdom 无布局：两侧默认都是 0） */
export function stubOverflow(element: HTMLElement, overflowing: boolean): void {
  Object.defineProperty(element, 'scrollHeight', { value: overflowing ? 600 : 200, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: 200, configurable: true });
}

/** 把列矩形钉死，让坐标判定有「内 / 外」可言（jsdom 的 getBoundingClientRect 全是 0） */
export function stubColumnRect(element: HTMLElement, right = 280, bottom = 600): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, right, bottom, x: 0, y: 0, width: right, height: bottom, toJSON: () => ({}) }),
  });
}

/** 媒体查询桩：只让指定查询命中 */
export interface MediaQueryStub {
  readonly queries: string[];
  restore: () => void;
}

/** 安装 matchMedia 桩（forceReduce = true 时 `prefers-reduced-motion: reduce` 命中） */
export function stubMatchMedia(forceReduce: boolean): MediaQueryStub {
  const original = window.matchMedia;
  const queries: string[] = [];
  const matches = (query: string): boolean => forceReduce && query === '(prefers-reduced-motion: reduce)';
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      queries.push(query);
      return {
        matches: matches(query),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      };
    },
  });
  return {
    queries,
    restore: () => {
      Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: original });
    },
  };
}
