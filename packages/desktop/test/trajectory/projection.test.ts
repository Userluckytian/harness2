// 投影层测试（D-41/D-42/D-44/D-47）：事件流 → 轮次/步骤/Between turns。
//
// 关键断言：
//   * 轮次分组与步骤顺序（按真实 seq）；
//   * 助手行 TTFT/解码段**只在有真实首 token 观测**时给出，否则留空（不猜）；
//   * 进行中的行不虚构耗时（endedAtMs/durationMs = null）；
//   * 独立压缩请求进 Between turns（落在轮次空隙 / 轮内则追加末尾，不硬塞归属）；
//   * 嵌套子工具层级来自真实 parentCallId；
//   * 附件摘要只来自真实 payload 字段。
import { describe, expect, it } from 'vitest';
import {
  extractAttachments,
  filterModelBySelection,
  projectTrajectory,
} from '../../src/renderer/trajectory/projection.js';
import {
  betweenTurnsFixture,
  compactionInsideTurnFixture,
  attachmentsFixture,
  conversationFixture,
  firstOutputObservation,
  nestedToolFixture,
  runningFixture,
  T0,
} from './fixtures.js';

function project(events: ReturnType<typeof conversationFixture>, extras: Record<string, unknown> = {}) {
  return projectTrajectory({ events, sessionId: 's', ...extras });
}

