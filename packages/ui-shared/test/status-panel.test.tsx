// @vitest-environment jsdom
// 会话状态面板（Z-95 / Z-17）：纯模型（子块汇总 / 胶囊兜底链 / 图标归类）+ 组件（有内容才渲染、
// 子块默认展开、胶囊点击展开、变体菜单）。数据源核实结论见 status-panel-model.ts 文件头。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AppStore } from '../src/renderer/store.js';
import type { PlanStateShape, ChangeSetShape, TaskContractShape } from '../src/shared/protocol.js';
import {
  activeSections,
  capsuleEntryOf,
  capsuleIconKindOf,
  collectStatusData,
  countDiffLines,
  gitSummaryOf,
  planSummaryOf,
  agentsSummaryOf,
} from '../src/renderer/conversation/status-panel/status-panel-model.js';
import { ConversationStatusPanel } from '../src/renderer/conversation/status-panel/ConversationStatusPanel.js';

afterEach(cleanup);

// —— 夹具 ——

const planWithSteps: PlanStateShape = {
  planId: 'p1',
  goal: '实现状态面板',
  steps: [
    { stepId: 'step-a', state: 'completed', evidence: { source: 'runtime-journal', taskId: 't1', journalSeqs: [1] } },
    { stepId: 'step-b', state: 'running', evidence: { source: 'runtime-journal', taskId: 't2', journalSeqs: [2] } },
  ],
  readOnly: true,
  sourceDir: 'd',
};

const changeSet: ChangeSetShape = {
  sourceDir: 'd',
  files: [
    {
      file: 'a.ts',
      planned: { before: 'x\ny\n', after: 'x\nY\nZ\n' },
      current: 'x\nY\nZ\n',
      lastKnown: 'x\nY\nZ\n',
      dirty: false,
      matchesPlan: true,
    },
    {
      file: 'b.ts',
      planned: { before: null, after: 'new\n' },
      current: 'new\n',
      lastKnown: 'new\n',
      dirty: false,
      matchesPlan: true,
    },
  ],
  changedFiles: 2,
  dirtyFiles: 0,
  readOnly: true,
};

function task(partial: Partial<TaskContractShape> & { taskId: string }): TaskContractShape {
  return { background: true, state: 'running', ...partial };
}

// —— 纯模型 ——

describe('countDiffLines（+/− 行数，与 DiffCard 同 diffLines 口径）', () => {
  it('逐行计数；末尾空行不计数', () => {
    expect(countDiffLines('x\ny\n', 'x\nY\nZ\n')).toEqual({ added: 2, deleted: 1 });
  });
  it('null before = 全新增；一致 = 零变更', () => {
    expect(countDiffLines(null, 'a\n')).toEqual({ added: 1, deleted: 0 });
    expect(countDiffLines('a\n', 'a\n')).toEqual({ added: 0, deleted: 0 });
  });
});

describe('gitSummaryOf（Git 子块 = S7 changeReview）', () => {
  it('无数据 / 零变更 → null（不摆空壳）', () => {
    expect(gitSummaryOf(undefined)).toBeNull();
    expect(gitSummaryOf({ ...changeSet, changedFiles: 0, dirtyFiles: 0, files: [] })).toBeNull();
  });
  it('半份投影不崩溃（P1-1 同款连带防御）：桥返回 {} / files 缺失 → 无子块', () => {
    expect(gitSummaryOf({} as ChangeSetShape)).toBeNull();
    expect(gitSummaryOf({ changedFiles: 0, dirtyFiles: 0 } as unknown as ChangeSetShape)).toBeNull();
  });
  it('文件数 + 逐文件与合计 +/-（拟议 before/after 现算）', () => {
    const summary = gitSummaryOf(changeSet);
    expect(summary).not.toBeNull();
    expect(summary?.changedFiles).toBe(2);
    expect(summary?.files[0]).toEqual({ file: 'a.ts', dirty: false, added: 2, deleted: 1 });
    expect(summary?.files[1]).toEqual({ file: 'b.ts', dirty: false, added: 1, deleted: 0 });
    expect(summary?.added).toBe(3);
    expect(summary?.deleted).toBe(1);
  });
  it('仅外部改动（changedFiles=0 但 dirtyFiles>0）也有子块', () => {
    const summary = gitSummaryOf({ ...changeSet, changedFiles: 0, dirtyFiles: 1 });
    expect(summary).not.toBeNull();
    expect(summary?.dirtyFiles).toBe(1);
  });
});

