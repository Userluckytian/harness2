import { describe, expect, it } from 'vitest';
import { buildSnapshot, projectEvents, stopReasonToControlPhase } from '../src/real/v4-projection.js';
import type { AnySessionEvent } from '@harness2/core';
import { conversationRowSchema, conversationSnapshotSchema } from '@zcode/shared/zcode-protocol-v4';

function ev(seq: number, type: string, payload: unknown): AnySessionEvent {
  return { v: 1, seq, ts: new Date().toISOString(), type, payload } as AnySessionEvent;
}

describe('v4-projection', () => {
  it('projects user + assistant message to rows', () => {
    const events = [
      ev(1, 'user/message', { text: 'hi', turnId: 't1' }),
      ev(2, 'assistant/message', {
        text: 'hello',
        reasoning: 'think',
        usage: { inputTokens: 10, outputTokens: 5 },
        turnId: 't1',
      }),
    ];
    const r = projectEvents(events);
    expect(r.rows.some((x) => x.kind === 'userInput')).toBe(true);
    expect(r.rows.some((x) => x.kind === 'assistantText')).toBe(true);
    expect(r.rows.some((x) => x.kind === 'reasoning')).toBe(true);
    expect(r.state.usage.inputTokens).toBe(10);
    expect(r.state.usage.outputTokens).toBe(5);
  });

  it('projects tool call/result', () => {
    const events = [
      ev(1, 'user/message', { text: 'run', turnId: 't1' }),
      ev(2, 'tool/call', { callId: 'c1', tool: 'write', turnId: 't1' }),
      ev(3, 'tool/result', { callId: 'c1', ok: true, output: 'done', turnId: 't1' }),
    ];
    const r = projectEvents(events);
    const tc = r.rows.find((x) => x.kind === 'toolCall');
    expect(tc?.status).toBe('success');
    expect(tc?.output?.text).toBe('done');
  });

  it('assistant attempt failed → failed row', () => {
    const events = [ev(1, 'assistant/attempt', { error: 'boom', text: 'partial', turnId: 't1' })];
    const r = projectEvents(events);
    expect(r.rows[0].state).toBe('failed');
  });

  it('stopReason mapping', () => {
    expect(stopReasonToControlPhase('end_turn')).toBe('completedSuccess');
    expect(stopReasonToControlPhase('cancelled')).toBe('completedInterrupted');
  });

  it('mutation: remove projection mapping breaks (assistant text missing)', () => {
    const events = [ev(1, 'assistant/message', { text: 'x', turnId: 't1' })];
    const r = projectEvents(events);
    expect(r.rows.some((x) => x.kind === 'assistantText' && x.text === 'x')).toBe(true);
  });

  it('resume contract: rowIds unique monotonic; append beyond lastSeq keeps prior ids', () => {
    const base = [
      ev(1, 'user/message', { text: 'hi', turnId: 't1' }),
      ev(2, 'assistant/message', { text: 'hello', reasoning: 'think', turnId: 't1' }),
    ];
    const r1 = projectEvents(base);
    const ids1 = r1.rows.map((x) => x.rowId);
    expect(new Set(ids1).size).toBe(ids1.length);
    for (let i = 1; i < ids1.length; i++) expect(ids1[i]).toBeGreaterThan(ids1[i - 1]);
    expect(r1.lastSeq).toBe(2);

    const extended = [...base, ev(3, 'assistant/message', { text: 'more', turnId: 't1' })];
    const r2 = projectEvents(extended);
    expect(r2.rows.slice(0, r1.rows.length).map((x) => x.rowId)).toEqual(ids1);
    const newId = r2.rows[r1.rows.length].rowId;
    expect(newId).toBeGreaterThan(ids1[ids1.length - 1]);
    expect(r2.lastSeq).toBe(3);
  });

  it('P2-2: every projected row satisfies the v4 row schema', () => {
    const events = [
      ev(1, 'user/message', { text: 'hi', turnId: 't1' }),
      ev(2, 'assistant/message', { text: 'hello', reasoning: 'think', turnId: 't1' }),
      ev(3, 'tool/call', { callId: 'c1', tool: 'write', args: { path: 'a.txt' }, turnId: 't1' }),
      ev(4, 'tool/result', { callId: 'c1', ok: false, error: 'nope', turnId: 't1' }),
    ];
    const r = projectEvents(events);
    for (const row of r.rows) {
      const parsed = conversationRowSchema.safeParse(row);
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    }
    // 反向断言：tool/result 的整行替换不得丢掉入参
    const tool = r.rows.find((x) => x.kind === 'toolCall');
    expect(tool?.inputText).toBe('{"path":"a.txt"}');
    expect(tool?.status).toBe('error');
  });

  it('P2-2: snapshot payload satisfies the v4 snapshot schema', () => {
    const events = [
      ev(1, 'user/message', { text: 'hi', turnId: 't1' }),
      ev(2, 'assistant/message', { text: 'hello', turnId: 't1' }),
    ];
    const r = projectEvents(events);
    const snapshot = buildSnapshot({
      sessionId: 's1',
      seq: r.lastSeq,
      rows: r.rows,
      phase: r.state.controlPhase,
      pendingInteractions: r.state.pendingInteractions,
    });
    const parsed = conversationSnapshotSchema.safeParse(snapshot);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  it('T3: extension attachment event reattaches attachments to the userInput row', () => {
    const events = [
      ev(1, 'user/message', { text: 'hi', turnId: 't1' }),
      ev(2, 'assistant/message', { text: 'ok', turnId: 't1' }),
    ];
    const attachments = [{ ref: 'D:/a.png', fileName: 'a.png', mime: 'image/png', bytes: 1 }];
    const ext = {
      v: 1 as const,
      seq: 3,
      ts: new Date().toISOString(),
      type: 'adapter/user-attachments',
      payload: { turnId: 't1', attachments },
    };
    const r = projectEvents(events, [ext]);
    const user = r.rows.find((x) => x.kind === 'userInput');
    expect(user?.attachments).toEqual(attachments);
    expect(r.lastSeq).toBe(3);
  });
});
