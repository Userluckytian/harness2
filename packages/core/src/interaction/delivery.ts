// S3b submit 幂等交付逻辑层（不接线 WS/HTTP/sessions，那归 S3c）。
// 只依赖 interaction/types.ts + interaction/runtime-journal.ts（禁止 import server/tools/agent）。
// 责任：submit 幂等去重（同 id 同内容→既有 receipt / 同 id 不同内容→rejected / 新→accepted）、
// 先 durable accepted 后 ack、queue edit/remove（revision+1）、上限 QUEUE_MAX_DEFAULT、
// recoverQueue 默认 paused、resolveDelivery 崩溃对账（unknown≠rejected）。
// 事件溯源约束：模型可见输入仍由 session.log 投影；本层只做操作状态，不写第二套对话正文。
import { QUEUE_MAX_DEFAULT } from './types.js';
import type { ClientMessageId, QueueEntry, SubmitAck, SubmitRequest, SessionId } from './types.js';
import { RuntimeJournal, judgeSubmission } from './runtime-journal.js';
import type { QueueAcceptedEntry, SubmissionStatus, SubmissionJudgement } from './runtime-journal.js';

// —— 内容指纹（同 id 判「同内容」用；references 排序敏感，故按提交原样序列化） ——

function contentKey(req: SubmitRequest): string {
  return JSON.stringify({
    rawText: req.rawText,
    intent: req.intent,
    references: req.references ?? undefined,
  });
}

// —— 会话级交付状态（每个 session 一个；journal 为 durable 账本，queue 为活队列） ——

export interface DeliveryOptions {
  /** queue 上限（默认 QUEUE_MAX_DEFAULT=20），可配置 */
  maxQueue?: number;
}

export interface DeliverySession {
  sessionId: SessionId;
  journal: RuntimeJournal;
  /** 活队列（含正文，按 accept 序）；journal 只记操作状态 */
  queue: QueueEntry[];
  /** 活跃内容的指纹：clientMessageId -> contentKey（供同 id 去重比较） */
  contentKeys: Map<ClientMessageId, string>;
  maxQueue: number;
}

export function createDeliverySession(
  journal: RuntimeJournal,
  sessionId: SessionId,
  opts: DeliveryOptions = {},
): DeliverySession {
  return {
    sessionId,
    journal,
    queue: [],
    contentKeys: new Map(),
    maxQueue: opts.maxQueue ?? QUEUE_MAX_DEFAULT,
  };
}

// —— queue 上限 ——

/** 是否还有空位：只统计「活跃排队（state==='queued'）」项；恢复的 paused 项不计入上限
 *  （S5 carry-over：重启恢复的历史 accepted 不占满 20，不阻塞新 submit）。 */
export function deliveryHasSlot(s: DeliverySession): boolean {
  const active = s.queue.filter((q) => q.state === 'queued').length;
  return active < s.maxQueue;
}

/**
 * continue 清场（S5 carry-over）：把全部 paused（重启恢复）项从活队列移除（出队/清位）。
 * paused 项已不是「待执行的新提交」（恢复项正文不入 journal，无法忠实重放），
 * 移出后不再占用队列槽位、也不可能被重复受理/执行。返回被清出项的 id 与恢复的占位正文
 * （正文为空 = journal 不存正文，真实重放需调用方按 ref 回填）。调用方负责把已清出项
 * 真正交给执行管线（sendUserMessage）。
 */
export function continueQueue(s: DeliverySession): Array<{ id: ClientMessageId; rawText: string }> {
  const removed: Array<{ id: ClientMessageId; rawText: string }> = [];
  for (let i = s.queue.length - 1; i >= 0; i--) {
    const item = s.queue[i]!;
    if (item.state === 'paused') {
      removed.push({ id: item.id, rawText: item.rawText });
      s.queue.splice(i, 1);
      s.contentKeys.delete(item.id);
    }
  }
  return removed.reverse();
}

// —— submit 幂等 ——

/** 从 journal 读该 clientMessageId 已 durable accepted 的 queueSeq（重启后 receipt 复用） */
function durableQueueSeq(journal: RuntimeJournal, clientMessageId: ClientMessageId): number | undefined {
  const found = journal
    .readEntries()
    .entries.find(
      (e): e is QueueAcceptedEntry => e.kind === 'queue/accepted' && e.clientMessageId === clientMessageId,
    );
  return found?.payload.queueSeq;
}