describe('projectTrajectory（D-41 轮次与步骤）', () => {
  it('按 turnId 分组，步骤按真实 seq 排序，轮次标签 1 起', () => {
    const model = project(conversationFixture());
    expect(model.turns.map((turn) => turn.id)).toEqual(['t1', 't2']);
    expect(model.turns.map((turn) => turn.label)).toEqual(['Turn 1', 'Turn 2']);
    expect(model.turns[0]?.steps.map((step) => [step.role, step.seq])).toEqual([
      ['user', 2],
      ['assistant', 4],
      ['tool', 6],
    ]);
    // 步骤紧凑标记 = 轮内序号（D-41 行内紧凑标记）
    expect(model.turns[0]?.steps.map((step) => step.stepMarker)).toEqual([1, 2, 3]);
  });

  it('扁平行：粗分割线 + 步骤行（D-41）', () => {
    const model = project(conversationFixture());
    expect(model.rows.map((row) => row.kind)).toEqual([
      'turn-boundary',
      'step',
      'step',
      'step',
      'turn-boundary',
      'step',
      'step',
    ]);
    expect(model.rows[0]).toMatchObject({ kind: 'turn-boundary', turnIndex: 1 });
  });

  it('助手行带 model/usage/正文（缺 usage → undefined，不补 0）', () => {
    const model = project(conversationFixture());
    const first = model.turns[0]?.steps[1];
    expect(first).toMatchObject({ role: 'assistant', model: 'm1', text: '嗨' });
    expect(first?.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    const second = model.turns[1]?.steps[1];
    expect(second?.usage).toBeUndefined();
    expect(model.turns[0]?.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(model.turns[1]?.usage).toEqual({});
  });

  it('忽略非步骤事件（header/memory/rewind）与影子事件', () => {
    const events = conversationFixture();
    events.push({
      v: 1,
      seq: 12,
      ts: new Date(T0).toISOString(),
      type: 'rewind/marker',
      payload: { rewindToSeq: 2 },
      active: true,
    });
    events.push({
      v: 1,
      seq: 13,
      ts: new Date(T0).toISOString(),
      type: 'memory/snapshot',
      payload: { content: 'x' },
      active: true,
    });
    events.push({
      v: 1,
      seq: 14,
      ts: new Date(T0).toISOString(),
      type: 'assistant/message',
      payload: { text: '影子', turnId: 't2' },
      active: false,
    });
    const model = project(events);
    expect(model.rows.filter((row) => row.kind === 'step')).toHaveLength(5);
    expect(JSON.stringify(model)).not.toContain('影子');
  });

  it('无 turnId 的事件归入当前轮次；无任何轮次时归入「未归属轮次」', () => {
    const withTurn = project([
      {
        v: 1,
        seq: 1,
        ts: new Date(T0).toISOString(),
        type: 'user/message',
        payload: { text: 'A', turnId: 't1' },
        active: true,
      },
      {
        v: 1,
        seq: 2,
        ts: new Date(T0 + 10).toISOString(),
        type: 'tool/result',
        payload: { callId: 'x', ok: true },
        active: true,
      },
    ]);
    expect(withTurn.turns).toHaveLength(1);
    expect(withTurn.turns[0]?.steps[1]?.role).toBe('tool');
    expect(withTurn.turns[0]?.steps[1]?.label).toBe('');

    const orphan = project([
      {
        v: 1,
        seq: 1,
        ts: new Date(T0).toISOString(),
        type: 'tool/result',
        payload: { callId: 'x', tool: 'bash', ok: true },
        active: true,
      },
    ]);
    expect(orphan.turns[0]?.id).toBe('(未归属轮次)');
  });

  it('失败的 attempt 单独成行且如实标 failed（不冒充 assistant 成功行）', () => {
    const model = project([
      {
        v: 1,
        seq: 1,
        ts: new Date(T0).toISOString(),
        type: 'step/start',
        payload: { stepId: 'step-a', turnId: 't1' },
        active: true,
      },
      {
        v: 1,
        seq: 2,
        ts: new Date(T0 + 50).toISOString(),
        type: 'assistant/attempt',
        payload: { error: 'boom', text: '半截', model: 'm', turnId: 't1' },
        active: true,
      },
    ]);
    const step = model.turns[0]?.steps[0];
    expect(step).toMatchObject({ role: 'assistant', state: 'failed', error: 'boom', text: '半截' });
    // 没有 assistant/message → 没有真实结束时刻的产出段，TTFT/解码必须是 null
    expect(step?.timing.ttftMs).toBeNull();
    expect(step?.timing.decodeMs).toBeNull();
  });

  it('取消的 attempt 标 cancelled', () => {
    const model = project([
      {
        v: 1,
        seq: 1,
        ts: new Date(T0).toISOString(),
        type: 'assistant/attempt',
        payload: { error: 'cancelled: 用户取消', turnId: 't1' },
        active: true,
      },
    ]);
    expect(model.turns[0]?.steps[0]?.state).toBe('cancelled');
  });
});

describe('TTFT 与解码段（D-42；数据不足留空，不猜）', () => {
  it('有首 token 观测：ttft = 首 token - step 开始；decode = 助手结束 - 首 token', () => {
    const model = project(conversationFixture(), { firstOutputAtMs: firstOutputObservation() });
    const assistant = model.turns[0]?.steps[1];
    // step 开始 200ms，首 token 300ms → TTFT 100ms；助手结束 1200ms → 解码 900ms
    expect(assistant?.timing.ttftMs).toBe(100);
    expect(assistant?.timing.decodeMs).toBe(900);
    // 与 step/end 的真实耗时自洽：100 + 900 = 1000
    expect(assistant?.timing.durationMs).toBe(1000);
  });

  it('无观测：ttft/decode 均为 null，耗时仍取真实 step/end.durationMs', () => {
    const model = project(conversationFixture());
    const assistant = model.turns[0]?.steps[1];
    expect(assistant?.timing.ttftMs).toBeNull();
    expect(assistant?.timing.decodeMs).toBeNull();
    expect(assistant?.timing.durationMs).toBe(1000);
  });

  it('观测键不匹配（别的 step）→ 留空，不挪用', () => {
    const model = project(conversationFixture(), { firstOutputAtMs: { 'step-other': T0 + 300 } });
    expect(model.turns[0]?.steps[1]?.timing.ttftMs).toBeNull();
  });

  it('首 token 观测早于 step 开始（异常数据）→ 留空而不是显示负数', () => {
    const model = project(conversationFixture(), { firstOutputAtMs: { 'step-t1-1': T0 + 100 } });
    expect(model.turns[0]?.steps[1]?.timing.ttftMs).toBeNull();
    expect(model.turns[0]?.steps[1]?.timing.decodeMs).toBe(1100);
  });
});

describe('进行中不虚构耗时（D-47）', () => {
  it('会话 running 且无 turn-end：末轮 running，结束时间/耗时一律 null', () => {
    const model = projectTrajectory({ events: runningFixture(), running: true, sessionId: 's2' });
    const turn = model.turns[0];
    expect(turn?.running).toBe(true);
    expect(turn?.timing.endedAtMs).toBeNull();
    expect(turn?.timing.durationMs).toBeNull();
    expect(model.hasRunningSteps).toBe(true);
    // 工具步骤：结果未到 → running、无结束时间、无耗时
    const tool = turn?.steps.find((step) => step.role === 'tool');
    expect(tool).toMatchObject({ state: 'running' });
    expect(tool?.timing.endedAtMs).toBeNull();
    expect(tool?.timing.durationMs).toBeNull();
  });

  it('不 running（已完成）时给出真实首末事件时间与耗时', () => {
    const model = project(conversationFixture());
    const turn = model.turns[0];
    expect(turn?.running).toBe(false);
    expect(turn?.timing.startedAtMs).toBe(T0 + 100);
    expect(turn?.timing.endedAtMs).toBe(T0 + 1340);
    expect(turn?.timing.durationMs).toBe(1240);
  });

  it('有 turn-end 终态时即使会话仍 running 也不把最后一轮标成未结束', () => {
    const model = projectTrajectory({
      events: conversationFixture(),
      running: true,
      turnEnds: { t2: { stopReason: 'end_turn' } },
      sessionId: 's',
    });
    expect(model.turns[1]?.running).toBe(false);
    expect(model.turns[1]?.timing.durationMs).toBe(1110);
    expect(model.turns[1]?.turnEnd).toEqual({ stopReason: 'end_turn' });
  });

  it('工具结果到达后耗时来自 payload 的真实 durationMs', () => {
    const model = project(conversationFixture());
    const tool = model.turns[0]?.steps[2];
    expect(tool?.timing.durationMs).toBe(40);
    expect(tool?.timing.startedAtMs).toBe(T0 + 1300);
    expect(tool?.timing.endedAtMs).toBe(T0 + 1340);
  });
});

describe('Between turns（D-47：独立压缩请求）', () => {
  it('落在轮次空隙的压缩请求插入该位置，section 标题为 Between turns', () => {
    const model = project(betweenTurnsFixture());
    expect(model.betweenTurns).toHaveLength(1);
    expect(model.betweenTurns[0]).toMatchObject({ summary: '前情摘要', coveredUpToSeq: 3 });
    const kinds = model.rows.map((row) => row.kind);
    // 第 1 轮（用户+助手）→ Between turns → 第 2 轮
    expect(kinds).toEqual([
      'turn-boundary',
      'step',
      'step',
      'between-turns-boundary',
      'between-turns',
      'turn-boundary',
      'step',
      'step',
    ]);
  });

  it('落在轮次内部的压缩请求追加到末尾（payload 无 turnId，不硬塞归属）', () => {
    const model = project(compactionInsideTurnFixture());
    const kinds = model.rows.map((row) => row.kind);
    expect(kinds.at(-2)).toBe('between-turns-boundary');
    expect(kinds.at(-1)).toBe('between-turns');
    expect(kinds.slice(0, 3)).toEqual(['turn-boundary', 'step', 'step']);
  });

  it('无压缩请求时不渲染 Between turns 区段', () => {
    const model = project(conversationFixture());
    expect(model.betweenTurns).toEqual([]);
    expect(model.rows.some((row) => row.kind === 'between-turns-boundary')).toBe(false);
  });
});

describe('嵌套子工具（D-41：层级来自真实 parentCallId）', () => {
  it('parentCallId 指向的调用 → role=subtool、depth=1；无引用 → depth=0', () => {
    const model = project(nestedToolFixture());
    const [, outer, inner] = model.turns[0]?.steps ?? [];
    expect(outer).toMatchObject({ role: 'tool', depth: 0, label: 'subagent_start' });
    expect(inner).toMatchObject({ role: 'subtool', depth: 1, label: 'bash', state: 'failed', error: 'boom' });
  });

  it('subagent 工具结果里的 childSessionId 被透出（供跳转子会话）', () => {
    const model = project(nestedToolFixture());
    expect(model.turns[0]?.steps[1]?.childSessionId).toBe('child-42');
  });

  it('父引用指向不存在的调用时不发明层级（depth 保持 0）', () => {
    const model = project([
      {
        v: 1,
        seq: 1,
        ts: new Date(T0).toISOString(),
        type: 'tool/call',
        payload: { callId: 'c9', tool: 'bash', args: { parentCallId: 'missing' }, turnId: 't1' },
        active: true,
      },
    ]);
    expect(model.turns[0]?.steps[0]).toMatchObject({ role: 'tool', depth: 0 });
  });
});

describe('附件摘要（D-44：只认真实数据，缺数据为空）', () => {
  it('attachments 的图片/文件与 references 的文件被计入；url 引用不计', () => {
    const model = project(attachmentsFixture());
    expect(model.turns[0]?.steps[0]?.attachments).toEqual([
      { kind: 'image', name: 'a.png', mimeType: 'image/png', id: 'img-1' },
      { kind: 'file', name: 'notes.txt' },
      { kind: 'file', name: 'src/a.ts' },
    ]);
  });

  it('没有附件字段 → 空数组（UI 显示「无」）', () => {
    const model = project(conversationFixture());
    expect(model.turns[0]?.steps[0]?.attachments).toEqual([]);
  });

  it('extractAttachments：mimeType=image/* 无声明 kind 也判图片；非法项忽略', () => {
    expect(extractAttachments({ attachments: [{ mimeType: 'image/jpeg' }, 42, null] })).toEqual([
      { kind: 'image', mimeType: 'image/jpeg' },
    ]);
  });
});

describe('区间过滤（D-43 拖选）', () => {
  it('只保留与区间相交的步骤；无时间戳的步骤不参与（如实排除）', () => {
    const model = project(conversationFixture());
    const filtered = filterModelBySelection(model, { startMs: T0 + 1250, endMs: T0 + 1350 });
    expect(filtered.turns).toHaveLength(1);
    expect(filtered.turns[0]?.steps.map((step) => step.role)).toEqual(['tool']);
    // 行也随之重建（分割线 + 单步）
    expect(filtered.rows.map((row) => row.kind)).toEqual(['turn-boundary', 'step']);
  });

  it('区间覆盖全部时间 → 模型保持不变（同一引用，避免无谓重渲染）', () => {
    const model = project(conversationFixture());
    const filtered = filterModelBySelection(model, null);
    expect(filtered).toBe(model);
  });

  it('过滤结果仍携带 Between turns 命中项', () => {
    const model = project(betweenTurnsFixture());
    const filtered = filterModelBySelection(model, { startMs: T0 + 250, endMs: T0 + 350 });
    expect(filtered.betweenTurns).toHaveLength(1);
  });
});

describe('稳定行键', () => {
  it('同一事件流重复投影得到完全一致的行键（虚拟化/ARIA 的前提）', () => {
    const a = project(conversationFixture());
    const b = project(conversationFixture());
    expect(a.rows.map((row) => row.key)).toEqual(b.rows.map((row) => row.key));
    expect(new Set(a.rows.map((row) => row.key)).size).toBe(a.rows.length);
  });
});