describe('planSummaryOf（Plan 子块 = S7 planState）', () => {
  it('无计划 → null；空计划（无 goal 无步骤）→ null', () => {
    expect(planSummaryOf(undefined)).toBeNull();
    expect(planSummaryOf(null)).toBeNull();
    expect(planSummaryOf({ ...planWithSteps, goal: '', steps: [] })).toBeNull();
  });
  it('完成度 / 当前步骤 / 短标签', () => {
    const summary = planSummaryOf(planWithSteps);
    expect(summary?.completed).toBe(1);
    expect(summary?.total).toBe(2);
    expect(summary?.activeStepId).toBe('step-b');
    expect(summary?.steps[1]?.label).toBe('运行');
  });
  it('仅 goal 无步骤 → 有子块（activeStepId 缺省）', () => {
    const summary = planSummaryOf({ ...planWithSteps, steps: [] });
    expect(summary).not.toBeNull();
    expect(summary?.activeStepId).toBeUndefined();
  });
});

describe('agentsSummaryOf（Agents 子块 = stream.tasks）', () => {
  it('无任务 → null', () => {
    expect(agentsSummaryOf(undefined)).toBeNull();
  });
  it('非终态计数：running / waiting-approval；终态不进 active', () => {
    const stream = {
      tasks: [
        task({ taskId: 'bg-c1', state: 'running' }),
        task({ taskId: 'bg-c2', state: 'waiting-approval' }),
        task({ taskId: 'bg-c3', state: 'completed' }),
      ],
    } as never;
    const summary = agentsSummaryOf(stream);
    expect(summary?.running).toBe(1);
    expect(summary?.waitingApproval).toBe(1);
    expect(summary?.total).toBe(3);
    expect(summary?.active.map((t) => t.taskId)).toEqual(['bg-c1', 'bg-c2']);
  });
});

describe('胶囊兜底链（Z-95：goal → git → 完成度 → 运行计数）', () => {
  it('链 1 优先：有 goal 取 goal（当前 Todo/活跃 Goal 的降级位，缺独立 todo/goal 数据）', () => {
    const data = collectStatusData(undefined, { planState: planWithSteps } as never);
    expect(capsuleEntryOf(data)).toEqual({ kind: 'plan-goal', text: '实现状态面板' });
  });
  it('无 goal 有 git → 链 2（+/−）', () => {
    const data = collectStatusData(undefined, {
      planState: { ...planWithSteps, goal: '' },
      changeReview: changeSet,
    } as never);
    expect(capsuleEntryOf(data)).toEqual({ kind: 'git-changes', added: 3, deleted: 1 });
  });
  it('无 goal 无 git 有步骤 → 链 3（完成/总数）', () => {
    const data = collectStatusData(undefined, {
      planState: { ...planWithSteps, goal: '' },
    } as never);
    expect(capsuleEntryOf(data)).toEqual({ kind: 'plan-progress', completed: 1, total: 2 });
  });
  it('全空但有运行任务 → 链 4（运行计数）', () => {
    const stream = { tasks: [task({ taskId: 'bg-c1' })], running: true } as never;
    const data = collectStatusData(stream, { planState: null } as never);
    expect(capsuleEntryOf(data)).toEqual({ kind: 'running', runningTurns: 1, runningTasks: 1 });
  });
  it('全空 → null', () => {
    expect(capsuleEntryOf(collectStatusData(undefined, { planState: null } as never))).toBeNull();
  });
});

describe('胶囊图标归类（Z-95：恰好一类取对应图标，混合取 Activity）', () => {
  it('恰好一类', () => {
    expect(capsuleIconKindOf({ git: null, plan: planSummaryOf(planWithSteps), agents: null, runningTurns: 0 })).toBe(
      'plan',
    );
    expect(capsuleIconKindOf({ git: gitSummaryOf(changeSet), plan: null, agents: null, runningTurns: 0 })).toBe('git');
    expect(
      capsuleIconKindOf({
        git: null,
        plan: null,
        agents: agentsSummaryOf({ tasks: [task({ taskId: 'b' })] } as never),
        runningTurns: 0,
      }),
    ).toBe('agents');
  });
  it('混合 / 全空 → activity', () => {
    expect(
      capsuleIconKindOf({
        git: gitSummaryOf(changeSet),
        plan: planSummaryOf(planWithSteps),
        agents: null,
        runningTurns: 0,
      }),
    ).toBe('activity');
    expect(capsuleIconKindOf({ git: null, plan: null, agents: null, runningTurns: 0 })).toBe('activity');
  });
});

describe('activeSections（子块注册表：有数据才在列，顺序 = Z-95）', () => {
  it('全有数据 → git, plan, agents；全空 → 空列表', () => {
    const stream = { tasks: [task({ taskId: 'b' })] } as never;
    const full = collectStatusData(stream, { planState: planWithSteps, changeReview: changeSet } as never);
    expect(activeSections(full).map((s) => s.key)).toEqual(['git', 'plan', 'agents']);
    expect(activeSections(collectStatusData(undefined, undefined))).toEqual([]);
  });
});

