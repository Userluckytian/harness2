// 检查器字段测试（D-44）：token 用量 / 耗时 / 输入 / 输出 / 计时 / 附件摘要，缺数据如实「未记录」「无」。
import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatDurationMs,
  formatUsage,
  previewValue,
  truncate,
} from '../../src/renderer/trajectory/format.js';
import {
  deriveBetweenTurnsInspector,
  deriveInspectorForRow,
  deriveStepInspector,
  roleLabel,
  stateLabel,
  summarizeAttachments,
} from '../../src/renderer/trajectory/inspector.js';
import { projectTrajectory } from '../../src/renderer/trajectory/projection.js';
import type { TrajectoryRow, TrajectoryStep } from '../../src/renderer/trajectory/types.js';
import { attachmentsFixture, betweenTurnsFixture, conversationFixture, T0 } from './fixtures.js';

function stepsOf(events: ReturnType<typeof conversationFixture>) {
  return projectTrajectory({ events, sessionId: 's' }).turns.flatMap((turn) => turn.steps);
}

describe('deriveStepInspector（D-44 字段齐全）', () => {
  it('助手行：token 用量 + 耗时 + 输入（日志不含请求正文）/ 输出正文', () => {
    const steps = stepsOf(conversationFixture());
    const assistant = steps.find((step) => step.role === 'assistant');
    if (assistant === undefined) throw new Error('夹具应有助手步骤');
    const view = deriveStepInspector(assistant);
    const field = (label: string) => view.entries.find((entry) => entry.label === label);
    expect(field('token 用量')?.value).toBe('输入 10 / 输出 5');
    expect(field('token 用量')?.missing).toBe(false);
    expect(field('耗时')?.value).toBe('1.00 s');
    expect(field('输入')).toMatchObject({ value: '未记录', missing: true });
    expect(field('输出')?.value).toBe('嗨');
    expect(field('TTFT（首 token）')).toMatchObject({ value: '未记录', missing: true });
    expect(field('解码段')).toMatchObject({ value: '未记录', missing: true });
    expect(view.outputText).toBe('嗨');
  });

  it('有首 token 观测时 TTFT/解码字段有值（200ms/900ms）', () => {
    const steps = stepsOf(conversationFixture());
    const assistant = steps.find((step) => step.role === 'assistant');
    if (assistant === undefined) throw new Error('夹具应有助手步骤');
    const observed: TrajectoryStep = {
      ...assistant,
      timing: { ...assistant.timing, ttftMs: 200, decodeMs: 900 },
    };
    const view = deriveStepInspector(observed);
    const field = (label: string) => view.entries.find((entry) => entry.label === label);
    expect(field('TTFT（首 token）')?.value).toBe('200 ms');
    expect(field('解码段')?.value).toBe('900 ms');
  });

  it('用户行：输入 = 正文；输出如实「未记录」', () => {
    const steps = stepsOf(conversationFixture());
    const user = steps.find((step) => step.role === 'user');
    if (user === undefined) throw new Error('夹具应有用户步骤');
    const view = deriveStepInspector(user);
    expect(view.inputText).toBe('你好');
    expect(view.outputText).toBe('未记录');
    expect(view.entries.find((entry) => entry.label === 'token 用量')?.missing).toBe(true);
  });

  it('工具行：输入 = args JSON；输出 = 真实 output；失败时给 error', () => {
    const steps = stepsOf(conversationFixture());
    const tool = steps.find((step) => step.role === 'tool');
    if (tool === undefined) throw new Error('夹具应有工具步骤');
    const view = deriveStepInspector(tool);
    expect(view.inputText).toContain('"cmd": "ls"');
    expect(view.outputText).toBe('file.txt');
    expect(view.entries.find((entry) => entry.label === '状态')?.value).toBe('已完成');

    const failed: TrajectoryStep = { ...tool, output: undefined, error: 'boom', state: 'failed' };
    const failedView = deriveStepInspector(failed);
    expect(failedView.outputText).toBe('boom');
    expect(failedView.entries.find((entry) => entry.label === '错误')?.value).toBe('boom');
    expect(failedView.entries.find((entry) => entry.label === '状态')?.value).toBe('失败');
  });

  it('进行中的工具行：耗时如实「未记录」，状态「进行中」', () => {
    const events = [
      {
        v: 1 as const,
        seq: 1,
        ts: new Date(T0).toISOString(),
        type: 'tool/call',
        payload: { callId: 'c', tool: 'bash', args: {}, turnId: 't1' },
        active: true,
      },
    ];
    const steps = projectTrajectory({ events, sessionId: 's' }).turns.flatMap((turn) => turn.steps);
    const view = deriveStepInspector(steps[0]!);
    expect(view.state).toBe('running');
    expect(view.entries.find((entry) => entry.label === '状态')?.value).toBe('进行中');
    expect(view.entries.find((entry) => entry.label === '耗时')).toMatchObject({ value: '未记录', missing: true });
  });

  it('嵌套子工具：角色文案带层级；子会话 id 透出', () => {
    expect(roleLabel('subtool', 2)).toBe('嵌套子工具（层级 2）');
    expect(roleLabel('tool', 0)).toBe('工具');
    expect(stateLabel('cancelled')).toBe('已取消');
  });
});

