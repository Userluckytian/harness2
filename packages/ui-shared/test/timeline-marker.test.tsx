// Z3-07 对话行类型补缺：Z-92 timelineMarker 行（compact / checkpoint-restored / retry-notice）
// 投影与渲染测试 —— 三种来源事件（compaction/applied、rewind/marker、assistant/attempt）
// 的 live 帧 + 重放两条数据路，以及标记行组件文案（摘要截断 / rewindToSeq / attempt error）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AppStore } from '../src/renderer/store.js';
import { applyEvent, refoldShadowing, type ActiveEvent } from '../src/renderer/chat-model.js';
import {
  TimelineMarkerRow,
  checkpointRestoredText,
  compactSummaryLine,
  retryNoticeText,
} from '../src/renderer/conversation/TimelineMarkerRow.js';
import type { WsFrame } from '../src/shared/protocol.js';

afterEach(cleanup);

let seqCounter = 0;
function event(
  type: string,
  payload: Record<string, unknown>,
): { v: 1; seq: number; ts: string; type: string; payload: Record<string, unknown> } {
  seqCounter += 1;
  return { v: 1, seq: seqCounter, ts: '2026-10-11T00:00:00.000Z', type, payload };
}

function eventFrame(sessionId: string, payloadType: string, payload: Record<string, unknown>): WsFrame {
  return { type: 'event', sessionId, event: event(payloadType, payload) };
}

function replayPayload(id: string, events: ActiveEvent[]): Parameters<AppStore['applyReplay']>[0] {
  return {
    id,
    dir: `dir-${id}`,
    header: { sessionId: id },
    events,
    warnings: [],
    lastSeq: events.at(-1)?.seq ?? 0,
  };
}

describe('store 投影（live event 帧 → marker 行）', () => {
  it('compaction/applied → compact 标记（摘要原文随行；coveredUpToSeq 不进对话流）', () => {
    const store = new AppStore();
    store.applyFrame(eventFrame('a', 'compaction/applied', { summary: '前情摘要', coveredUpToSeq: 3 }));
    const items = store.chatItems('a');
    const marker = items.find((i) => i.kind === 'marker');
    expect(marker?.variant).toBe('compact');
    expect(marker?.summary).toBe('前情摘要');
    expect(JSON.stringify(items)).not.toContain('coveredUpToSeq');
  });

  it('rewind/marker → checkpoint-restored 标记（rewindToSeq 携带）', () => {
    const store = new AppStore();
    store.applyFrame(eventFrame('a', 'rewind/marker', { rewindToSeq: 4, reason: 'undo' }));
    const marker = store.chatItems('a').find((i) => i.kind === 'marker');
    expect(marker?.variant).toBe('checkpoint-restored');
    expect(marker?.rewindToSeq).toBe(4);
  });

  it('assistant/attempt → retry-notice 标记（error + 半截文本仍由该事件承载）', () => {
    const store = new AppStore();
    store.applyFrame(eventFrame('a', 'user/message', { text: 'hi', turnId: 't1' }));
    store.applyFrame(
      eventFrame('a', 'assistant/attempt', { error: 'cancelled: 用户取消', text: '写到一半', turnId: 't1' }),
    );
    const marker = store.chatItems('a').find((i) => i.kind === 'marker');
    expect(marker?.variant).toBe('retry-notice');
    expect(marker?.error).toBe('cancelled: 用户取消');
    expect(marker?.text).toBe('写到一半');
  });

  it('live undo 重折叠：rewind/marker 帧到达后，遮蔽区间内的行不再出现（不显示已撤回历史）', () => {
    const store = new AppStore();
    seqCounter = 0;
    store.applyFrame(eventFrame('a', 'user/message', { text: '第一条', turnId: 't1' })); // seq1
    store.applyFrame(eventFrame('a', 'assistant/message', { text: '回复一', turnId: 't1' })); // seq2
    store.applyFrame(eventFrame('a', 'user/message', { text: '第二条', turnId: 't2' })); // seq3
    store.applyFrame(eventFrame('a', 'assistant/message', { text: '回复二', turnId: 't2' })); // seq4
    store.applyFrame(eventFrame('a', 'rewind/marker', { rewindToSeq: 2, reason: 'undo' })); // seq5：遮蔽 seq3-4
    const texts = store.chatItems('a').map((i) => i.text);
    expect(texts).toContain('第一条');
    expect(texts).not.toContain('第二条');
    expect(texts).not.toContain('回复二');
    const markers = store.chatItems('a').filter((i) => i.kind === 'marker');
    expect(markers.map((m) => m.variant)).toEqual(['checkpoint-restored']);
  });

  it('live redo 链中立化：redo 标记复活被重做 undo 层遮蔽的事件（与 core reader 同语义）', () => {
    const store = new AppStore();
    seqCounter = 0;
    store.applyFrame(eventFrame('a', 'user/message', { text: 'q1', turnId: 't1' })); // seq1
    store.applyFrame(eventFrame('a', 'user/message', { text: 'q2', turnId: 't2' })); // seq2
    store.applyFrame(eventFrame('a', 'rewind/marker', { rewindToSeq: 1, reason: 'undo' })); // seq3
    expect(store.chatItems('a').some((i) => i.text === 'q2')).toBe(false);
    // redo 约定：redo.rewindToSeq = 被重做 undo 标记的 seq - 1（undo 在 seq3 → redo.rewindToSeq=2）
    store.applyFrame(eventFrame('a', 'rewind/marker', { rewindToSeq: 2, reason: 'redo' })); // seq4
    expect(store.chatItems('a').some((i) => i.text === 'q2')).toBe(true);
  });
});

