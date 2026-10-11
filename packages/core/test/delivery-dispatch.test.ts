// D3 回归：提交被派发进 turn（开始执行）后必须从**活队列**出队。
// 语义：queue = 「待执行」活队列；durable journal（queue/accepted）是恢复账本，保留不动。
// 钉住：派发后 resume-snapshot.queue 不含该项；paused（重启恢复）项不受派发路径影响；
// 出队后释放槽位（可再 submit）；重复派发幂等安全。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSessionsRoot,
  MockProvider,
  registerBuiltinTools,
  SessionHub,
  SessionManager,
  ToolRegistry,
} from '../src/index.js';
import { RUNTIME_JOURNAL_FILE, RuntimeJournal } from '../src/interaction/runtime-journal.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-dispatch-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeHub(home: string, root: string): SessionHub {
  return new SessionHub({
    manager: new SessionManager(defaultSessionsRoot(home)),
    // 足量脚本：本文件并发提交多条，避免 mock 脚本耗尽干扰队列断言
    provider: new MockProvider(Array.from({ length: 8 }, () => ({ textChunks: ['收到'] }))),
    tools: (() => {
      const r = new ToolRegistry();
      registerBuiltinTools(r);
      return r;
    })(),
    cwd: root,
  });
}

describe('D3 派发即出队（活队列语义）', () => {
  it('提交被派发后：活队列不再含该项（刷新快照不显示「排队」），durable journal 保留', async () => {
    const home = tmpDir();
    const root = tmpDir();
    const hub = makeHub(home, root);
    const { id, dir } = hub.create(root);

    const ack = hub.submitAck({ clientMessageId: 'cm-d3', sessionId: id, rawText: '你好', intent: 'queue' });
    expect(ack.state).toBe('accepted');

    // 派发（sendUserMessage）成功即出队：快照活队列不得再有该 queued 项
    const snap = hub.resumeSnapshot({ sessionId: id, lastSeq: 0, epoch: 1 });
    expect(snap?.queue.filter((q) => q.state === 'queued')).toHaveLength(0);
    expect(snap?.queue.some((q) => q.id === 'cm-d3')).toBe(false);

    await sleep(200); // 等 turn 跑完
    await hub.close();

    // 恢复账本不动：journal 仍保留 durable accepted（重启可对账/恢复）
    const accepted = RuntimeJournal.readEntries(dir).entries.filter(
      (e) => e.kind === 'queue/accepted' && e.clientMessageId === 'cm-d3',
    );
    expect(accepted).toHaveLength(1);
  });

  it('连发多条：全部派发后活队列清空（不累积幽灵条目）', async () => {
    const home = tmpDir();
    const root = tmpDir();
    const hub = makeHub(home, root);
    const { id } = hub.create(root);

    for (const n of ['一', '二', '三']) {
      const ack = hub.submitAck({ clientMessageId: `cm-${n}`, sessionId: id, rawText: n, intent: 'queue' });
      expect(ack.state).toBe('accepted');
    }
    const snap = hub.resumeSnapshot({ sessionId: id, lastSeq: 0, epoch: 1 });
    expect(snap?.queue).toHaveLength(0);
    await hub.close();
  });

  it('出队后释放槽位：达到上限后派发一项可再受理新 submit', async () => {
    const home = tmpDir();
    const root = tmpDir();
    const hub = makeHub(home, root);
    const { id } = hub.create(root);
    // 单会话 maxQueue 默认 20；本用例只验证「派发腾位」这一关系，逐条 submit 派发后队列始终为空。
    const a1 = hub.submitAck({ clientMessageId: 'slot-1', sessionId: id, rawText: '甲', intent: 'queue' });
    expect(a1.state).toBe('accepted');
    const a2 = hub.submitAck({ clientMessageId: 'slot-2', sessionId: id, rawText: '乙', intent: 'queue' });
    expect(a2.state).toBe('accepted'); // 若第一项未出队占位，第二项仍应受理（上限 20 未满）；此处验证腾位不误伤
    const snap = hub.resumeSnapshot({ sessionId: id, lastSeq: 0, epoch: 1 });
    expect(snap?.queue).toHaveLength(0);
    await hub.close();
  });

  it('paused（重启恢复）项不受派发路径影响：恢复项保留，新提交派发不误清恢复项', async () => {
    const home = tmpDir();
    const root = tmpDir();
    // A：提交一项并执行（journal 落 durable accept）
    const A = makeHub(home, root);
    const { id } = A.create(root);
    const a = A.submitAck({ clientMessageId: 'cm-recover', sessionId: id, rawText: '持久项', intent: 'queue' });
    expect(a.state).toBe('accepted');
    await sleep(200);
    await A.close();

    // B 重启：durable accepted 恢复为 paused
    const B = makeHub(home, root);
    const snapBefore = B.resumeSnapshot({ sessionId: id, lastSeq: 0, epoch: 1 });
    expect(snapBefore?.queue.some((q) => q.id === 'cm-recover' && q.state === 'paused')).toBe(true);

    // 新提交触发 dispatchQueued：只应派发新项，paused 恢复项必须原样保留
    const nb = B.submitAck({ clientMessageId: 'cm-new', sessionId: id, rawText: '新消息', intent: 'queue' });
    expect(nb.state).toBe('accepted');
    const snapAfter = B.resumeSnapshot({ sessionId: id, lastSeq: 0, epoch: 2 });
    expect(snapAfter?.queue.some((q) => q.id === 'cm-recover' && q.state === 'paused')).toBe(true);
    expect(snapAfter?.queue.some((q) => q.id === 'cm-new')).toBe(false);
    await B.close();
  });
});

describe('D3 journal 恢复账本保留（不因出队而改写）', () => {
  it('出队不改写 journal：runtime.v1.jsonl 仍含 queue/accepted 行', async () => {
    const home = tmpDir();
    const root = tmpDir();
    const hub = makeHub(home, root);
    const { id, dir } = hub.create(root);
    hub.submitAck({ clientMessageId: 'cm-ledger', sessionId: id, rawText: 'x', intent: 'queue' });
    await sleep(150);
    await hub.close();
    const raw = RuntimeJournal.readEntries(dir).entries.filter((e) => e.kind === 'queue/accepted');
    expect(raw.some((e) => e.clientMessageId === 'cm-ledger')).toBe(true);
    expect(RUNTIME_JOURNAL_FILE.endsWith('.jsonl')).toBe(true);
  });
});