/** 既有在队列项 → 同内容返回 receipt，不同内容拒绝（不重复登记，不新建 accepted） */
function handleExisting(
  s: DeliverySession,
  existing: QueueEntry,
  key: string,
): SubmitAck {
  if (s.contentKeys.get(existing.id) === key) {
    const idx = s.queue.findIndex((q) => q.id === existing.id);
    return {
      clientMessageId: existing.id,
      sessionId: s.sessionId,
      state: 'accepted',
      queueSeq: idx >= 0 ? idx : undefined,
    };
  }
  return {
    clientMessageId: existing.id,
    sessionId: s.sessionId,
    state: 'rejected',
    reason: 'duplicate clientMessageId with different content',
  };
}

/**
 * submit 幂等交付。先 durable（journal queue/accepted）后 ack。
 * - 同 id 同内容 → 返回既有 receipt（不重复登记）。
 * - 同 id 不同内容 → rejected。
 * - 新提交 → journal 先写 durable accepted → 返回 accepted + queueSeq。
 * - 超限 → rejected + 保留 draft 提示。
 */
export function submitDelivery(s: DeliverySession, req: SubmitRequest): SubmitAck {
  const key = contentKey(req);
  const existing = s.queue.find((q) => q.id === req.clientMessageId);

  // 同会话活队列里已有 → 同内容凭据 / 不同内容拒绝
  if (existing) return handleExisting(s, existing, key);

  // 跨重启对账：journal 已 durable accepted（本会话上次已受理）→ 返回既有 receipt，不重复登记
  const judge = s.journal.judgeSubmission(req.clientMessageId);
  if (judge.status === 'started') {
    const accepted: SubmitAck = {
      clientMessageId: req.clientMessageId,
      sessionId: req.sessionId,
      state: 'accepted',
      queueSeq: durableQueueSeq(s.journal, req.clientMessageId),
    };
    return accepted;
  }
  if (judge.status === 'unknown') {
    // 未知绝不当作 rejected/not_started 处理：不登记新 accept，回 unknown
    return {
      clientMessageId: req.clientMessageId,
      sessionId: req.sessionId,
      state: 'unknown',
      reason: 'journal inconsistent for this clientMessageId; not treated as rejected',
    };
  }

  // 新提交：先检查上限（超限保留 draft）
  if (!deliveryHasSlot(s)) {
    return {
      clientMessageId: req.clientMessageId,
      sessionId: req.sessionId,
      state: 'rejected',
      reason: `queue is full (max ${s.maxQueue}); draft kept, not queued`,
    };
  }

  // durable 先行：journal 写 accepted（含 queueSeq 登记），成功后 ack
  const queueSeq = s.queue.length;
  s.journal.append({
    kind: 'queue/accepted',
    clientMessageId: req.clientMessageId,
    sessionId: req.sessionId,
    intent: req.intent,
    queueSeq,
  });
  s.queue.push({
    id: req.clientMessageId,
    revision: 1,
    rawText: req.rawText,
    references: req.references,
    intent: req.intent,
    state: 'queued',
  });
  s.contentKeys.set(req.clientMessageId, key);

  return {
    clientMessageId: req.clientMessageId,
    sessionId: req.sessionId,
    state: 'accepted',
    queueSeq,
  };
}

// —— queue 编辑 / 移除（未启动项可按 id+revision edit/remove；每次变更 revision+1） ——

export interface QueueEditResult {
  ok: boolean;
  reason?: string;
  revision?: number;
}

export function editQueueItem(
  s: DeliverySession,
  clientMessageId: ClientMessageId,
  revision: number,
  newText: string,
): QueueEditResult {
  const idx = s.queue.findIndex((q) => q.id === clientMessageId);
  if (idx < 0) return { ok: false, reason: 'queue item not found' };
  const item = s.queue[idx]!;
  if (item.revision !== revision) {
    return { ok: false, reason: `revision mismatch: expected ${item.revision}, got ${revision}` };
  }
  item.rawText = newText;
  item.revision += 1;
  // 内容变更 → 更新指纹（同 id 后续去重将基于新内容比较）
  s.contentKeys.set(clientMessageId, JSON.stringify({ rawText: newText, intent: item.intent, references: item.references ?? undefined }));
  return { ok: true, revision: item.revision };
}