describe('store 投影（重放路径 → marker 行 + 影子过滤）', () => {
  it('applyReplay：三种事件（含服务端 active 标志）投影出同样的行；影子事件不显示', () => {
    const store = new AppStore();
    seqCounter = 0;
    const events: ActiveEvent[] = [
      { ...event('user/message', { text: 'q', turnId: 't1' }), active: true }, // seq1
      { ...event('assistant/attempt', { error: 'boom', turnId: 't1' }), active: true }, // seq2
      { ...event('assistant/message', { text: '影子', turnId: 't1' }), active: false }, // seq3：被遮蔽
      { ...event('compaction/applied', { summary: '摘要', coveredUpToSeq: 2 }), active: true }, // seq4
      { ...event('rewind/marker', { rewindToSeq: 3, reason: 'undo' }), active: true }, // seq5
    ];
    store.applyReplay(replayPayload('a', events));
    expect(store.peekStream('a')?.loaded).toBe(true);
    const items = store.chatItems('a');
    const markers = items.filter((i) => i.kind === 'marker');
    expect(markers.map((m) => m.variant)).toEqual(['retry-notice', 'compact', 'checkpoint-restored']);
    expect(markers[2]!.rewindToSeq).toBe(3);
    expect(items.some((i) => i.text === '影子')).toBe(false); // 重放 active=false 如实过滤
  });
});

describe('applyEvent / refoldShadowing（纯模型）', () => {
  it('applyEvent：普通事件追加保持 active；rewind/marker 触发重折叠', () => {
    seqCounter = 0;
    const base: ActiveEvent[] = [{ ...event('user/message', { text: 'q1' }), active: true }]; // seq1
    const added = applyEvent(base, 1, event('user/message', { text: 'q2' })); // seq2
    expect(added?.events.every((e) => e.active)).toBe(true);
    const marker = applyEvent(added!.events, 2, event('rewind/marker', { rewindToSeq: 1, reason: 'undo' })); // seq3
    const bySeq = new Map(marker!.events.map((e) => [e.seq, e.active]));
    expect(bySeq.get(1)).toBe(true); // rewindToSeq 以内的保持活动
    expect(bySeq.get(2)).toBe(false); // 遮蔽区间内的被折叠
    expect(bySeq.get(3)).toBe(true); // 标记自身恒活动
  });

  it('refoldShadowing：单调并集——多个标记的遮蔽区间取并集；标记自身恒活动', () => {
    seqCounter = 0;
    const events: ActiveEvent[] = [
      { ...event('user/message', { text: 'a' }), active: true }, // seq1
      { ...event('user/message', { text: 'b' }), active: true }, // seq2
      { ...event('user/message', { text: 'c' }), active: true }, // seq3
      { ...event('rewind/marker', { rewindToSeq: 2, reason: 'undo' }), active: true }, // seq4 → 遮蔽 seq3
      { ...event('rewind/marker', { rewindToSeq: 1, reason: 'undo' }), active: true }, // seq5 → 遮蔽 seq2-3
    ];
    const refolded = refoldShadowing(events);
    const bySeq = new Map(refolded.map((e) => [e.seq, e.active]));
    expect(bySeq.get(1)).toBe(true); // seq <= rewindToSeq：保持活动
    expect(bySeq.get(2)).toBe(false); // 两个标记遮蔽区间的并集
    expect(bySeq.get(3)).toBe(false);
    expect(bySeq.get(4)).toBe(true); // 标记恒活动
    expect(bySeq.get(5)).toBe(true);
  });
});

describe('标记行文案（TimelineMarkerRow + 纯助手）', () => {
  it('compactSummaryLine：压平空白 + 超长截断（…）', () => {
    expect(compactSummaryLine('第一行\n第二行\t制表')).toBe('第一行 第二行 制表');
    expect(compactSummaryLine('x'.repeat(100), 80)).toBe(`${'x'.repeat(80)}…`);
    expect(compactSummaryLine('短')).toBe('短');
  });

  it('checkpointRestoredText / retryNoticeText 文案', () => {
    expect(checkpointRestoredText(7)).toBe('已回退到序号 7');
    expect(retryNoticeText('boom')).toBe('尝试失败：boom');
  });

  it('compact 徽章：摘要截断展示、全文在 title；图标 Archive', () => {
    render(<TimelineMarkerRow variant="compact" summary={'很'.repeat(120)} />);
    const row = screen.getByTestId('timeline-marker');
    expect(row.getAttribute('data-variant')).toBe('compact');
    const summary = screen.getByTestId('marker-summary')!;
    expect(summary.textContent).toBe(`很`.repeat(80) + '…');
    expect(summary.getAttribute('title')).toBe('很'.repeat(120));
    expect(row.querySelector('svg.lucide-archive')).not.toBeNull();
    expect(row.textContent).toContain('上下文已压缩');
  });

  it('checkpoint-restored / retry-notice 徽章：文案与图标（无耗时/模型等假数据）', () => {
    const { container } = render(<TimelineMarkerRow variant="checkpoint-restored" rewindToSeq={9} />);
    expect(screen.getByTestId('marker-rewind').textContent).toBe('已回退到序号 9');
    expect(container.querySelector('svg.lucide-history')).not.toBeNull();

    render(<TimelineMarkerRow variant="retry-notice" error="网络中断" partialText="半截产出" />);
    expect(screen.getByTestId('marker-retry').textContent).toBe('尝试失败：网络中断');
    expect(screen.getByTestId('marker-partial').textContent).toContain('未完成 / 已中断的产出（4 字）');
    expect(screen.getByTestId('marker-retry').className).toContain('text-destructive');
  });

  it('retry-notice 无半截文本时不渲染展开入口（不摆假入口）', () => {
    render(<TimelineMarkerRow variant="retry-notice" error="boom" />);
    expect(screen.queryByTestId('marker-partial')).toBeNull();
  });
});