describe('附件摘要（D-44：真实数据 / 缺数据「无」）', () => {
  it('payload 带附件 → 图片/文件计数；无附件 → 「无」且 empty=true', () => {
    const steps = stepsOf(attachmentsFixture());
    const view = deriveStepInspector(steps[0]!);
    expect(view.attachments.summary).toBe('图片 1 / 文件 2');
    expect(view.attachments.empty).toBe(false);
    expect(view.attachments.images).toHaveLength(1);
    expect(view.attachments.files.map((file) => file.name)).toEqual(['notes.txt', 'src/a.ts']);

    const noAttachments = stepsOf(conversationFixture());
    const empty = deriveStepInspector(noAttachments.find((step) => step.role === 'user')!);
    expect(empty.attachments).toMatchObject({ summary: '无', empty: true });
    expect(empty.entries.find((entry) => entry.label === '附件')?.value).toBe('无');
  });

  it('summarizeAttachments 对空数组直给「无」', () => {
    expect(summarizeAttachments([])).toEqual({ images: [], files: [], summary: '无', empty: true });
  });
});

describe('deriveInspectorForRow / Between turns', () => {
  it('分割线行不可选 → null；步骤行 → 检查器', () => {
    const model = projectTrajectory({ events: conversationFixture(), sessionId: 's' });
    const boundary = model.rows.find((row) => row.kind === 'turn-boundary');
    const step = model.rows.find((row) => row.kind === 'step');
    if (boundary === undefined || step === undefined) throw new Error('夹具应有分割线与步骤行');
    expect(deriveInspectorForRow(boundary)).toBeNull();
    expect(deriveInspectorForRow(step)?.key).toBe(step.key);
  });

  it('独立压缩请求的检查器：输出 = 摘要、覆盖区间可见、附件如实「无」', () => {
    const model = projectTrajectory({ events: betweenTurnsFixture(), sessionId: 's' });
    const row: TrajectoryRow | undefined = model.rows.find((item) => item.kind === 'between-turns');
    if (row === undefined) throw new Error('夹具应有 Between turns 行');
    const view = deriveInspectorForRow(row);
    expect(view).toMatchObject({ role: 'between-turns', state: 'ok' });
    expect(view?.entries.find((entry) => entry.label === '输出（摘要）')?.value).toBe('前情摘要');
    expect(view?.entries.find((entry) => entry.label === '覆盖至 seq')?.value).toBe('3');
    expect(view?.attachments.summary).toBe('无');

    const direct = deriveBetweenTurnsInspector(model.betweenTurns[0]!);
    expect(direct.title).toBe('Compaction request');
  });
});

describe('格式化（未知一律留空或「未记录」）', () => {
  it('耗时：null/NaN → 空串；<1s 用 ms；否则 s', () => {
    expect(formatDurationMs(null)).toBe('');
    expect(formatDurationMs(Number.NaN)).toBe('');
    expect(formatDurationMs(0)).toBe('0 ms');
    expect(formatDurationMs(456)).toBe('456 ms');
    expect(formatDurationMs(1234)).toBe('1.23 s');
  });

  it('时钟：null → 空串；UTC HH:MM:SS.mmm（跨时区可断言）', () => {
    expect(formatClock(null)).toBe('');
    expect(formatClock(T0)).toBe('10:00:00.000');
  });

  it('token 用量：缺失字段写「未记录」而不是 0', () => {
    expect(formatUsage(undefined)).toBe('未记录');
    expect(formatUsage({})).toBe('未记录');
    expect(formatUsage({ inputTokens: 3 })).toBe('输入 3 / 输出 未记录');
  });

  it('预览/截断：不可序列化不抛错，超长加省略号', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(previewValue(cyclic)).toBe('<不可序列化>');
    expect(previewValue(undefined)).toBe('');
    expect(previewValue({ a: 1 })).toContain('"a": 1');
    expect(truncate('abcdef', 3)).toBe('abc…');
    expect(truncate('ab', 3)).toBe('ab');
  });
});
