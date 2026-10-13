// @vitest-environment jsdom
// 侧栏图标化 + 页脚账号块两行（2026-10-13 视觉优化）machine 断言：
//   - 顶部四钮 / 工具栏三钮 / 分区头 / 组头 / 行内钮：字形文本（＋ ⊟ ⇅ 🗄 ▸ ⠿ ⋯ ✕ 📌 ≡）全部换成
//     仓库既有图标库 lucide 的 SVG（`<svg class="lucide ...">`），尺寸按 ZCode 实测（顶部 16、其余 14）；
//   - 可访问名逐项保留（aria-label / title 不变）；
//   - 页脚账号块 = 两行：上行「用户名」、下行「连接状态」（renderAccountStatus 席位，用户名之后）。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SIDEBAR_LABELS } from '../src/renderer/sidebar/labels.js';
import { SidebarRoot, type SidebarRootProps } from '../src/renderer/sidebar/SidebarRoot.js';
import type { SidebarSessionItem } from '../src/renderer/sidebar/session-items.js';

afterEach(() => cleanup());

const BASE: SidebarRootProps = {
  collapsed: false,
  onToggleCollapse: () => undefined,
  onNewSession: () => undefined,
};

const NOW = 1_700_000_000_000;
const item = (id: string, overrides: Partial<SidebarSessionItem> = {}): SidebarSessionItem => ({
  id,
  title: `会话 ${id}`,
  messageCount: 2,
  mtimeMs: NOW,
  archived: false,
  running: false,
  unread: 0,
  pendingApprovals: 0,
  pinned: false,
  ...overrides,
});

function renderRoot(overrides: Partial<SidebarRootProps> = {}): void {
  render(<SidebarRoot {...BASE} {...overrides} />);
}

/** 断言按钮内存在一枚 lucide SVG 且 width/height 等于给定尺寸。 */
function expectIcon(button: HTMLElement, size: number): void {
  const svg = button.querySelector('svg');
  expect(svg, `按钮 ${button.getAttribute('data-testid')} 缺图标`).not.toBeNull();
  expect(svg?.getAttribute('class') ?? '').toContain('lucide');
  expect(svg?.getAttribute('width')).toBe(String(size));
  expect(svg?.getAttribute('height')).toBe(String(size));
}

describe('顶部四钮图标化（16×16，可访问名保留）', () => {
  it('新建任务 / 搜索 / 自动化 / 插件市场各含 16×16 lucide 图标', () => {
    renderRoot({ onOpenCommandPalette: () => undefined, onOpenAutomations: () => undefined, placeholders: true });
    expectIcon(screen.getByTestId('sidebar-new-session'), 16);
    expectIcon(screen.getByTestId('sidebar-command-center'), 16);
    expectIcon(screen.getByTestId('sidebar-automation-entry'), 16);
    expectIcon(screen.getByTestId('sidebar-plugin-market-placeholder'), 16);
  });

  it('可访问名沿用既有 labels（不因换图标而丢）', () => {
    renderRoot({ onOpenCommandPalette: () => undefined, onOpenAutomations: () => undefined, placeholders: true });
    expect(screen.getByTestId('sidebar-new-session').getAttribute('aria-label')).toBe(
      DEFAULT_SIDEBAR_LABELS.newSessionLabel,
    );
    expect(screen.getByTestId('sidebar-command-center').getAttribute('aria-label')).toBe(
      DEFAULT_SIDEBAR_LABELS.commandCenterLabel,
    );
    expect(screen.getByTestId('sidebar-automation-entry').getAttribute('aria-label')).toBe(
      DEFAULT_SIDEBAR_LABELS.automationEntry,
    );
    expect(screen.getByTestId('sidebar-plugin-market-placeholder').getAttribute('aria-label')).toBe(
      DEFAULT_SIDEBAR_LABELS.pluginMarketTodo,
    );
  });
});

