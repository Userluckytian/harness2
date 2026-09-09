// FixC E1 — plan-state 目标锚定改 seq/水位（session.log seq），不再依赖跨文件时钟。
// 验收判定 E（P0-2d）：
//   - 目标锚定用 seq/水位非时间戳：journal task/transition 记录 sessionLogSeq 水位，
//     目标 = session.log 内 seq <= 水位的最后活动 user/message（同一时间线单调，不依赖时钟）；
//   - 两会话并发各自 plan-state 目标锚定不串（用 seq 而非 ts）；
//   - 缺省回退：旧账本（无水位字段）仍按 ts 兼容；planId/步骤/状态/证据 id 可重建不变。
// 全部本地临时目录 + SessionWriter/RuntimeJournal，无网络。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeJournal } from '../src/interaction/runtime-journal.js';
import { loadPlanState, reconstructPlanState } from '../src/interaction/plan-state.js';
import { SessionWriter } from '../src/session/writer.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-e1-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 写 session.log（header + user/assistant 消息）；ts 手工覆写，模拟跨文件时钟不一致/并发交错 */
function writeLog(
  dir: string,
  items: Array<{ type: 'user/message' | 'assistant/message'; text: string; ts: string }>,
  sessionId = 's1',
): void {
  const w = SessionWriter.create(dir, { sessionId }, { fsync: false });
  try {
    for (const it of items) w.append(it.type as 'user/message', { text: it.text, turnId: `turn-${it.ts}` });
  } finally {
    w.close();
  }
  // 手工覆写每行 ts（模拟与 journal 跨文件时钟不一致的产物；seq 仍按写入序单调）
  const lines = readFileSync(join(dir, 'session.v1.jsonl'), 'utf8').trimEnd().split('\n');
  for (let i = 0; i < lines.length; i++) {
    const obj = JSON.parse(lines[i]!) as Record<string, unknown>;
    const item = items[i - 1]; // 第 0 行是 header，其后与 items 对齐
    if (item !== undefined) obj['ts'] = item.ts;
    lines[i] = JSON.stringify(obj);
  }
  writeFileSync(join(dir, 'session.v1.jsonl'), lines.join('\n') + '\n', 'utf8');
}

/** 写 journal：accepted + 一条任务链；首个 transition 带 sessionLogSeq 水位（可选）；firstTs 覆写该行 ts */
function writeJournal(dir: string, opts: { sessionLogSeq?: number; firstTs?: string; sessionId?: string }): void {
  const w = RuntimeJournal.create(dir, { fsync: false });
  try {
    w.append({ kind: 'queue/accepted', clientMessageId: 'cm', sessionId: opts.sessionId ?? 's1', intent: 'queue' });
    const input: Parameters<RuntimeJournal['append']>[0] = {
      kind: 'task/transition',
      taskId: 't-root',
      clientMessageId: 'cm',
      from: 'registered',
      to: 'queued',
      ...(opts.sessionLogSeq !== undefined ? { sessionLogSeq: opts.sessionLogSeq } : {}),
    };
    w.append(input);
    w.append({ kind: 'task/transition', taskId: 't-root', clientMessageId: 'cm', from: 'queued', to: 'starting' });
    w.append({ kind: 'task/transition', taskId: 't-root', clientMessageId: 'cm', from: 'starting', to: 'running' });
    w.append({ kind: 'task/transition', taskId: 't-root', clientMessageId: 'cm', from: 'running', to: 'completed' });
  } finally {
    w.close();
  }
  if (opts.firstTs !== undefined) {
    // 覆写首个 task/transition（第 2 行）的 ts：模拟与 session.log 跨文件时钟不一致/旧账本
    const lines = readFileSync(join(dir, 'runtime.v1.jsonl'), 'utf8').trimEnd().split('\n');
    const obj = JSON.parse(lines[1]!) as Record<string, unknown>;
    obj['ts'] = opts.firstTs;
    lines[1] = JSON.stringify(obj);
    writeFileSync(join(dir, 'runtime.v1.jsonl'), lines.join('\n') + '\n', 'utf8');
  }
}