export function removeQueueItem(
  s: DeliverySession,
  clientMessageId: ClientMessageId,
  revision: number,
): QueueEditResult {
  const idx = s.queue.findIndex((q) => q.id === clientMessageId);
  if (idx < 0) return { ok: false, reason: 'queue item not found' };
  const item = s.queue[idx]!;
  if (item.revision !== revision) {
    return { ok: false, reason: `revision mismatch: expected ${item.revision}, got ${revision}` };
  }
  // removed 语义：记录 removed（removed≠未提交；但也不再排队），从活队列移除
  s.journal.append({ kind: 'queue/removed', clientMessageId, reason: 'user-remove' });
  s.queue.splice(idx, 1);
  s.contentKeys.delete(clientMessageId);
  return { ok: true, revision: item.revision };
}

// —— 恢复：journal 重建队列（默认 paused，不自动执行；清空独立操作不由恢复触发） ——

export interface RecoverQueueOptions {
  sessionId: SessionId;
}

/**
 * 从 journal 重建 queue。journal 只存操作状态（不含正文），恢复的正文置空由 session.log 投影补全。
 * 顺序 = accepted seq 序；已 removed 的项不再排队；一律 state:'paused'（不惊喜执行）。
 * 崩溃撕裂：accepted 半行（未 \n）不算 durable，不计入。
 */
export function recoverQueue(dir: string, opts: RecoverQueueOptions): QueueEntry[] {
  const { entries } = RuntimeJournal.readEntries(dir);
  const accepted: QueueAcceptedEntry[] = [];
  const removedAll = new Set<ClientMessageId>();
  for (const e of entries) {
    if (e.kind === 'queue/accepted' && e.sessionId === opts.sessionId) accepted.push(e);
    else if (e.kind === 'queue/removed') removedAll.add(e.clientMessageId);
  }
  return accepted
    .filter((a) => !removedAll.has(a.clientMessageId))
    .map((a) => ({
      id: a.clientMessageId,
      revision: 1,
      rawText: '',
      intent: a.payload.intent,
      state: 'paused' as const,
    }));
}

// —— 崩溃对账：not_started / started / unknown（unknown≠rejected） ——

export interface DeliveryResolveOptions {
  /** session.log 侧状态（交给调用方语义拼装；本层主要以 journal 判） */
  sessionLogState?: 'none' | 'running' | 'completed' | 'unknown';
  sessionId?: SessionId;
}

export interface DeliveryResolveResult {
  status: SubmissionStatus;
  ack: SubmitAck;
  acceptedSeq?: number;
  judgement: SubmissionJudgement;
}

/**
 * 崩溃后 resolve：从 journal 判 not_started/started/unknown。
 * unknown 绝不当作 rejected 处理，回 ack=unknown；started 回已接受 receipt；not_started 可安全重提。
 */
export function resolveDelivery(
  dir: string,
  clientMessageId: ClientMessageId,
  opts: DeliveryResolveOptions = {},
): DeliveryResolveResult {
  const judgement = judgeSubmission(dir, clientMessageId);

  if (judgement.status === 'started') {
    return {
      status: 'started',
      ack: {
        clientMessageId,
        sessionId: opts.sessionId ?? '',
        state: 'accepted',
        queueSeq: durableQueueSeqFromEntries(dir, clientMessageId),
      },
      acceptedSeq: judgement.acceptedSeq,
      judgement,
    };
  }
  if (judgement.status === 'not_started') {
    return {
      status: 'not_started',
      ack: {
        clientMessageId,
        sessionId: opts.sessionId ?? '',
        state: 'unknown',
        reason: 'not_started: no durable accept; safe to resubmit',
      },
      judgement,
    };
  }
  return {
    status: 'unknown',
    ack: {
      clientMessageId,
      sessionId: opts.sessionId ?? '',
      state: 'unknown',
      reason: 'journal inconsistent; not treated as rejected',
    },
    judgement,
  };
}

function durableQueueSeqFromEntries(dir: string, clientMessageId: ClientMessageId): number | undefined {
  const found = RuntimeJournal.readEntries(dir).entries.find(
    (e): e is QueueAcceptedEntry => e.kind === 'queue/accepted' && e.clientMessageId === clientMessageId,
  );
  return found?.payload.queueSeq;
}
