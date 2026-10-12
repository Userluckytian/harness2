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

  it('组头「移出项目」：有回调点击带组 cwd；无回调 = disabled 占位', () => {
    const onRemoveProject = vi.fn();
    renderBrowser({
      projects: [
        { cwd: ALPHA, addedAt: 1 },
        { cwd: 'D:/p/beta', addedAt: 2 },
      ],
      sessions: [item('a1', { cwd: ALPHA })],
      onRemoveProject,
    });
    const remove = testButton('sidebar-group-remove-project-D--p-alpha');
    expect(remove.disabled).toBe(false);
    fireEvent.click(remove);
    expect(onRemoveProject).toHaveBeenCalledWith(ALPHA);
    cleanup();
    renderBrowser({ projects: [{ cwd: ALPHA, addedAt: 1 }] });
    const placeholder = testButton('sidebar-group-remove-project-D--p-alpha');
    expect(placeholder.disabled).toBe(true);
    expect(placeholder.getAttribute('data-placeholder')).toBe('true');
    expect(placeholder.getAttribute('title')).toBe(DEFAULT_SIDEBAR_LABELS.removeProjectTodo);
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

  it('无 sessions 无 projects：全局空态照旧（不因新分区结构误判有内容）', () => {
    renderBrowser({});
    expect(screen.getByTestId('sidebar-empty').textContent).toBe(DEFAULT_SIDEBAR_LABELS.noSessions);
  });

  it('仅有空显式项目：不算空态（「暂无任务」组在场，Z-16 #7）', () => {
    renderBrowser({ projects: [{ cwd: ALPHA, addedAt: 1 }] });
    expect(screen.queryByTestId('sidebar-empty')).toBeNull();
  });
});
