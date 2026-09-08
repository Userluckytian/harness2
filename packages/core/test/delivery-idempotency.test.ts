// S3b submit 幂等交付（delivery.ts）测试。
// 真实 journal 临时目录（S3a RuntimeJournal 写盘），崩溃窗口用「写一半丢」模拟。
// 覆盖：幂等去重（同 id 同内容→既有 receipt / 同 id 不同内容→rejected / 新→accepted）、
// 先 durable accepted 后 ack、queue edit/remove（revision+1）、上限 20 超限保留 draft、
// recoverQueue 默认 paused、resolveDelivery 崩溃对账（unknown≠rejected）。
import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { QUEUE_MAX_DEFAULT } from '../src/interaction/types.js';
import { RUNTIME_JOURNAL_FILE, RuntimeJournal } from '../src/interaction/runtime-journal.js';
import {
  createDeliverySession,
  editQueueItem,
  recoverQueue,
  removeQueueItem,
  resolveDelivery,
  submitDelivery,
} from '../src/interaction/delivery.js';
import type { SubmitRequest } from '../src/interaction/types.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), `h2-del-${randomUUID()}-`));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function req(over: Partial<SubmitRequest> & { clientMessageId: string; sessionId: string; rawText: string }): SubmitRequest {
  return { intent: 'queue', ...over };
}

/** 模拟「写一半丢」：向 journal 追加无换行的半行（writeSync 半途中断） */
function tornAppend(dir: string, half: string): void {
  appendFileSync(join(dir, RUNTIME_JOURNAL_FILE), half, 'utf8');
}

describe('submitDelivery 幂等去重', () => {
  it('新提交：journal 先写 durable accepted，返回 accepted + queueSeq', () => {
    const dir = tmpDir();
    const journal = RuntimeJournal.create(dir, { fsync: false });
    const s = createDeliverySession(journal, 's1');
    const ack = submitDelivery(s, req({ clientMessageId: 'cm1', sessionId: 's1', rawText: 'hello' }));

    expect(ack.state).toBe('accepted');
    expect(ack.queueSeq).toBe(0);
    // durable 已落盘（可被独立只读扫描到）
    const entries = RuntimeJournal.readEntries(dir).entries;
    expect(entries.filter((e) => e.kind === 'queue/accepted' && e.clientMessageId === 'cm1')).toHaveLength(1);
    journal.close();
  });

  it('同 id 同内容 → 返回既有 receipt，不重复登记（不产生第二条 accepted）', () => {
    const dir = tmpDir();
    const journal = RuntimeJournal.create(dir, { fsync: false });
    const s = createDeliverySession(journal, 's1');
    const a1 = submitDelivery(s, req({ clientMessageId: 'cm1', sessionId: 's1', rawText: 'hello' }));
    const a2 = submitDelivery(s, req({ clientMessageId: 'cm1', sessionId: 's1', rawText: 'hello' }));

    expect(a2.state).toBe('accepted');
    expect(a2.queueSeq).toBe(a1.queueSeq);
    const accepted = RuntimeJournal.readEntries(dir).entries.filter((e) => e.kind === 'queue/accepted' && e.clientMessageId === 'cm1');
    expect(accepted).toHaveLength(1);
    journal.close();
  });

  it('同 id 不同内容 → rejected（不覆盖既有提交）', () => {
    const dir = tmpDir();
    const journal = RuntimeJournal.create(dir, { fsync: false });
    const s = createDeliverySession(journal, 's1');
    submitDelivery(s, req({ clientMessageId: 'cm1', sessionId: 's1', rawText: 'hello' }));
    const a2 = submitDelivery(s, req({ clientMessageId: 'cm1', sessionId: 's1', rawText: 'WORLD' }));

    expect(a2.state).toBe('rejected');
    const accepted = RuntimeJournal.readEntries(dir).entries.filter((e) => e.kind === 'queue/accepted' && e.clientMessageId === 'cm1');
    expect(accepted).toHaveLength(1);
    journal.close();
  });

  it('先 durable 后 ack：accepted 落盘后即使「ack 前崩溃」，跨进程只读对账仍判 started', () => {
    const dir = tmpDir();
    const journal = RuntimeJournal.create(dir, { fsync: false });
    const s = createDeliverySession(journal, 's1');
    submitDelivery(s, req({ clientMessageId: 'cm-boom', sessionId: 's1', rawText: 'boom' }));
    // 不 close：模拟第 ack 发出前进程崩溃；跨进程独立只读 judge 仍见 durable accept
    const j = journal.judgeSubmission('cm-boom');
    expect(j.status).toBe('started');
    expect(j.acceptedSeq).toBeGreaterThan(0);
    journal.close();
  });
});

