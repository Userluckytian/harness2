// FixC C1 — journal 崩溃对账口径。
// 验收判定 C（P0-2b）：
//   1. durable accepted 落盘后崩溃重开 → 同 clientMessageId 幂等判定
//      （不重跑 / 不误 rejected）——经 submitDelivery + judgeSubmission 双双钉死；
//   2. session.log 缺对应 turn 的 orphaned submission 对账口径
//      （started-orphaned，绝不当作 rejected）；
//   3. 对账在 core 内可完成（只读 journal + session.log 判定，不依赖桌面/重放兜底）。
// 全部本地临时目录，无网络。
import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeJournal, judgeSubmission } from '../src/interaction/runtime-journal.js';
import { createDeliverySession, submitDelivery } from '../src/interaction/delivery.js';
import { reconcileSubmission } from '../src/interaction/delivery.js';
import { SessionWriter } from '../src/session/writer.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-rec-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 直接写一份最小 session.log（header + 可选 user/message turn），模拟「有/无 turn」 */
function writeSessionLog(dir: string, opts: { headerOnly?: boolean; userTexts?: string[]; sessionId?: string }): void {
  const writer = SessionWriter.create(dir, { sessionId: opts.sessionId ?? 's1' }, { fsync: false });
  try {
    for (const t of opts.userTexts ?? []) writer.append('user/message', { text: t, turnId: `turn-${t}` });
  } finally {
    writer.close();
  }
}

describe('C1 幂等判定：durable accepted 崩溃重开', () => {
  it('[核心] accepted 落盘后重开（空活队列）→ 同 id 返回既有 receipt，不重跑、不误 rejected', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'cm1', sessionId: 's1', intent: 'queue', queueSeq: 0 });
    const linesBefore = RuntimeJournal.readEntries(dir).watermark.lineCount;
    w.close(); // durable：已落盘；崩溃窗口 = ack 未发出

    // 重启：全新进程视角（重开 journal + 空活队列）
    const w2 = RuntimeJournal.open(dir, { fsync: false });
    const s = createDeliverySession(w2, 's1');
    const ack = submitDelivery(s, {
      clientMessageId: 'cm1',
      sessionId: 's1',
      rawText: 'hello',
      intent: 'queue',
    });

    // 幂等：返回 accepted + 既有 queueSeq（不新建 accept、不重跑）
    expect(ack.state).toBe('accepted');
    expect(ack.queueSeq).toBe(0);
    expect(ack.state).not.toBe('rejected');
    // journal 未新增 accepted（不重复登记）
    expect(RuntimeJournal.readEntries(dir).watermark.lineCount).toBe(linesBefore);
    // judgeSubmission 独立判定 started（不误判 not_started）
    expect(judgeSubmission(dir, 'cm1').status).toBe('started');
    w2.close();
  });

  it('崩溃窗口（无 ack 无 close）→ 独立只读 judgeSubmission 判 started，恢复不得盲目再执行', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'cm-boom', sessionId: 's1', intent: 'queue' });
    // 不 close：模拟崩溃；跨进程只读对账（无锁）
    const j = judgeSubmission(dir, 'cm-boom');
    expect(j.status).toBe('started');
    expect(j.status).not.toBe('not_started');
    expect(j.status).not.toBe('rejected');
    w.close();
  });
});