describe('工具栏三钮图标化（14×14，可访问名保留）', () => {
  it('收起全部 / 筛选和排序 / 归档各含 14×14 lucide 图标 + aria-label/title', () => {
    renderRoot({ sessions: [item('a', { cwd: 'D:/p/alpha' })] });
    const expand = screen.getByTestId('sidebar-expand-toggle');
    expectIcon(expand, 14);
    expect(expand.getAttribute('aria-label')).toBe(DEFAULT_SIDEBAR_LABELS.collapseAll);

    const filter = screen.getByTestId('sidebar-filter-sort');
    expectIcon(filter, 14);
    expect(filter.getAttribute('aria-label')).toBe(DEFAULT_SIDEBAR_LABELS.filterSort);
    expect(filter.getAttribute('title')).toBe(DEFAULT_SIDEBAR_LABELS.filterSort);

    const archive = screen.getByTestId('sidebar-archived-toggle');
    expectIcon(archive, 14);
    expect(archive.getAttribute('aria-label')).toBe(DEFAULT_SIDEBAR_LABELS.archiveView);
  });
});

describe('分区头 / 组头 / 行内图标化（14×14）', () => {
  it('分区头折叠 chevron + 组头文件夹图标 + 组头右侧钮', () => {
    renderRoot({
      sessions: [item('a', { cwd: 'D:/p/alpha' })],
      projects: [{ cwd: 'D:/p/alpha', addedAt: 1 }],
    });
    // 分区头：折叠 chevron（两枚：项目 / 任务）
    const heads = screen.getAllByTestId('sidebar-section-head');
    expect(heads.length).toBe(2);
    for (const head of heads) expectIcon(head, 14);

    // 组头：文件夹图标（对齐 ZCode 项目行）
    const groupHead = screen.getByTestId('sidebar-group-head');
    expect(groupHead.querySelector('svg.lucide-folder')).not.toBeNull();
    expectIcon(groupHead, 14);

    // 组头右侧「移出项目」14×14 —— Z-48：动作钮只在 hover/focus 态 mount，先悬浮组头行
    const headRow = document.querySelector('[data-group-key="project:D:/p/alpha"] > .h2-sidebar-group-head-row');
    expect(headRow).not.toBeNull();
    fireEvent.mouseOver(headRow as Element);
    expectIcon(screen.getByTestId('sidebar-group-remove-project-D--p-alpha'), 14);

    // 分区头右侧「移动」占位 + 「添加项目」14×14
    expectIcon(screen.getByTestId('sidebar-projects-move'), 14);
    expectIcon(screen.getByTestId('sidebar-projects-add'), 14);
    expect(screen.getByTestId('sidebar-projects-add').getAttribute('aria-label')).toBe(
      DEFAULT_SIDEBAR_LABELS.addProject,
    );
    // 任务区头两枚钮
    expectIcon(screen.getByTestId('sidebar-tasks-move'), 14);
    expectIcon(screen.getByTestId('sidebar-tasks-new'), 14);
  });

  it('行内「更多操作」= 14×14 lucide 图标（aria-label 保留）', () => {
    renderRoot({
      sessions: [item('a', { cwd: 'D:/p/alpha' })],
      rowMenu: { onArchive: () => undefined },
    });
    const more = screen.getByTestId('session-row-more-a');
    expectIcon(more, 14);
    expect(more.getAttribute('aria-label')).toBe(DEFAULT_SIDEBAR_LABELS.rowMore);
  });
});

describe('页脚账号块两行：连接状态在用户名下方（Z-16 #10 校正）', () => {
  it('renderAccountStatus 注入 → 状态行位于账号块内、用户名之后', () => {
    renderRoot({
      placeholders: true,
      renderAccountStatus: () => (
        <span className="badge badge-connected">
          <span className="dot" />
          已连接
        </span>
      ),
    });
    const account = screen.getByTestId('sidebar-account-slot');
    const status = screen.getByTestId('sidebar-account-status');
    // 状态行在账号块内
    expect(account.contains(status)).toBe(true);
    // DOM 顺序：用户名在前、状态行在后（同一正文列两行）
    const label = account.querySelector('.h2-sidebar-account-label');
    expect(label).not.toBeNull();
    expect(label !== null && (label.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(
      true,
    );
    // 状态行沿用 badge-connected 语义（色/文案）
    expect(status.querySelector('.badge-connected')?.textContent).toContain('已连接');
    expect(status.querySelector('.dot')).not.toBeNull();
  });

  it('缺省不注入 → 不画状态行（不摆假状态）', () => {
    renderRoot({ placeholders: true });
    expect(screen.queryByTestId('sidebar-account-status')).toBeNull();
    // 账号槽本身仍在（placeholders 旗标未变）
    expect(screen.getByTestId('sidebar-account-slot')).not.toBeNull();
  });
});
