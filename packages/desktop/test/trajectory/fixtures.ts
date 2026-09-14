// 轨迹测试夹具：事件构造器 + 真实形状的会话片段。
//
// 事件形状与 core `SessionEvent` 一致（v/seq/ts/type/payload），时间戳全部可预测
// （基准 T0 + 偏移），因此时间/耗时断言是确定值而非近似。
import type { ActiveEvent } from '../../src/renderer/chat-model.js';

/** 基准时刻（UTC）：所有夹具时间戳 = T0 + offset */
export const T0 = Date.parse('2026-09-14T10:00:00.000Z');

export function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

export function ev(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  offsetMs: number,
  active = true,
): ActiveEvent {
  return { v: 1, seq, ts: at(offsetMs), type, payload, active };
}

/**
 * 两轮会话：t1 = 用户 + 模型（带 usage）+ 工具；t2 = 用户 + 模型。
 * 时间线（相对 T0）：
 *   100 用户 t1 · 200 step 开始 · 1200 助手 t1（step 耗时 1000）· 1300→1340 工具（40ms）
 *   2000 用户 t2 · 2100 step 开始 · 3100 助手 t2
 */
export function conversationFixture(): ActiveEvent[] {
  return [
    ev(1, 'session/header', { sessionId: 's1' }, 0),
    ev(2, 'user/message', { text: '你好', turnId: 't1' }, 100),
    ev(3, 'step/start', { stepId: 'step-t1-1', turnId: 't1' }, 200),
    ev(
      4,
      'assistant/message',
      { text: '嗨', model: 'm1', usage: { inputTokens: 10, outputTokens: 5 }, turnId: 't1' },
      1200,
    ),
    ev(5, 'step/end', { stepId: 'step-t1-1', turnId: 't1', durationMs: 1000 }, 1210),
    ev(6, 'tool/call', { callId: 'c1', tool: 'bash', args: { cmd: 'ls' }, turnId: 't1' }, 1300),
    ev(
      7,
      'tool/result',
      { callId: 'c1', tool: 'bash', ok: true, output: 'file.txt', durationMs: 40, turnId: 't1' },
      1340,
    ),
    ev(8, 'user/message', { text: '再来', turnId: 't2' }, 2000),
    ev(9, 'step/start', { stepId: 'step-t2-1', turnId: 't2' }, 2100),
    ev(10, 'assistant/message', { text: '好', model: 'm1', turnId: 't2' }, 3100),
    ev(11, 'step/end', { stepId: 'step-t2-1', turnId: 't2', durationMs: 1000 }, 3110),
  ];
}

/** 首 token 观测：t1 的 step 在 300ms 处首次产出（TTFT=100ms，解码=900ms） */
export function firstOutputObservation(): Record<string, number> {
  return { 'step-t1-1': T0 + 300 };
}

/** 进行中的会话：工具调用已发出、结果未到；会话 running（无 turn-end） */
export function runningFixture(): ActiveEvent[] {
  return [
    ev(1, 'session/header', { sessionId: 's2' }, 0),
    ev(2, 'user/message', { text: '跑一下', turnId: 't1' }, 100),
    ev(3, 'step/start', { stepId: 'step-t1-1', turnId: 't1' }, 200),
    ev(4, 'tool/call', { callId: 'c9', tool: 'bash', args: { cmd: 'sleep 30' }, turnId: 't1' }, 300),
  ];
}

/** 嵌套子工具：c2 的 args.parentCallId 指向 c1（真实层级，不发明） */
export function nestedToolFixture(): ActiveEvent[] {
  return [
    ev(1, 'session/header', { sessionId: 's3' }, 0),
    ev(2, 'user/message', { text: '嵌套', turnId: 't1' }, 100),
    ev(3, 'tool/call', { callId: 'c1', tool: 'subagent_start', args: { name: 'x' }, turnId: 't1' }, 200),
    ev(4, 'tool/call', { callId: 'c2', tool: 'bash', args: { cmd: 'ls', parentCallId: 'c1' }, turnId: 't1' }, 250),
    ev(5, 'tool/result', { callId: 'c2', tool: 'bash', ok: false, error: 'boom', durationMs: 7, turnId: 't1' }, 260),
    ev(
      6,
      'tool/result',
      {
        callId: 'c1',
        tool: 'subagent_start',
        ok: true,
        output: '{"childSessionId":"child-42"}',
        durationMs: 100,
        turnId: 't1',
      },
      300,
    ),
  ];
}

/** 独立压缩请求落在两轮之间的空隙（seq 7）；随后是第二轮 */
export function betweenTurnsFixture(): ActiveEvent[] {
  return [
    ev(1, 'session/header', { sessionId: 's4' }, 0),
    ev(2, 'user/message', { text: 'A', turnId: 't1' }, 100),
    ev(3, 'assistant/message', { text: 'B', turnId: 't1' }, 200),
    ev(4, 'compaction/applied', { summary: '前情摘要', coveredUpToSeq: 3 }, 300),
    ev(5, 'user/message', { text: 'C', turnId: 't2' }, 400),
    ev(6, 'assistant/message', { text: 'D', turnId: 't2' }, 500),
  ];
}

/** 落在轮次内部的压缩请求（无 turnId，无法证明归属 → 区段追加到末尾） */
export function compactionInsideTurnFixture(): ActiveEvent[] {
  return [
    ev(1, 'user/message', { text: 'A', turnId: 't1' }, 100),
    ev(2, 'compaction/applied', { summary: '轮内摘要', coveredUpToSeq: 1 }, 150),
    ev(3, 'assistant/message', { text: 'B', turnId: 't1' }, 200),
  ];
}

/** 带真实附件的用户消息（payload 里显式带 attachments/references） */
export function attachmentsFixture(): ActiveEvent[] {
  return [
    ev(
      1,
      'user/message',
      {
        text: '看图',
        turnId: 't1',
        attachments: [{ kind: 'image', id: 'img-1', name: 'a.png', mimeType: 'image/png' }, 'notes.txt'],
        references: [
          { id: 'ref-1', kind: 'file', path: 'src/a.ts' },
          { id: 'ref-2', kind: 'url', url: 'https://example.com' },
        ],
      },
      100,
    ),
  ];
}

/** 生成 N 条步骤行（虚拟化用）：一轮 + N 个工具步骤 */
export function manyRowsFixture(count: number): ActiveEvent[] {
  const events: ActiveEvent[] = [ev(1, 'user/message', { text: '起点', turnId: 't1' }, 0)];
  for (let i = 0; i < count; i += 1) {
    const base = 10 + i * 10;
    events.push(ev(2 + i * 2, 'tool/call', { callId: `c${i}`, tool: 'bash', args: { i }, turnId: 't1' }, base));
    events.push(
      ev(
        3 + i * 2,
        'tool/result',
        { callId: `c${i}`, tool: 'bash', ok: true, output: `out${i}`, durationMs: 3, turnId: 't1' },
        base + 5,
      ),
    );
  }
  return events;
}
