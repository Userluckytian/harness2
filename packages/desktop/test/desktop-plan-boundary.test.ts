// D3 计划边界测试（F2）：计划有证据、只读投影、**切权限必须显式**（展示计划不自动提权）。
import { describe, expect, it } from 'vitest';
import { buildPlanDisplay, resolveModeSwitch, taskStateLabel } from '../src/renderer/features/plan/plan-model.js';
import type { PlanStateShape } from '../src/shared/protocol.js';

const plan: PlanStateShape = {
  planId: 'task-root',
  goal: '把 hello.txt 改成 v2 并跑测试',
  goalEvidence: {
    source: 'user-message',
    seq: 3,
    ts: '2026-09-11T00:00:00Z',
    anchor: { kind: 'session-log-seq', seq: 3 },
  },
  steps: [
    {
      stepId: 'task-root',
      state: 'completed',
      evidence: { source: 'runtime-journal', taskId: 'task-root', journalSeqs: [1, 2, 3] },
    },
    {
      stepId: 'task-child',
      state: 'waiting-approval',
      evidence: { source: 'runtime-journal', taskId: 'task-child', journalSeqs: [4, 5] },
    },
  ],
  readOnly: true,
  sourceDir: '/sessions/x',
};

describe('模式切换必须显式（不自动提权）', () => {
  it('显式动作才切换', () => {
    expect(resolveModeSwitch('plan', 'default', true)).toEqual({ mode: 'default', changed: true });
  });

  it('隐式请求（如「打开了计划面板/读到危险步骤」）一律拒绝并给出原因', () => {
    const r = resolveModeSwitch('plan', 'default', false);
    expect(r.changed).toBe(false);
    expect(r.mode).toBe('plan');
    expect(r.reason).toContain('显式');
  });

  it('目标 = 当前 → 无变化且无原因', () => {
    expect(resolveModeSwitch('default', 'default', true)).toEqual({ mode: 'default', changed: false });
  });
});

describe('计划视图有证据（非状态卡）', () => {
  it('无账本 → 明确空态原因（不臆造空计划）', () => {
    const d = buildPlanDisplay(null);
    expect('plan' in d).toBe(true);
    if ('plan' in d) expect(d.reason).toContain('暂无计划账本');
    expect(buildPlanDisplay(undefined)).toMatchObject({ plan: null });
  });

  it('有账本 → planId/目标证据/每步 journal seq 齐备，只读标记在位', () => {
    const d = buildPlanDisplay(plan);
    if ('plan' in d) throw new Error('should be present');
    expect(d.planId).toBe('task-root');
    expect(d.goal).toContain('hello.txt');
    expect(d.goalEvidence?.seq).toBe(3);
    expect(d.readOnly).toBe(true);
    expect(d.steps.map((s) => s.stepId)).toEqual(['task-root', 'task-child']);
    expect(d.steps[0]!.journalSeqs).toEqual([1, 2, 3]);
    expect(d.steps[1]!.journalSeqs).toEqual([4, 5]);
    expect(d.steps[1]!.evidenceSource).toBe('runtime-journal');
    expect(d.completed).toBe(1);
    expect(d.total).toBe(2);
  });

  it('步骤状态可读（waiting-approval 不被折叠成 running）', () => {
    const d = buildPlanDisplay(plan);
    if ('plan' in d) throw new Error('should be present');
    expect(d.steps[1]!.stateLabel).toBe('等待审批');
    expect(taskStateLabel('unknown')).toBe('状态未知');
  });
});
