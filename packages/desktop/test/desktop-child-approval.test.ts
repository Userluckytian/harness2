// D3 审批中心测试（F4）：主子归属清楚、过期 fail-closed、全部待批可见、拒绝项明确未执行。
import { describe, expect, it } from 'vitest';
import {
  decorateApprovals,
  groupApprovals,
  isApprovalExpired,
  type ApprovalCard,
} from '../src/renderer/features/plan/plan-model.js';
import type { TaskContractShape } from '../src/shared/protocol.js';

const NOW = Date.parse('2026-09-11T00:00:00Z');
const past = '2026-09-10T23:59:00Z';
const future = '2026-09-11T00:10:00Z';

const tasks: TaskContractShape[] = [
  { taskId: 'task-root', background: true, state: 'waiting-approval' },
  { taskId: 'task-child', parentTaskId: 'task-root', background: true, state: 'waiting-approval' },
];

describe('isApprovalExpired（fail-closed）', () => {
  it('已过 → 过期', () => {
    expect(isApprovalExpired(past, NOW)).toBe(true);
  });
  it('未到 → 未过期', () => {
    expect(isApprovalExpired(future, NOW)).toBe(false);
  });
  it('非法 ISO（无法解析）→ 视为过期（fail-closed，不误放行）', () => {
    expect(isApprovalExpired('not-a-date', NOW)).toBe(true);
  });
  it('缺省 expiresAt（旧 serve 不发）→ 未过期（不误杀可响应卡片）', () => {
    expect(isApprovalExpired(undefined, NOW)).toBe(false);
  });
});

describe('审批卡片归属与分组', () => {
  const cards: ApprovalCard[] = [
    { requestId: 'r-session', tool: 'bash', args: { command: 'ls' }, scope: 'once', expiresAt: future },
    {
      requestId: 'r-child',
      tool: 'write',
      args: { file_path: 'a.txt' },
      taskId: 'task-child',
      parentTaskId: 'task-root',
      scope: 'session',
      expiresAt: future,
    },
    {
      requestId: 'r-parent',
      tool: 'bash',
      args: { command: 'rm -rf x' },
      taskId: 'task-root',
      scope: 'once',
      expiresAt: past,
    },
  ];

  it('子任务卡片标记 isChild 并保留父 id（主子归属清楚）', () => {
    const groups = groupApprovals(cards, tasks);
    const child = groups.find((g) => g.taskId === 'task-child')!;
    expect(child.isChild).toBe(true);
    expect(child.parentTaskId).toBe('task-root');
  });

  it('会话级卡片归入独立组（taskId=null），并排在任务组之后', () => {
    const groups = groupApprovals(cards, tasks);
    expect(groups.at(-1)!.taskId).toBeNull();
    expect(groups.at(-1)!.cards.map((c) => c.requestId)).toEqual(['r-session']);
  });

  it('全部待批可见：三张卡片一个不丢（分组只是重组，不隐藏）', () => {
    const groups = groupApprovals(cards, tasks);
    const flat = groups.flatMap((g) => g.cards.map((c) => c.requestId));
    expect(flat.sort()).toEqual(['r-child', 'r-parent', 'r-session']);
  });

  it('decorateApprovals：过期标记 + 挂上任务当前状态（可读）；过期卡片仍保留（不静默消失）', () => {
    const decorated = decorateApprovals(cards, tasks, NOW);
    const parent = decorated.find((c) => c.requestId === 'r-parent')!;
    expect(parent.expired).toBe(true);
    expect(parent.taskState).toBe('waiting-approval');
    expect(parent.taskStateLabel).toBe('等待审批');
    const child = decorated.find((c) => c.requestId === 'r-child')!;
    expect(child.expired).toBe(false);
    expect(child.scope).toBe('session');
    expect(decorated).toHaveLength(3);
  });
});
