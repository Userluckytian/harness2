// @vitest-environment jsdom
// P0-3b（Z-16 #6/#7/#9）侧栏项目行渲染：
//   - 项目区头两枚 24×24 钮：「移动项目分区」（恒占位：disabled + data-placeholder）、
//     「添加项目」（有回调 = 真动作可点；无回调 = disabled 占位，红线⑩）；
//   - 任务区头：「移动」占位 + 「新建任务」（无回调 = 占位）；
//   - 显式项目组头（source='project'）右侧「移出项目」钮（有回调点击带 cwd；无回调占位）；
//   - 空组显示「暂无任务」（槽位先行，不隐藏组）；
//   - 反向钉：不传 projects/回调 → 既有渲染不变（聚合组头无钮、无占位残留）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SIDEBAR_LABELS } from '../src/renderer/sidebar/labels.js';
import { SessionBrowser, type WorkspacesOwnerProps } from '../src/renderer/sidebar/SessionBrowser.js';
import type { SidebarSessionItem } from '../src/renderer/sidebar/session-items.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const owner: WorkspacesOwnerProps = {
  wide: true,
  expandSidebar: () => undefined,
  registerScrollRegion: () => undefined,
  scrollBars: 'drawn',
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

function renderBrowser(props: Partial<Parameters<typeof SessionBrowser>[0]> = {}): void {
  render(
    createElement(SessionBrowser, {
      ...owner,
      sessions: [],
      labels: DEFAULT_SIDEBAR_LABELS,
      onOpenSession: () => undefined,
      ...props,
    }),
  );
}

const ALPHA = 'D:/p/alpha';

/** getByTestId 拿 HTMLElement；测 disabled 等按钮属性需窄化为 HTMLButtonElement。 */
function testButton(testId: string): HTMLButtonElement {
  return screen.getByTestId(testId) as HTMLButtonElement;
}

/** Z-48：组头动作钮只在 hover/focus 态 mount —— 悬浮该组头行（jsdom 无 :hover，mouseOver → React onMouseEnter） */
function hoverGroupHead(cwd: string = ALPHA): void {
  const headRow = document.querySelector(`[data-group-key="project:${cwd}"] > .h2-sidebar-group-head-row`);
  if (!headRow) throw new Error(`组头行未找到：project:${cwd}`);
  fireEvent.mouseOver(headRow);
}

describe('项目区头按钮（Z-16 #6）', () => {
  it('「移动项目分区」恒为 disabled 占位（disabled + data-placeholder + title 说明，红线⑩）', () => {
    renderBrowser({ projects: [{ cwd: ALPHA, addedAt: 1 }] });
    const move = testButton('sidebar-projects-move');
    expect(move.disabled).toBe(true);
    expect(move.getAttribute('data-placeholder')).toBe('true');
    expect(move.getAttribute('title')).toBe(DEFAULT_SIDEBAR_LABELS.moveSectionTodo);
  });

  it('无 onAddProject 回调 → 「添加项目」渲染 disabled 占位（web 口径：无通道不摆活钮）', () => {
    renderBrowser({ projects: [{ cwd: ALPHA, addedAt: 1 }] });
    const add = testButton('sidebar-projects-add');
    expect(add.disabled).toBe(true);
    expect(add.getAttribute('data-placeholder')).toBe('true');
    expect(add.getAttribute('title')).toBe(DEFAULT_SIDEBAR_LABELS.addProjectTodo);
  });

  it('有 onAddProject 回调 → 真动作：可点、非占位、点击恰好触发一次', () => {
    const onAddProject = vi.fn();
    renderBrowser({ projects: [{ cwd: ALPHA, addedAt: 1 }], onAddProject });
    const add = testButton('sidebar-projects-add');
    expect(add.disabled).toBe(false);
    expect(add.hasAttribute('data-placeholder')).toBe(false);
    fireEvent.click(add);
    expect(onAddProject).toHaveBeenCalledTimes(1);
  });

  it('任务区头：移动恒占位；新建任务无回调 = 占位、有回调 = 真动作', () => {
    renderBrowser({ sessions: [item('free')], onNewTask: undefined });
    const move = testButton('sidebar-tasks-move');
    expect(move.disabled).toBe(true);
    expect(move.getAttribute('data-placeholder')).toBe('true');
    const newTask = testButton('sidebar-tasks-new');
    expect(newTask.disabled).toBe(true);
    cleanup();
    const onNewTask = vi.fn();
    renderBrowser({ sessions: [item('free')], onNewTask });
    fireEvent.click(screen.getByTestId('sidebar-tasks-new'));
    expect(onNewTask).toHaveBeenCalledTimes(1);
  });
});