describe('queue edit / remove（revision+1）', () => {
  it('edit 未启动项：revision+1、文本更新、journal 保 started 语义', () => {
    const dir = tmpDir();
    const journal = RuntimeJournal.create(dir, { fsync: false });
    const s = createDeliverySession(journal, 's1');
    submitDelivery(s, req({ clientMessageId: 'cm1', sessionId: 's1', rawText: 'v1' }));
    expect(s.queue[0]?.revision).toBe(1);

    const r = editQueueItem(s, 'cm1', 1, 'v2');
    expect(r.ok).toBe(true);
    expect(s.queue[0]?.rawText).toBe('v2');
    expect(s.queue[0]?.revision).toBe(2);
    // removed 语义：edit 只是改文本，不改变「已启动/未启动」判断
    expect(journal.judgeSubmission('cm1').status).toBe('started');
    journal.close();
  });

  it('edit 带错误 revision → 拒绝（并发防护），不改内容', () => {
    const dir = tmpDir();
    const journal = RuntimeJournal.create(dir, { fsync: false });
    const s = createDeliverySession(journal, 's1');
    const a = submitDelivery(s, req({ clientMessageId: 'cm1', sessionId: 's1', rawText: 'v1' }));
    const r = editQueueItem(s, 'cm1', a.queueSeq === undefined ? -1 : (s.queue[0]?.revision ?? 0) + 5, 'hijack');
    expect(r.ok).toBe(false);
    expect(s.queue[0]?.rawText).toBe('v1');
    expect(s.queue[0]?.revision).toBe(1);
    journal.close();
  });

  it('remove 未启动项：revision+1 校验、从 queue 移除、journal 记 removed', () => {
    const dir = tmpDir();
    const journal = RuntimeJournal.create(dir, { fsync: false });
    const s = createDeliverySession(journal, 's1');
    submitDelivery(s, req({ clientMessageId: 'cm1', sessionId: 's1', rawText: 'v1' }));
    const r = removeQueueItem(s, 'cm1', 1);
    expect(r.ok).toBe(true);
    expect(s.queue.find((q) => q.id === 'cm1')).toBeUndefined();
    const removed = RuntimeJournal.readEntries(dir).entries.filter((e) => e.kind === 'queue/removed' && e.clientMessageId === 'cm1');
    expect(removed).toHaveLength(1);
    journal.close();
  });
});

describe('queue 上限（QUEUE_MAX_DEFAULT=20）', () => {
  it('达到上限：新提交 → rejected + 保留 draft 提示，不登记', () => {
    const dir = tmpDir();
    const journal = RuntimeJournal.create(dir, { fsync: false });
    const s = createDeliverySession(journal, 's1');
    for (let i = 0; i < QUEUE_MAX_DEFAULT; i++) {
      const a = submitDelivery(s, req({ clientMessageId: `cm-${i}`, sessionId: 's1', rawText: `m${i}` }));
      expect(a.state).toBe('accepted');
    }
    expect(s.queue).toHaveLength(QUEUE_MAX_DEFAULT);

    const over = submitDelivery(s, req({ clientMessageId: 'cm-over', sessionId: 's1', rawText: 'too-many' }));
    expect(over.state).toBe('rejected');
    expect(over.reason).toMatch(/draft/i);
    expect(s.queue).toHaveLength(QUEUE_MAX_DEFAULT);
    expect(RuntimeJournal.readEntries(dir).entries.filter((e) => e.kind === 'queue/accepted' && e.clientMessageId === 'cm-over')).toHaveLength(0);
    journal.close();
  });

  it('可配置上限覆盖默认 20', () => {
    const dir = tmpDir();
    const journal = RuntimeJournal.create(dir, { fsync: false });
    const s = createDeliverySession(journal, 's1', { maxQueue: 2 });
    expect(submitDelivery(s, req({ clientMessageId: 'a', sessionId: 's1', rawText: 'a' })).state).toBe('accepted');
    expect(submitDelivery(s, req({ clientMessageId: 'b', sessionId: 's1', rawText: 'b' })).state).toBe('accepted');
    expect(submitDelivery(s, req({ clientMessageId: 'c', sessionId: 's1', rawText: 'c' })).state).toBe('rejected');
    journal.close();
  });
});

