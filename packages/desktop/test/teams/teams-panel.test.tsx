// @vitest-environment jsdom
// A11 桌面 Teams 只读面板测试（Z6 批次6-B）：
//   - 组件渲染（团队/成员列表 + 任务板状态 + 运行计数）；
//   - 空态（无团队不摆假条目，红线⑩）；
//   - 承载缝：经 Z3-03 状态面板槽（assembly.desktopStatusPanel）并列渲染；两端都空 → 槽不渲染。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AppStore } from '@harness2/ui-shared/renderer/store.js';
import type { Controller } from '@harness2/ui-shared/renderer/app-controller.js';
import type { PlanStateShape } from '@harness2/ui-shared/shared/protocol.js';
import { ConversationSeat } from '../../src/renderer/conversation/assembly.js';
import { TeamsPanel, teamsViewStore, type TeamsViewTeam } from '../../src/renderer/teams/index.js';
import { store as singletonStore } from '../../src/renderer/app-shared.js';
import type { Harness2Api } from '../../src/shared/protocol.js';

afterEach(() => {
  cleanup();
  teamsViewStore.clear();
});

function team(over: Partial<TeamsViewTeam> = {}): TeamsViewTeam {
  return {
    teamId: 'team-1',
    name: 'research',
    description: '调研小队',
    status: 'running',
    members: [
      { name: 'scout', status: 'done', rounds: 2, writeMode: 'readonly', childSessionId: 'child-scout' },
      { name: 'writer', status: 'running', rounds: 1, writeMode: 'write' },
    ],
    tasks: [
      { taskId: 't1', title: '收集资料', status: 'done', owner: 'scout', dependsOn: [] },
      { taskId: 't2', title: '写报告', status: 'claimed', owner: 'writer', dependsOn: ['t1'] },
    ],
    messages: [{ messageId: 'm1', from: 'scout', to: 'board', kind: 'board', text: '资料已收集' }],
    ...over,
  };
}

function sessionSummary(id: string) {
  return { id, dir: 'd', cwd: 'D:/proj', mtimeMs: 1, firstUserText: 'x', messageCount: 1, lastSeq: 0 };
}

/** ConversationHeader 挂载即拉的 IPC 面（渲染端读 window.harness2）；其余不触即桩 */
function stubBridge(): void {
  (window as unknown as { harness2: Partial<Harness2Api> }).harness2 = {
    gitBranch: vi.fn(async () => null),
    settingsGetConfig: vi.fn(async () => {
      throw new Error('not needed');
    }),
    getContextUsage: vi.fn(async () => ({ usage: null, label: '—' })),
  };
}

function bootStore(id: string): AppStore {
  const testStore = new AppStore();
  testStore.setSessions([sessionSummary(id)]);
  testStore.select(id);
  return testStore;
}

describe('TeamsPanel 只读渲染', () => {
  it('渲染团队名/成员/任务板状态/运行计数', () => {
    const { container, getByText } = render(<TeamsPanel teams={[team()]} />);
    expect(container.querySelector('[data-testid="teams-panel"]')).not.toBeNull();
    expect(getByText('research')).toBeTruthy();
    // 运行计数行（成员 2 / 运行 1 / 任务 2 / 领取 1 / 消息 1）
    const counts = container.querySelector('[data-testid="teams-counts"]')!.textContent!;
    expect(counts).toContain('成员 2');
    expect(counts).toContain('运行 1');
    expect(counts).toContain('任务 2');
    expect(counts).toContain('领取 1');
    expect(counts).toContain('消息 1');
    // 成员两行 + 状态词
    expect(container.querySelectorAll('[data-testid="teams-members"] > div').length).toBe(2);
    expect(container.textContent).toContain('scout');
    expect(container.textContent).toContain('writer');
    expect(container.textContent).toContain('running');
    // 任务板：标题 + 归属 + 依赖已 done 的完成标记
    const tasks = container.querySelector('[data-testid="teams-tasks"]')!;
    expect(tasks.textContent).toContain('收集资料');
    expect(tasks.textContent).toContain('写报告');
    expect(tasks.textContent).toContain('@writer');
  });

  it('空态：无团队 → 空态文本，不摆假条目（红线⑩）', () => {
    const { container } = render(<TeamsPanel teams={[]} />);
    expect(container.querySelector('[data-testid="teams-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="teams-empty"]')!.textContent).toContain('暂无团队');
  });

  it('订阅单例：缺省从 teamsViewStore 取数，clear 后回空态', () => {
    teamsViewStore.setTeams([team({ teamId: 'team-2', name: '板队' })]);
    const { container } = render(<TeamsPanel />);
    expect(container.textContent).toContain('板队');
    teamsViewStore.clear();
    const { container: empty } = render(<TeamsPanel />);
    expect(empty.querySelector('[data-testid="teams-empty"]')).not.toBeNull();
  });

  it('超额列表收进「其余 N」', () => {
    const many = team({
      members: Array.from({ length: 10 }, (_, i) => ({
        name: `m${i}`,
        status: 'idle',
        rounds: 0,
        writeMode: 'write' as const,
      })),
    });
    const { container } = render(<TeamsPanel teams={[many]} maxMembers={3} />);
    const rows = container.querySelectorAll('[data-testid="teams-member"]');
    expect(rows.length).toBe(3);
    expect(container.textContent).toContain('m0');
    expect(container.textContent).toContain('m2');
    expect(container.textContent).not.toContain('m3');
    expect(container.textContent).toContain('其余 7 名成员');
  });
});

describe('承载缝：Z3-03 状态面板槽并列 Teams 面板', () => {
  it('仅有 Teams 数据（无计划）→ 槽渲染且含 Teams 面板', () => {
    stubBridge();
    teamsViewStore.setTeams([team({ teamId: 'sp-team', name: '槽位队' })]);
    const { container } = render(<ConversationSeat store={bootStore('sp-t1')} controller={{} as Controller} />);
    expect(container.querySelector('[data-testid="status-panel-slot"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="teams-panel"]')).not.toBeNull();
    expect(container.textContent).toContain('槽位队');
  });

  it('两端都无数据 → 槽不渲染（空态不占位）', () => {
    stubBridge();
    const { container } = render(<ConversationSeat store={bootStore('sp-t2')} controller={{} as Controller} />);
    expect(container.querySelector('[data-testid="status-panel-slot"]')).toBeNull();
    expect(container.querySelector('[data-testid="teams-panel"]')).toBeNull();
  });

  it('有 Teams + 状态面板各自渲染（共存）', () => {
    stubBridge();
    const plan: PlanStateShape = {
      planId: 'p',
      goal: '共存目标',
      steps: [],
      readOnly: true,
      sourceDir: 'd',
    };
    singletonStore.setPlanState('sp-t3', plan);
    teamsViewStore.setTeams([team({ teamId: 'sp-team3', name: '共存队' })]);
    const { container } = render(<ConversationSeat store={bootStore('sp-t3')} controller={{} as Controller} />);
    expect(container.querySelector('[title="共存目标"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="teams-panel"]')).not.toBeNull();
  });
});
