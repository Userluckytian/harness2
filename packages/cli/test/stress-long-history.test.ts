// T5 长历史压力测试（风险「长历史性能」）：测试时**生成**大会话到临时目录（不入库大 fixture），
// 断言 projectSession + computeViewport + transcriptReducer 在预算内完成。
// 预算对齐 architecture 性能预算口径：单操作 < 1.5s 为达标，> 3s 视为痛点（本用例合计 < 1.5s）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSession, SessionWriter } from '@harness2/core';
import {
  computeViewport,
  estimateItemHeight,
  projectSession,
  sessionEventToTranscript,
  transcriptHeightCache,
  transcriptReducer,
  emptyTranscript,
  type TranscriptState,
} from '../src/tui/transcript.js';

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
});

/** 生成 ~1000 条消息 / ~10000 事件的会话（fsync 关闭，只测读侧投影性能）。 */
function generateLargeSession(): string {
  const base = mkdtempSync(join(tmpdir(), 'h2-stress-'));
  temps.push(base);
  const dir = join(base, 'large');
  const writer = SessionWriter.create(dir, { sessionId: 'large', cwd: base }, { fsync: false });
  const ITER = 500;
  for (let i = 0; i < ITER; i += 1) {
    const turnId = `t-${i}`;
    const stepId = `s-${i}`;
    writer.append('step/start', { stepId, turnId });
    writer.append('user/message', { text: `user-${i}-a`, turnId });
    writer.append('tool/call', { callId: `c-${i}-1`, tool: 'read', args: { file_path: `f-${i}.txt` }, turnId });
    writer.append('tool/result', { callId: `c-${i}-1`, tool: 'read', ok: true, output: `out-${i}`, turnId });
    writer.append('assistant/message', { text: `assistant-${i}-a`, model: 'mock', turnId });
    writer.append('step/end', { stepId, turnId, durationMs: 1 });
    writer.append('step/start', { stepId: `${stepId}-2`, turnId });
    writer.append('user/message', { text: `user-${i}-b`, turnId });
    writer.append('assistant/message', { text: `assistant-${i}-b`, model: 'mock', turnId });
    writer.append('step/end', { stepId: `${stepId}-2`, turnId, durationMs: 1 });
    writer.append('step/start', { stepId: `${stepId}-3`, turnId });
    writer.append('tool/call', { callId: `c-${i}-2`, tool: 'read', args: { file_path: `g-${i}.txt` }, turnId });
    writer.append('tool/result', { callId: `c-${i}-2`, tool: 'read', ok: false, error: `err-${i}`, turnId });
    writer.append('step/end', { stepId: `${stepId}-3`, turnId, durationMs: 1 });
    writer.append('step/start', { stepId: `${stepId}-4`, turnId });
    writer.append('user/message', { text: `user-${i}-c`, turnId });
    writer.append('assistant/message', { text: `assistant-${i}-c`, model: 'mock', turnId });
    writer.append('tool/call', { callId: `c-${i}-3`, tool: 'read', args: { file_path: `h-${i}.txt` }, turnId });
    writer.append('tool/result', { callId: `c-${i}-3`, tool: 'read', ok: true, output: `out2-${i}`, turnId });
    writer.append('step/end', { stepId: `${stepId}-4`, turnId, durationMs: 1 });
  }
  writer.close();
  return dir;
}

describe('T5 长历史压力：1000 消息 / 万级事件投影预算', () => {
  it('projectSession + computeViewport + reducer 在预算内完成', () => {
    const dir = generateLargeSession();

    const t0 = performance.now();
    const state: TranscriptState = projectSession(dir);
    const t1 = performance.now();

    const heights = state.items.map((i) => estimateItemHeight(i, 80));
    const totalHeight = heights.reduce((a, b) => a + b, 0);
    const view = computeViewport(state.items, {
      heights,
      totalHeight,
      height: 24,
      follow: true,
      scrollTop: 0,
    });
    const t2 = performance.now();

    // 独立 reducer 计时：对同一日志再跑一遍纯 reducer（不含 loadSession 重复解析的磁盘 I/O 之外的成本）
    const session = loadSession(dir);
    let reduced = emptyTranscript();
    for (const { event } of session.events) {
      const te = sessionEventToTranscript(event);
      if (te !== null) reduced = transcriptReducer(reduced, te);
    }
    const t3 = performance.now();

    const projectMs = t1 - t0;
    const viewportMs = t2 - t1;
    const reduceMs = t3 - t2;
    const totalMs = t3 - t0;
    console.log(
      `[T5 stress] events=${session.events.length} items=${state.items.length} ` +
        `project=${projectMs.toFixed(1)}ms viewport=${viewportMs.toFixed(1)}ms reduce=${reduceMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms`,
    );

    // 生成规模符合计划口径
    expect(session.events.length).toBeGreaterThanOrEqual(10_000);
    // 结构精确断言（否则「塌缩」也会让宽松的 >= 断言通过）：
    // 每轮 3 user + 3 assistant + 3 tool = 9 items，共 500 轮 → 4500 items / 3000 条消息。
    // 修复前同 turnId 覆盖只会得到 ~2500 items / 1000 条消息，本断言必失败。
    expect(state.items.length).toBe(4_500);
    expect(projectedMessageCount(state)).toBe(3_000);
    // 每轮 3 段 assistant 都在（不得被同 turnId 覆盖塌成每轮 1 段）
    const assistantTexts = new Set(state.items.flatMap((i) => (i.kind === 'assistant' ? [i.text] : [])));
    expect(assistantTexts.size).toBe(1_500);
    // 投影命中第一条与最后一条
    expect(view.start).toBeGreaterThanOrEqual(0);
    expect(view.end).toBeLessThanOrEqual(state.items.length);
    // 高度缓存可用
    const cache = transcriptHeightCache();
    for (const item of state.items.slice(0, 50)) cache.set(item.id, estimateItemHeight(item, 80));
    expect(cache.total(state.items.slice(0, 50).map((i) => i.id))).toBeGreaterThan(0);

    // 预算：单操作 < 1.5s，合计 < 1.5s（> 3s 为痛点，本用例应远低于）
    expect(projectMs).toBeLessThan(1500);
    expect(viewportMs).toBeLessThan(1500);
    expect(reduceMs).toBeLessThan(1500);
    expect(totalMs).toBeLessThan(1500);
  });
});

/** 从投影转录粗略统计消息条目数（user+assistant，含分步 assistant） */
function projectedMessageCount(state: TranscriptState): number {
  return state.items.filter((i) => i.kind === 'user' || i.kind === 'assistant' || i.kind === 'partial').length;
}