describe('recoverQueue 恢复（默认 paused）', () => {
  it('重启恢复：已 accepted 项以 state:paused 返回，不自动执行', () => {
    const dir = tmpDir();
    const journal = RuntimeJournal.create(dir, { fsync: false });
    const s = createDeliverySession(journal, 's1');
    submitDelivery(s, req({ clientMessageId: 'cm1', sessionId: 's1', rawText: 'a' }));
    submitDelivery(s, req({ clientMessageId: 'cm2', sessionId: 's1', rawText: 'b' }));
    journal.close();

    const recovered = recoverQueue(dir, { sessionId: 's1' });
    expect(recovered.map((q) => q.id)).toEqual(['cm1', 'cm2']);
    for (const q of recovered) expect(q.state).toBe('paused');
  });

  it('崩溃半行恢复：accepted 半行（无换行）不算 durable，recover 不含该 id', () => {
    const dir = tmpDir();
    const journal = RuntimeJournal.create(dir, { fsync: false });
    const s = createDeliverySession(journal, 's1');
    submitDelivery(s, req({ clientMessageId: 'cm-good', sessionId: 's1', rawText: 'ok' }));
    journal.close();
    // 崩溃窗口：第二条 accepted 的 JSON 完整但缺换行（writeSync 半途中断）→ 未 durable
    tornAppend(dir, '{"v":1,"seq":2,"ts":"2026-09-08T00:00:00.000Z","kind":"queue/accepted","clientMessageId":"cm-torn","sessionId":"s1","payload":{"intent":"queue"}}');

    const recovered = recoverQueue(dir, { sessionId: 's1' });
    expect(recovered.map((q) => q.id)).toEqual(['cm-good']);
    expect(recovered[0]?.state).toBe('paused');
  });

  it('清空不自动触发：removed 项不被 recover（removed≠未提交，但也不再排队）', () => {
    const dir = tmpDir();
    const journal = RuntimeJournal.create(dir, { fsync: false });
    const s = createDeliverySession(journal, 's1');
    submitDelivery(s, req({ clientMessageId: 'cm1', sessionId: 's1', rawText: 'a' }));
    submitDelivery(s, req({ clientMessageId: 'cm2', sessionId: 's1', rawText: 'b' }));
    removeQueueItem(s, 'cm1', 1);
    journal.close();

    const recovered = recoverQueue(dir, { sessionId: 's1' });
    expect(recovered.map((q) => q.id)).toEqual(['cm2']);
  });
});

describe('resolveDelivery 崩溃对账', () => {
  it('从未提交 → not_started（可安全重提），ack 不是 rejected', () => {
    const dir = tmpDir();
    const journal = RuntimeJournal.create(dir, { fsync: false });
    const s = createDeliverySession(journal, 's1');
    const r = resolveDelivery(dir, 'ghost', { sessionLogState: 'none' });
    expect(r.status).toBe('not_started');
    expect(r.ack.state).not.toBe('rejected');
    journal.close();
  });

  it('durable accepd + 无 ack（崩溃窗口）→ started，不得当 not_started 再执行', () => {
    const dir = tmpDir();
    const journal = RuntimeJournal.create(dir, { fsync: false });
    const s = createDeliverySession(journal, 's1');
    submitDelivery(s, req({ clientMessageId: 'cm1', sessionId: 's1', rawText: 'a' }));
    // 不 close：模拟 ack 发出前崩溃
    const r = resolveDelivery(dir, 'cm1', { sessionLogState: 'unknown' });
    expect(r.status).toBe('started');
    expect(r.ack.state).not.toBe('not_started');
    expect(r.ack.state).not.toBe('rejected');
    journal.close();
  });

  it('中部损坏（journal 未知 id）→ unknown，绝不当作 rejected/not_started 处理', () => {
    const dir = tmpDir();
    const journal = RuntimeJournal.create(dir, { fsync: false });
    const s = createDeliverySession(journal, 's1');
    submitDelivery(s, req({ clientMessageId: 'cmA', sessionId: 's1', rawText: 'a' }));
    journal.close();
    tornAppend(dir, 'THIS_IS_NOT_JSON\n'); // 中部损坏 → 后续不可信

    const r = resolveDelivery(dir, 'cmNever', { sessionLogState: 'none' });
    expect(r.status).toBe('unknown');
    expect(r.ack.state).toBe('unknown');
    expect(r.ack.state).not.toBe('rejected');
    expect(r.ack.state).not.toBe('accepted');
  });
});