describe('C1 orphaned 对账：journal accepted 但 session.log 缺 turn', () => {
  it('[核心] journal accepted + session.log 不存在 → started-orphaned（不当作 rejected / not_started）', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'cmO', sessionId: 's1', intent: 'queue', queueSeq: 0 });
    w.close();

    const r = reconcileSubmission(dir, 'cmO');
    expect(r.status).toBe('started');
    expect(r.orphaned).toBe(true);
    expect(r.phase).toBe('orphaned');
    expect(r.acceptedSeq).toBe(1);
    expect(r.sessionLogHasTurn).toBe(false);
    expect(r.status).not.toBe('rejected');
    expect(r.status).not.toBe('not_started');
    expect(r.status).not.toBe('unknown');
  });

  it('journal accepted + session.log 只有 header（无任何 user turn）→ started-orphaned', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'cmO2', sessionId: 's1', intent: 'queue' });
    w.close();
    writeSessionLog(dir, { headerOnly: true });

    const r = reconcileSubmission(dir, 'cmO2');
    expect(r.status).toBe('started');
    expect(r.orphaned).toBe(true);
    expect(r.phase).toBe('orphaned');
    expect(r.sessionLogHasTurn).toBe(false);
  });

  it('journal accepted + 无执行证据 + session.log 已有 user turn（无法归因）→ 保守 started/in-flight，不误判孤儿', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'cmX', sessionId: 's1', intent: 'queue' });
    w.close();
    // 会话日志里有别的 turn（非本 submission 可归因）→ 不能断言本提交未启动，保守按 started
    writeSessionLog(dir, { userTexts: ['其他任务'] });

    const r = reconcileSubmission(dir, 'cmX');
    expect(r.status).toBe('started');
    expect(r.orphaned).toBe(false);
    expect(r.phase).toBe('in-flight');
    expect(r.sessionLogHasTurn).toBe(true);
  });

  it('journal accepted + 执行证据（task/transition 带 clientMessageId）→ 非孤儿，按 outcome 定 phase', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    const acc = w.append({ kind: 'queue/accepted', clientMessageId: 'cmD', sessionId: 's1', intent: 'queue' });
    w.append({ kind: 'task/transition', taskId: 't1', clientMessageId: 'cmD', from: 'registered', to: 'queued' });
    w.append({ kind: 'task/transition', taskId: 't1', clientMessageId: 'cmD', from: 'queued', to: 'starting' });
    w.append({ kind: 'task/transition', taskId: 't1', clientMessageId: 'cmD', from: 'running', to: 'completed' });
    w.close();

    const r = reconcileSubmission(dir, 'cmD');
    expect(r.status).toBe('started');
    expect(r.orphaned).toBe(false);
    expect(r.executedInJournal).toBe(true);
    expect(r.phase).toBe('completed');
    expect(r.acceptedSeq).toBe(acc.seq);
  });

  it('orphaned 判定核心：orphaned 只允许「无执行证据 && 无 session turn」，绝不落 rejected', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'cmNever', sessionId: 's1', intent: 'queue' });
    w.close();
    const r = reconcileSubmission(dir, 'cmNever');
    if (r.orphaned) {
      expect(r.phase).toBe('orphaned');
    }
    expect(r.status).not.toBe('rejected');
  });

  it('从未 accepted（无 journal 记录）→ not_started（可安全重提）', () => {
    const dir = tmpDir();
    const r = reconcileSubmission(dir, 'ghost');
    expect(r.status).toBe('not_started');
    expect(r.orphaned).toBe(false);
  });

  it('中部损坏 → unknown（≠ rejected / not_started / started）', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'seed', sessionId: 's1', intent: 'queue' });
    w.close();
    // 损坏行之后不可信
    appendFileSync(join(dir, 'runtime.v1.jsonl'), 'NOT_JSON\n', 'utf8');

    const r = reconcileSubmission(dir, 'ghost-in-corrupt');
    expect(r.status).toBe('unknown');
    expect(r.status).not.toBe('rejected');
    expect(r.status).not.toBe('not_started');
  });
});

describe('C1 对账在 core 内完成（不依赖桌面/重放兜底）', () => {
  it('reconcileSubmission 仅读目录文件即给出判定：无任何 server/hub/桌面依赖', () => {
    const dir = tmpDir();
    const w = RuntimeJournal.create(dir, { fsync: false });
    w.append({ kind: 'queue/accepted', clientMessageId: 'cmCore', sessionId: 's1', intent: 'queue' });
    w.close();
    // 只调用 core 层函数（读 journal + session.log），不构造 serve/hub
    const r = reconcileSubmission(dir, 'cmCore');
    expect(typeof r.status).toBe('string');
    expect(typeof r.orphaned).toBe('boolean');
    // 对账结果足以让调用方决策：started/orphaned → 复用既有 receipt；unknown → 不重提不拒绝
    const judgement = judgeSubmission(dir, 'cmCore');
    expect(judgement.status).toBe('started');
  });
});

// 防 lint 未使用告警：占位使用 mkdirSync/writeFileSync 不影响语义
void mkdirSync;
void writeFileSync;
void randomUUID;