// —— 组件 ——

function seedStore(): AppStore {
  const store = new AppStore();
  store.setPlanState('s1', planWithSteps);
  store.setChangeReview('s1', changeSet);
  store.setExecutionViews('s1', []);
  return store;
}

/** 给会话塞一张运行中的后台任务（resume-snapshot 同路径；当前实现 = 后台子代理） */
function seedTask(store: AppStore, sessionId = 's1'): void {
  store.applyFrame({
    type: 'resume-snapshot',
    sessionId,
    epoch: 1,
    snapshot: {
      epoch: 1,
      replay: { fromSeq: 0, toSeq: 0 },
      tasks: [task({ taskId: 'bg-c1', state: 'running' })],
      pendingApprovals: [],
      queue: [],
    },
  });
}

/** auto 模式下面板与胶囊同时挂载：取宽面板子树做作用域断言（避免双形态同名文本歧义） */
function widePanel(container: HTMLElement): HTMLElement {
  const wide = container.querySelector('[data-testid="status-panel-auto-wide"]');
  if (wide === null) throw new Error('auto 模式未渲染宽面板');
  return wide as HTMLElement;
}

describe('ConversationStatusPanel 组件', () => {
  it('无数据 → null（Z-17：有内容才渲染，不摆假面板）', () => {
    const { container } = render(<ConversationStatusPanel store={new AppStore()} sessionId="s1" />);
    expect(container.querySelector('[data-testid="conversation-status-panel-expanded"]')).toBeNull();
    expect(container.querySelector('[data-testid="conversation-status-panel-capsule"]')).toBeNull();
  });

  it('auto 变体：面板与 mini 胶囊都挂载（容器查询由 CSS 决定，jsdom 无布局）', () => {
    const store = seedStore();
    const { container } = render(<ConversationStatusPanel store={store} sessionId="s1" />);
    expect(container.querySelector('[data-testid="status-panel-auto-wide"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="status-panel-auto-mini"]')).not.toBeNull();
    // 面板本体：Z-95 容器规格
    const panel = widePanel(container).querySelector('[data-testid="conversation-status-panel-expanded"]');
    expect(panel?.className).toContain('rounded-2xl');
    expect(panel?.className).toContain('bg-popover');
    expect(panel?.className).toContain('w-80');
    // 胶囊走兜底链第一位 = goal 文案；面板 goal 行与胶囊各渲染一份（双形态并存）
    expect(within(widePanel(container)).getByTitle('实现状态面板')).toBeTruthy();
    expect(container.querySelector('[data-testid="status-panel-auto-mini"] [title="实现状态面板"]')).not.toBeNull();
  });

  it('子块默认展开：Git/Plan 展开（内容可见）、Agents 收起（Z-17 矩阵）', () => {
    const store = seedStore();
    seedTask(store);
    const { container } = render(<ConversationStatusPanel store={store} sessionId="s1" variant="auto" />);
    const wide = widePanel(container);
    // Git 展开可见：逐文件 +/- 行
    expect(within(wide).getByTitle('a.ts')).toBeTruthy();
    expect(within(wide).getByText('+2')).toBeTruthy();
    expect(within(wide).getByText('−1')).toBeTruthy();
    // Plan 展开可见：goal + 步骤
    expect(within(wide).getByText('实现状态面板')).toBeTruthy();
    expect(within(wide).getByText('step-b')).toBeTruthy();
    // Agents 默认收起：任务 id 不可见；头部计数可见
    expect(within(wide).queryByText('bg-c1')).toBeNull();
    expect(within(wide).getByText('运行 1')).toBeTruthy();
    // 头部 aria-expanded 如实
    expect(wide.querySelector('[data-testid="status-section-agents"] button')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('点击子块头部切换展开（组件内 state，不落盘）', () => {
    const store = seedStore();
    seedTask(store);
    const { container } = render(<ConversationStatusPanel store={store} sessionId="s1" variant="auto" />);
    const wide = widePanel(container);
    const agentsHeader = wide.querySelector('[data-testid="status-section-agents"] button') as HTMLButtonElement;
    expect(agentsHeader.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(agentsHeader);
    expect(agentsHeader.getAttribute('aria-expanded')).toBe('true');
    // 展开后任务行可见（胶囊不含任务 id，不干扰断言）
    expect(within(wide).getByText('bg-c1')).toBeTruthy();
    // 再点回收起
    fireEvent.click(agentsHeader);
    expect(agentsHeader.getAttribute('aria-expanded')).toBe('false');
    expect(within(wide).queryByText('bg-c1')).toBeNull();
  });

  it('胶囊态：渲染胶囊；点击胶囊切回展开态（Z-95）', () => {
    const store = seedStore();
    const { container } = render(<ConversationStatusPanel store={store} sessionId="s1" variant="capsule" />);
    expect(container.querySelector('[data-testid="conversation-status-panel-capsule"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="conversation-status-panel-expanded"]')).toBeNull();
    fireEvent.click(screen.getByTestId('status-capsule-expand'));
    expect(container.querySelector('[data-testid="conversation-status-panel-expanded"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="conversation-status-panel-capsule"]')).toBeNull();
  });

  it('胶囊兜底链在组件里的顺序：git-only 会话显示 +/−', () => {
    const store = new AppStore();
    store.setChangeReview('s1', changeSet);
    render(<ConversationStatusPanel store={store} sessionId="s1" variant="capsule" />);
    expect(screen.getByText('+3')).toBeTruthy();
    expect(screen.getByText('−1')).toBeTruthy();
  });

  it('胶囊兜底链在组件里的顺序：goal 优先于 git', () => {
    const store = seedStore();
    render(<ConversationStatusPanel store={store} sessionId="s1" variant="capsule" />);
    expect(screen.getByTitle('实现状态面板')).toBeTruthy();
    expect(screen.queryByText('+3')).toBeNull();
  });

  it('变体菜单：点开含「自动展开」单选与「收起为胶囊」；Escape 关闭', () => {
    const store = seedStore();
    const { container } = render(<ConversationStatusPanel store={store} sessionId="s1" variant="auto" />);
    const trigger = container.querySelector('[data-testid="status-panel-menu-trigger"]') as HTMLButtonElement;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByTestId('status-panel-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    expect(screen.getByTestId('status-menu-auto').getAttribute('aria-checked')).toBe('true'); // auto 为当前选中
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('status-panel-menu')).toBeNull();
  });

  it('菜单选「收起为胶囊」→ 变胶囊；capsule 态下该项禁用（aria-disabled）', () => {
    const store = seedStore();
    // 不传 variant：走面板自身的偏好态（菜单才是真实的变体开关）
    const { container } = render(<ConversationStatusPanel store={store} sessionId="s1" />);
    fireEvent.click(container.querySelector('[data-testid="status-panel-menu-trigger"]') as HTMLButtonElement);
    fireEvent.click(screen.getByTestId('status-menu-capsule'));
    // auto 双形态消失，只剩胶囊
    expect(container.querySelector('[data-testid="status-panel-auto-wide"]')).toBeNull();
    expect(container.querySelector('[data-testid="conversation-status-panel-capsule"]')).not.toBeNull();
    // capsule 态再开菜单：收起项禁用；「自动展开」可回到 auto
    fireEvent.click(container.querySelector('[data-testid="status-panel-menu-trigger"]') as HTMLButtonElement);
    expect(screen.getByTestId('status-menu-capsule').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByTestId('status-menu-auto'));
    expect(container.querySelector('[data-testid="status-panel-auto-wide"]')).not.toBeNull();
  });

  it('数据到达即重渲：先空后到（视图缓存 bump rev）', () => {
    const store = new AppStore();
    const { container, rerender } = render(<ConversationStatusPanel store={store} sessionId="s1" variant="capsule" />);
    expect(container.querySelector('[data-testid="conversation-status-panel-capsule"]')).toBeNull();
    store.setPlanState('s1', planWithSteps);
    rerender(<ConversationStatusPanel store={store} sessionId="s1" variant="capsule" />);
    expect(container.querySelector('[data-testid="conversation-status-panel-capsule"]')).not.toBeNull();
  });

  it('换会话各看各的数据（面板只读本 sessionId 的缓存）', () => {
    const store = new AppStore();
    store.setPlanState('s1', planWithSteps);
    const { rerender } = render(<ConversationStatusPanel store={store} sessionId="s2" variant="capsule" />);
    expect(document.querySelector('[data-testid="conversation-status-panel-capsule"]')).toBeNull();
    rerender(<ConversationStatusPanel store={store} sessionId="s1" variant="capsule" />);
    expect(document.querySelector('[data-testid="conversation-status-panel-capsule"]')).not.toBeNull();
  });

  it('重渲不丢组件内展开偏好（订阅 store notify，仅内存态——D-14 不落盘）', () => {
    const store = seedStore();
    seedTask(store);
    const { container } = render(<ConversationStatusPanel store={store} sessionId="s1" variant="auto" />);
    const wide = widePanel(container);
    const agentsHeader = wide.querySelector('[data-testid="status-section-agents"] button') as HTMLButtonElement;
    fireEvent.click(agentsHeader); // 用户展开 Agents
    store.setExecutionViews('s1', []); // 无关数据到达 → notify → 重渲
    expect(
      (wide.querySelector('[data-testid="status-section-agents"] button') as HTMLButtonElement).getAttribute(
        'aria-expanded',
      ),
    ).toBe('true');
  });
});