describe('E1 seq/水位锚定（非时间戳）', () => {
  it('[核心] 时钟反转场景：触发目标 user/message 的 ts 晚于首个 transition 的 ts，seq 锚定仍选对目标', () => {
    const dir = tmpDir();
    // 时钟反转：user/message 目标「目标A」落盘 ts=09:00:10，但首个 transition ts=09:00:09（早于目标）
    // ts<=anchor(09:00:09) 会漏掉目标；seq 锚定（水位=2）应命中 seq2 目标A
    writeLog(dir, [
      { type: 'user/message', text: '目标A', ts: '2026-09-09T09:00:10.000Z' },
      { type: 'assistant/message', text: '回复', ts: '2026-09-09T09:00:11.000Z' },
    ]);
    writeJournal(dir, { sessionLogSeq: 2, firstTs: '2026-09-09T09:00:09.000Z' });

    const plan = loadPlanState(dir);
    expect(plan).not.toBeNull();
    expect(plan?.goal).toBe('目标A');
    expect(plan?.goalEvidence?.seq).toBe(2);
    expect(plan?.goalEvidence?.anchor?.kind).toBe('session-log-seq');
    if (plan?.goalEvidence?.anchor?.kind === 'session-log-seq') {
      expect(plan.goalEvidence.anchor.seq).toBe(2);
    }
  });

  it('[核心] 两会话并发不串：各自 seq 锚定到自己的 user/message，即便 ts 交错', () => {
    const dirA = tmpDir();
    const dirB = tmpDir();
    // A 的 user 消息 ts 晚于 B 的首个 transition ts（交错）；seq 是各自会话自己的时间线，绝不串
    writeLog(dirA, [
      { type: 'user/message', text: 'A目标', ts: '2026-09-09T10:00:30.000Z' },
      { type: 'assistant/message', text: 'A回复', ts: '2026-09-09T10:00:31.000Z' },
    ]);
    writeJournal(dirA, { sessionLogSeq: 2, sessionId: 'sA' });
    writeLog(dirB, [
      { type: 'user/message', text: 'B目标', ts: '2026-09-09T10:00:10.000Z' },
      { type: 'assistant/message', text: 'B回复', ts: '2026-09-09T10:00:11.000Z' },
    ]);
    writeJournal(dirB, { sessionLogSeq: 2, sessionId: 'sB' });

    const planA = loadPlanState(dirA);
    const planB = loadPlanState(dirB);
    expect(planA?.goal).toBe('A目标');
    expect(planB?.goal).toBe('B目标');
    expect(planA?.goalEvidence?.seq).toBe(2);
    expect(planB?.goalEvidence?.seq).toBe(2);
    expect(planA?.goalEvidence?.anchor?.kind).toBe('session-log-seq');
    expect(planB?.goalEvidence?.anchor?.kind).toBe('session-log-seq');
    // 不串：A 的目标证据指回 A 自己的事件，B 指回 B 自己的事件
    expect(planA?.goalEvidence?.ts).toBe('2026-09-09T10:00:30.000Z');
    expect(planB?.goalEvidence?.ts).toBe('2026-09-09T10:00:10.000Z');
  });

  it('水位只选「seq <= 水位」的最后活动 user/message（不选水位后的消息）', () => {
    const dir = tmpDir();
    writeLog(dir, [
      { type: 'user/message', text: '第一目标', ts: '2026-09-09T09:00:10.000Z' },
      { type: 'user/message', text: '第二目标(水位后)', ts: '2026-09-09T09:00:12.000Z' },
    ]);
    // 水位=2（仅第一目标在计划开始前）；第二目标 seq=3 > 水位，不应作为目标
    writeJournal(dir, { sessionLogSeq: 2 });

    const plan = loadPlanState(dir);
    expect(plan?.goal).toBe('第一目标');
    expect(plan?.goalEvidence?.seq).toBe(2);
  });
});

describe('E1 缺省回退与可重建性', () => {
  it('旧账本（task/transition 无 sessionLogSeq 水位）→ 回退 ts 锚定，仍能取到目标（兼容）', () => {
    const dir = tmpDir();
    writeLog(dir, [
      { type: 'user/message', text: '旧账目标', ts: '2026-09-09T08:00:10.000Z' },
      { type: 'assistant/message', text: '旧账回复', ts: '2026-09-09T08:00:11.000Z' },
    ]);
    writeJournal(dir, { sessionLogSeq: undefined, firstTs: '2026-09-09T08:00:12.000Z' });

    const plan = loadPlanState(dir);
    expect(plan?.goal).toBe('旧账目标');
    expect(plan?.goalEvidence?.anchor?.kind).toBe('journal-ts');
  });

  it('水位回退且用户消息 ts 在 transition 之后 → 目标为空、不提供证据（不猜测）', () => {
    const dir = tmpDir();
    // 无水位 + 唯一 user 消息 ts 晚于 transition：ts 锚定也命中不了 → 空目标
    writeLog(dir, [{ type: 'user/message', text: '太晚', ts: '2026-09-09T09:00:20.000Z' }]);
    writeJournal(dir, { sessionLogSeq: undefined, firstTs: '2026-09-09T09:00:10.000Z' });

    const plan = loadPlanState(dir);
    expect(plan?.goal).toBe('');
    expect(plan?.goalEvidence).toBeUndefined();
  });

  it('可重建性保留：planId/步骤/状态/证据 id 仍可指回 journal task/transition seq', () => {
    const dir = tmpDir();
    writeLog(dir, [{ type: 'user/message', text: '目标', ts: '2026-09-09T09:00:10.000Z' }]);
    writeJournal(dir, { sessionLogSeq: 2 });

    const { readEntries } = RuntimeJournal;
    const plan = loadPlanState(dir);
    const { entries } = readEntries(dir);
    const direct = reconstructPlanState(entries);

    expect(plan?.planId).toBe('t-root');
    expect(plan?.readOnly).toBe(true);
    expect(plan?.steps[0]?.stepId).toBe('t-root');
    expect(plan?.steps[0]?.state).toBe('completed');
    expect(plan?.steps[0]?.evidence.source).toBe('runtime-journal');
    expect(plan?.steps[0]?.evidence.journalSeqs.length).toBeGreaterThan(0);
    // goalEvidence 保留证据 id（seq + ts），重建一致
    expect(plan?.goalEvidence?.source).toBe('user-message');
    expect(plan?.goalEvidence?.seq).toBe(2);
    // 纯投影 reconstructPlanState 与磁盘 loadPlanState 对步骤/状态口径一致
    expect(direct?.steps.map((s) => s.stepId)).toEqual(plan?.steps.map((s) => s.stepId));
    expect(direct?.steps.map((s) => s.state)).toEqual(plan?.steps.map((s) => s.state));
  });
});