describe('显式项目组（Z-16 #7）', () => {
  it('空组如实显示「暂无任务」（组不隐藏——槽位先行）', () => {
    renderBrowser({ projects: [{ cwd: ALPHA, addedAt: 1 }] });
    expect(screen.getByTestId('sidebar-group-empty-project-D--p-alpha').textContent).toBe(
      DEFAULT_SIDEBAR_LABELS.noTasks,
    );
    expect(screen.getByText('alpha')).toBeTruthy();
  });

  it('组头「移出项目」：hover 出现 ⋯，下拉末项「移除」点击带组 cwd（U2 批D / D5：Z-49 入口收进菜单）', async () => {
    const onRemoveProject = vi.fn();
    renderBrowser({
      projects: [
        { cwd: ALPHA, addedAt: 1 },
        { cwd: 'D:/p/beta', addedAt: 2 },
      ],
      sessions: [item('a1', { cwd: ALPHA })],
      onRemoveProject,
    });
    // Z-48：非 hover/focus 态时组头动作不 mount（含 ⋯）
    expect(screen.queryByTestId('sidebar-group-more-project-D--p-alpha')).toBeNull();
    // 悬浮组头触发 hover（jsdom 无 :hover，用 mouseOver → React onMouseEnter）
    hoverGroupHead(ALPHA);
    const trigger = screen.getByTestId('sidebar-group-more-project-D--p-alpha');
    // jsdom 无 PointerEvent：Radix DropdownMenu 用 Enter 键打开
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const menu = await screen.findByTestId('sidebar-group-more-menu-project-D--p-alpha');
    const remove = menu.querySelector('[data-menu-action="remove-project"]')!;
    expect(remove.getAttribute('data-disabled')).toBeNull();
    fireEvent.click(remove);
    // 无 running 会话 → 直接移除，不弹确认（Z-49）
    expect(onRemoveProject).toHaveBeenCalledWith(ALPHA);
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('无回调时 hover 后 ⋯ 菜单里「移除」项 disabled + 说明占位（红线⑩；独立占位钮已删）', async () => {
    renderBrowser({ projects: [{ cwd: ALPHA, addedAt: 1 }] });
    hoverGroupHead(ALPHA);
    // 旧的组头独立「移出项目」钮不再存在（D5）
    expect(screen.queryByTestId('sidebar-group-remove-project-D--p-alpha')).toBeNull();
    fireEvent.keyDown(screen.getByTestId('sidebar-group-more-project-D--p-alpha'), { key: 'Enter' });
    const menu = await screen.findByTestId('sidebar-group-more-menu-project-D--p-alpha');
    const remove = menu.querySelector('[data-menu-action="remove-project"]')!;
    expect(remove.getAttribute('data-disabled')).not.toBeNull();
    expect(remove.getAttribute('title')).toBe(DEFAULT_SIDEBAR_LABELS.removeProjectTodo);
    expect(remove.textContent).toContain(DEFAULT_SIDEBAR_LABELS.menuRemoveProject);
  });

  it('会话按 cwd 归入项目组行；不匹配会话进「任务」区（第二区文案 Z-16 #9）', () => {
    renderBrowser({
      projects: [{ cwd: ALPHA, addedAt: 1 }],
      sessions: [item('in', { cwd: ALPHA }), item('out', { cwd: 'D:/p/other' })],
    });
    const projects = screen.getByTestId('sidebar-projects');
    expect(projects.textContent).toContain('会话 in');
    // 组有会话 → 不画「暂无任务」行
    expect(projects.querySelector('.h2-sidebar-group-empty')).toBeNull();
    const tasks = screen.getByTestId('sidebar-conversations');
    expect(tasks.textContent).toContain('会话 out');
    expect(tasks.querySelector('[data-session-id="in"]')).toBeNull();
  });
});

describe('向后兼容反向钉（不传新 props = 现状不变）', () => {
  it('无 projects：聚合组头不放任何钮/占位（组级 DOM 无残留；分区头钮按 Z-16 #6 恒在）', () => {
    renderBrowser({ sessions: [item('a', { cwd: ALPHA })] });
    const groups = screen.getByTestId('sidebar-projects');
    // 组级：聚合组（无 source='project'）不放「移出项目」、不画「暂无任务」。
    expect(groups.querySelector('.h2-sidebar-group [data-testid^="sidebar-group-remove"]')).toBeNull();
    expect(groups.querySelector('.h2-sidebar-group-empty')).toBeNull();
  });

  it('无 sessions 无 projects：U2 批D（D6）空侧栏保骨架——两区头照画 + 区内「暂无」（不再单条全局空态）', () => {
    renderBrowser({});
    // 骨架：项目 / 任务两区头在场（恒 2 枚）
    expect(screen.getAllByTestId('sidebar-section-head')).toHaveLength(2);
    expect(screen.getByTestId('sidebar-projects-empty').textContent).toBe(DEFAULT_SIDEBAR_LABELS.noProjects);
    expect(screen.getByTestId('sidebar-section-empty').textContent).toBe(DEFAULT_SIDEBAR_LABELS.noTasks);
    // 不摆假会话行
    expect(document.querySelectorAll('[data-session-id]')).toHaveLength(0);
    // 指向性空态（归档滞留 / 搜索无匹配）仍走单条全局提示
    cleanup();
    renderBrowser({ archived: [item('z', { archived: true })] });
    expect(screen.getByTestId('sidebar-empty').textContent).toBe(DEFAULT_SIDEBAR_LABELS.allArchived);
    cleanup();
    renderBrowser({ query: 'zzz', onQueryChange: () => undefined });
    expect(screen.getByTestId('sidebar-empty').textContent).toBe(DEFAULT_SIDEBAR_LABELS.noMatch);
  });

  it('仅有空显式项目：不算空态（「暂无任务」组在场，Z-16 #7）', () => {
    renderBrowser({ projects: [{ cwd: ALPHA, addedAt: 1 }] });
    expect(screen.queryByTestId('sidebar-empty')).toBeNull();
  });
});
