// @vitest-environment jsdom
// P0-3d（Z-16 侧栏 1:1 槽位校正）machine 断言（阶段计划 §6：placeholder 旗标可 machine 断言）：
//   - #1/#2 文案：新建任务（Ctrl+N 保留）/ 搜索（Ctrl+K 保留，行为仍开命令面板）；
//   - #3 自动化两壳都摆：真回调 = 真入口（桌面）；无回调 + placeholders = disabled 占位槽（web），
//     title「web 无本地 cron 通道」+ data-placeholder；
//   - #10 footer 固定账号：视觉如实（「本地用户」+ 头像槽）+ disabled + data-placeholder + title；
//     P0-3a 的窄占位（sidebar-account-placeholder）已退役；
//   - #5 工具栏 tab 语义（role=tablist / role=tab + aria-selected）；
//   - #8 组内超 20 折叠「显示更多」（与 Pinned 同型）。
import { afterEach, describe, expect, it, vi } from 'vitest';
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

function renderRoot(overrides: Partial<SidebarRootProps> = {}): void {
  render(<SidebarRoot {...BASE} {...overrides} />);
}

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

describe('Z-16 #1/#2 文案校正', () => {
  it('新建任务按钮 =「新建任务」（原「新会话」）+ Ctrl+N 提示保留', () => {
    renderRoot({ newSessionShortcut: 'Ctrl+N' });
    const button = screen.getByTestId('sidebar-new-session');
    expect(button.textContent).toContain('新建任务');
    expect(button.textContent).not.toContain('新会话');
    expect(button.textContent).toContain('Ctrl+N');
  });

  it('搜索槽 =「搜索」（原「命令中心」）+ Ctrl+K；点击仍走命令面板回调', () => {
    const open = vi.fn();
    renderRoot({ onOpenCommandPalette: open });
    const button = screen.getByTestId('sidebar-command-center');
    expect(button.textContent).toContain('搜索');
    expect(button.textContent).not.toContain('命令中心');
    expect(button.textContent).toContain('Ctrl+K');
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('Z-16 #3 自动化两壳都摆', () => {
  it('桌面口径：有真回调 = 真入口（enabled、无 placeholder 旗标）', () => {
    const open = vi.fn();
    renderRoot({ onOpenAutomations: open, placeholders: true });
    const button = screen.getByTestId('sidebar-automation-entry') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('data-placeholder')).toBe(false);
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('web 口径：无回调 + placeholders → disabled 占位槽（title = web 无本地 cron 通道 + data-placeholder）', () => {
    renderRoot({ placeholders: true });
    const button = screen.getByTestId('sidebar-automation-entry') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('data-placeholder')).toBe('true');
    expect(button.getAttribute('title')).toBe('web 无本地 cron 通道');
    expect(button.textContent).toContain('自动化');
  });

  it('两旗标都不给 → 不渲染（不把入口强加给不要它的宿主）', () => {
    renderRoot();
    expect(screen.queryByTestId('sidebar-automation-entry')).toBeNull();
    expect(screen.queryByTestId('sidebar-plugin-market-placeholder')).toBeNull();
    expect(screen.queryByTestId('sidebar-account-slot')).toBeNull();
  });
});

describe('Z-16 #10 footer 固定账号槽（用户拍板：写死固定账号，视觉如实）', () => {
  it('placeholders → 账号槽显示「本地用户」+ 32px 头像圆槽；无动作 = disabled + data-placeholder + title', () => {
    renderRoot({ placeholders: true });
    const slot = screen.getByTestId('sidebar-account-slot') as HTMLButtonElement;
    expect(slot.textContent).toContain('本地用户');
    expect(slot.textContent).not.toContain('未登录');
    expect(slot.disabled).toBe(true);
    expect(slot.getAttribute('data-placeholder')).toBe('true');
    expect(slot.getAttribute('title')).toBe('本地构建 · 无账号体系');
    expect(slot.querySelector('.h2-sidebar-account-avatar')).not.toBeNull();
  });

  it('账号文案进 labels 默认值且可注入覆盖', () => {
    expect(DEFAULT_SIDEBAR_LABELS.accountName).toBe('本地用户');
    renderRoot({ placeholders: true, labels: { accountName: '旅行者' } });
    expect(screen.getByTestId('sidebar-account-slot').textContent).toContain('旅行者');
  });

  it('P0-3a 窄占位实现已退役（sidebar-account-placeholder 不复存在）', () => {
    renderRoot({ placeholders: true });
    expect(screen.queryByTestId('sidebar-account-placeholder')).toBeNull();
  });
});

describe('Z-16 #5 工具栏 tab 语义', () => {
  it('视图模式分段 = role=tablist + role=tab + aria-selected（切换真实跟随点击）', () => {
    renderRoot({ sessions: [item('a', { cwd: 'D:/p/alpha' })] });
    const segmented = document.querySelector('.h2-sidebar-segmented');
    expect(segmented?.getAttribute('role')).toBe('tablist');
    const project = screen.getByTestId('sidebar-view-project');
    const grouped = screen.getByTestId('sidebar-view-grouped');
    expect(project.getAttribute('role')).toBe('tab');
    expect(grouped.getAttribute('role')).toBe('tab');
    expect(project.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(grouped);
    expect(grouped.getAttribute('aria-selected')).toBe('true');
    expect(project.getAttribute('aria-selected')).toBe('false');
  });
});

describe('Z-16 #8 组内超 20 条折叠「显示更多」', () => {
  it('组 25 条 → 首屏 20 + 钮；点击后 25 条全可见（钮消失）', () => {
    const sessions = Array.from({ length: 25 }, (_, i) => item(`s${i}`, { cwd: 'D:/p/alpha' }));
    renderRoot({ sessions });
    const idsIn = (): Array<string | null> =>
      [...document.querySelectorAll('[data-testid="sidebar-projects"] [data-session-id]')].map((el) =>
        el.getAttribute('data-session-id'),
      );
    expect(idsIn().length).toBe(20);
    const more = screen.getByTestId('sidebar-group-show-all-D--p-alpha');
    expect(more.textContent).toContain('显示全部');
    fireEvent.click(more);
    expect(idsIn().length).toBe(25);
    expect(screen.queryByTestId('sidebar-group-show-all-D--p-alpha')).toBeNull();
  });

  it('≤20 条不出现「显示更多」（红线⑩：无溢出就不摆钮）', () => {
    const sessions = Array.from({ length: 20 }, (_, i) => item(`s${i}`, { cwd: 'D:/p/alpha' }));
    renderRoot({ sessions });
    expect(screen.queryByTestId('sidebar-group-show-all-D--p-alpha')).toBeNull();
  });
});

describe('Z-16 #9 项目模式「任务」section 恒在（空区如实「暂无任务」）', () => {
  it('会话全有 cwd（loose 为空）→ 两枚 section 头恒在 + 任务区「暂无任务」空态行', () => {
    renderRoot({ sessions: [item('a', { cwd: 'D:/p/alpha' }), item('b', { cwd: 'D:/p/beta' })] });
    // 「项目」「任务」两枚 section 头都在（ZCode 实测 y=252/280 恒在）
    expect(screen.getAllByTestId('sidebar-section-head')).toHaveLength(2);
    const tasks = screen.getByTestId('sidebar-conversations');
    expect(tasks.textContent).toContain(DEFAULT_SIDEBAR_LABELS.tasks);
    // 空任务区如实显示「暂无任务」（真实空态，不摆假行）
    expect(screen.getByTestId('sidebar-section-empty').textContent).toBe(DEFAULT_SIDEBAR_LABELS.noTasks);
    expect(tasks.querySelector('[data-session-id]')).toBeNull();
  });

  it('显式项目模式（projects 非空、会话全归项目 → loose 空）同上', () => {
    renderRoot({
      projects: [{ cwd: 'D:/p/alpha', addedAt: 1 }],
      sessions: [item('a', { cwd: 'D:/p/alpha' })],
    });
    expect(screen.getAllByTestId('sidebar-section-head')).toHaveLength(2);
    const tasks = screen.getByTestId('sidebar-conversations');
    expect(tasks.textContent).toContain(DEFAULT_SIDEBAR_LABELS.tasks);
    expect(screen.getByTestId('sidebar-section-empty').textContent).toBe(DEFAULT_SIDEBAR_LABELS.noTasks);
    // 全局空态不误判（有项目组在场）
    expect(screen.queryByTestId('sidebar-empty')).toBeNull();
  });

  it('反向钉：grouped（分组）模式行为不变——无任务区、无 section 空态行', () => {
    renderRoot({ sessions: [item('a', { cwd: 'D:/p/alpha' })] });
    fireEvent.click(screen.getByTestId('sidebar-view-grouped'));
    expect(screen.getByTestId('sidebar-grouped')).toBeTruthy();
    expect(screen.queryByTestId('sidebar-conversations')).toBeNull();
    expect(screen.queryByTestId('sidebar-section-empty')).toBeNull();
    // 分组模式只剩一枚 section 头（分组区）
    expect(screen.getAllByTestId('sidebar-section-head')).toHaveLength(1);
  });
});
