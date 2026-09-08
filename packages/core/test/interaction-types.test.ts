// 共享交互契约类型（S0 冻结，对齐 I1 §6）纯校验逻辑测试。
// 只测纯类型+纯函数（校验/常量）：不触文件 I/O、不触 WS/HTTP（那归 S1-S7）。
import { describe, expect, it } from 'vitest';
import {
  QUEUE_MAX_DEFAULT,
  RETRY_MAX_EXTRA_ATTEMPTS,
  RETRY_MAX_EXTRA_PER_TURN,
  RETRY_MAX_TOTAL_WAIT_SECONDS,
  RETRY_BACKOFF_SECONDS,
  TASK_STATES,
  TASK_TERMINAL_STATES,
  assertSequentialChunk,
  canTaskTransition,
  classifyRetryable,
  isApprovalDecision,
  isApprovalExpired,
  isCancelAckState,
  isCancelTargetKind,
  isNonNegativeInteger,
  isValidChunkOffset,
  isValidEpoch,
  isValidLastSeq,
  isValidSteerRequest,
  isSubmitIntent,
  isTerminalTaskState,
  queueHasSlot,
  scopeConfinesToSession,
  PROTOCOL_VERSION,
} from '../src/interaction/types.js';
import { invalidFixtures, validFixtures } from './fixtures/interaction-protocol.js';

describe('身份与协议版本（I1 §6）', () => {
  it('protocolVersion=2（WS 能力协商底线，桌面/终端共用）', () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it('queue 每 session 默认上限 20（可配置），超限保留 draft 并提示', () => {
    expect(QUEUE_MAX_DEFAULT).toBe(20);
  });

  it('重试预算常量冻结：额外最多 3 次、2/10/30s 指数档、整 turn 最多 6 次、累计 ≤120s', () => {
    expect(RETRY_MAX_EXTRA_ATTEMPTS).toBe(3);
    expect(RETRY_BACKOFF_SECONDS).toEqual([2, 10, 30]);
    expect(RETRY_MAX_EXTRA_PER_TURN).toBe(6);
    expect(RETRY_MAX_TOTAL_WAIT_SECONDS).toBe(120);
  });
});

describe('submit 契约（intent 合法值 + queue 上限）', () => {
  it('intent 合法值为 queue | steer', () => {
    expect(isSubmitIntent('queue')).toBe(true);
    expect(isSubmitIntent('steer')).toBe(true);
  });

  it('intent 拒绝未知值（chat/wait/空串/非字符串）——禁止猜释义', () => {
    expect(isSubmitIntent('chat')).toBe(false);
    expect(isSubmitIntent('wait')).toBe(false);
    expect(isSubmitIntent('')).toBe(false);
    expect(isSubmitIntent(undefined)).toBe(false);
  });

  it('queueHasSlot：未满返回 true（默认上限 20）', () => {
    expect(queueHasSlot(0)).toBe(true);
    expect(queueHasSlot(19)).toBe(true);
  });

  it('queueHasSlot：达到/超过上限返回 false', () => {
    expect(queueHasSlot(20)).toBe(false);
    expect(queueHasSlot(21)).toBe(false);
  });

  it('queueHasSlot：可配置上限（config 覆盖默认 20）', () => {
    expect(queueHasSlot(0, 5)).toBe(true);
    expect(queueHasSlot(5, 5)).toBe(false);
  });
});

describe('水位/epoch 有效性（resumeSubscription + delta chunkOffset）', () => {
  it('非负整数原语：直接校验数值/整数/边界/类型', () => {
    expect(isNonNegativeInteger(0)).toBe(true);
    expect(isNonNegativeInteger(7)).toBe(true);
    expect(isNonNegativeInteger(-1)).toBe(false);
    expect(isNonNegativeInteger(1.5)).toBe(false);
    expect(isNonNegativeInteger('7')).toBe(false);
    expect(isNonNegativeInteger(undefined)).toBe(false);
  });

  it('chunkOffset 必须是非负整数（0 起始单调 +1 水位）', () => {
    expect(isValidChunkOffset(0)).toBe(true);
    expect(isValidChunkOffset(1)).toBe(true);
    expect(isValidChunkOffset(-1)).toBe(false);
    expect(isValidChunkOffset(1.5)).toBe(false);
    expect(isValidChunkOffset(Number.NaN)).toBe(false);
  });

  it('lastSeq 必须是非负整数（0 = 空会话）', () => {
    expect(isValidLastSeq(0)).toBe(true);
    expect(isValidLastSeq(42)).toBe(true);
    expect(isValidLastSeq(-1)).toBe(false);
    expect(isValidLastSeq(2.5)).toBe(false);
  });

  it('epoch 只区分连接代次，必须是非负整数', () => {
    expect(isValidEpoch(0)).toBe(true);
    expect(isValidEpoch(7)).toBe(true);
    expect(isValidEpoch(-1)).toBe(false);
    expect(isValidEpoch(1.0)).toBe(true);
    expect(isValidEpoch(Number.NaN)).toBe(false);
  });
});

describe('delta 完整归属 + chunkOffset 连续性（attempt/delivery）', () => {
  it('下一块 chunkOffset = 上一块 chunkOffset + 上一块文本长度（无缺口无重叠）', () => {
    expect(assertSequentialChunk({ chunkOffset: 0, text: 'hello' }, 5)).toBe(true);
    expect(assertSequentialChunk({ chunkOffset: 5, text: '世界' }, 7)).toBe(true);
  });

  it('缺口（下一个 offset 超前）→ false', () => {
    expect(assertSequentialChunk({ chunkOffset: 0, text: 'a' }, 3)).toBe(false);
  });

  it('重叠/迟到（下一个 offset 被已有文本盖住）→ false，作为重复帧丢弃依据', () => {
    expect(assertSequentialChunk({ chunkOffset: 2, text: 'ab' }, 3)).toBe(false);
  });
});

describe('approval 契约（decision + 过期 + 作用域）', () => {
  it('respond 的 decision 只有 allow | deny', () => {
    expect(isApprovalDecision('allow')).toBe(true);
    expect(isApprovalDecision('deny')).toBe(true);
    expect(isApprovalDecision('maybe')).toBe(false);
    expect(isApprovalDecision('')).toBe(false);
  });

  it('过期判定：明确的 expiresAt 过去/非法 → 过期（重复/过期结果需明确）', () => {
    expect(isApprovalExpired(new Date(Date.now() - 5_000).toISOString())).toBe(true);
    expect(isApprovalExpired('not-a-date')).toBe(true);
  });

  it('未过期：未来 expiresAt → false（仍有待批窗口）', () => {
    expect(isApprovalExpired(new Date(Date.now() + 60_000).toISOString())).toBe(false);
  });

  it('「本会话总是」作用域必须框定在请求自身 sessionId 内（跨会话拒绝泄漏）', () => {
    expect(scopeConfinesToSession({ mode: 'once' }, 's')).toBe(true);
    expect(scopeConfinesToSession({ mode: 'session', sessionId: 's' }, 's')).toBe(true);
    expect(scopeConfinesToSession({ mode: 'session', sessionId: 'other-session' }, 's')).toBe(false);
  });
});

describe('cancel 契约（target + ack 三态）', () => {
  it('cancel ack 只有 stopping | cancelled | unknown（UI 立即 stopping，确认后 cancelled）', () => {
    expect(isCancelAckState('stopping')).toBe(true);
    expect(isCancelAckState('cancelled')).toBe(true);
    expect(isCancelAckState('unknown')).toBe(true);
    expect(isCancelAckState('done')).toBe(false);
  });

  it('cancel target 只有 turn | task（单 child 取消不杀兄弟归 S5 协调）', () => {
    expect(isCancelTargetKind('turn')).toBe(true);
    expect(isCancelTargetKind('task')).toBe(true);
    expect(isCancelTargetKind('child')).toBe(false);
    expect(isCancelTargetKind(undefined)).toBe(false);
  });
});

describe('task 生命周期（终态单调）', () => {
  it('状态枚举含 §6 全链 registered→…→completed/failed/cancelled/unknown', () => {
    expect(TASK_STATES).toEqual([
      'registered',
      'queued',
      'starting',
      'running',
      'waiting-approval',
      'stopping',
      'completed',
      'failed',
      'cancelled',
      'unknown',
    ]);
  });

  it('终态集合 = completed | failed | cancelled | unknown', () => {
    for (const s of ['completed', 'failed', 'cancelled', 'unknown']) {
      expect(TASK_TERMINAL_STATES.has(s as (typeof TASK_STATES)[number])).toBe(true);
      expect(isTerminalTaskState(s as (typeof TASK_STATES)[number])).toBe(true);
    }
    expect(isTerminalTaskState('running')).toBe(false);
    expect(isTerminalTaskState('stopping')).toBe(false);
  });

  it('正向迁移合法：registered→queued→starting→running/waiting-approval→stopping→终态', () => {
    expect(canTaskTransition('registered', 'queued')).toBe(true);
    expect(canTaskTransition('queued', 'starting')).toBe(true);
    expect(canTaskTransition('starting', 'running')).toBe(true);
    expect(canTaskTransition('starting', 'waiting-approval')).toBe(true);
    expect(canTaskTransition('running', 'waiting-approval')).toBe(true);
    expect(canTaskTransition('waiting-approval', 'running')).toBe(true);
    expect(canTaskTransition('running', 'stopping')).toBe(true);
    expect(canTaskTransition('stopping', 'cancelled')).toBe(true);
    expect(canTaskTransition('stopping', 'completed')).toBe(true);
    expect(canTaskTransition('running', 'completed')).toBe(true);
    expect(canTaskTransition('running', 'failed')).toBe(true);
    expect(canTaskTransition('running', 'cancelled')).toBe(true);
    expect(canTaskTransition('running', 'unknown')).toBe(true);
  });

  it('状态回归非法：不能退到更早阶段', () => {
    expect(canTaskTransition('queued', 'registered')).toBe(false);
    expect(canTaskTransition('running', 'queued')).toBe(false);
    expect(canTaskTransition('stopping', 'running')).toBe(false);
  });

  it('终态单调：一旦终态，不得再迁移（completed/cancelled/unknown 均无出边）', () => {
    expect(canTaskTransition('completed', 'running')).toBe(false);
    expect(canTaskTransition('failed', 'queued')).toBe(false);
    expect(canTaskTransition('cancelled', 'stopping')).toBe(false);
    expect(canTaskTransition('unknown', 'registered')).toBe(false);
    expect(canTaskTransition('completed', 'completed')).toBe(false);
  });
});

describe('steer 契约（绑定 expectedTurnId + 唯一 id）', () => {
  it('合法 steer：id/expectedTurnId/text 均须非空字符串', () => {
    expect(isValidSteerRequest({ id: 's-1', expectedTurnId: 't-1', text: '停一下' })).toBe(true);
  });

  it('缺 id / expectedTurnId / 空文本 → 拒绝（未协商不偷偷 abort/resend）', () => {
    expect(isValidSteerRequest({ id: '', expectedTurnId: 't-1', text: 'x' })).toBe(false);
    expect(isValidSteerRequest({ id: 's-1', expectedTurnId: '', text: 'x' })).toBe(false);
    expect(isValidSteerRequest({ id: 's-1', expectedTurnId: 't-1', text: '' })).toBe(false);
    expect(isValidSteerRequest({ id: 's-1' })).toBe(false);
    expect(isValidSteerRequest(null)).toBe(false);
  });
});

describe('重试错误码分类（S4 实现，S0 只冻结枚举位）', () => {
  it('可恢复：网络/超时/429/可恢复 5xx/stream_truncated', () => {
    expect(classifyRetryable('network')).toBe('retryable');
    expect(classifyRetryable('timeout')).toBe('retryable');
    expect(classifyRetryable('rate_limit')).toBe('retryable');
    expect(classifyRetryable('server_5xx')).toBe('retryable');
    expect(classifyRetryable('stream_truncated')).toBe('retryable');
    expect(classifyRetryable('429')).toBe('retryable');
    expect(classifyRetryable('503')).toBe('retryable');
  });

  it('不可恢复：401/403/参数/quota/用户取消/拒绝/内容过滤不重试', () => {
    expect(classifyRetryable('401')).toBe('non_retryable');
    expect(classifyRetryable('403')).toBe('non_retryable');
    expect(classifyRetryable('invalid_request')).toBe('non_retryable');
    expect(classifyRetryable('quota')).toBe('non_retryable');
    expect(classifyRetryable('user_cancelled')).toBe('non_retryable');
    expect(classifyRetryable('refusal')).toBe('non_retryable');
    expect(classifyRetryable('content_filter')).toBe('non_retryable');
  });

  it('未知码 → unknown（不猜、不默认重试）', () => {
    expect(classifyRetryable('unknown-code')).toBe('unknown');
    expect(classifyRetryable('')).toBe('unknown');
  });
});

describe('协议 fixtures 自洽校验（S0 fixtures 供 S1-S7 复用）', () => {
  it('合法帧样例通过对应校验', () => {
    expect(isSubmitIntent(validFixtures.submitQueued.intent)).toBe(true);
    expect(isSubmitIntent(validFixtures.submitSteer.intent)).toBe(true);
    expect(validFixtures.submitAckAccepted.state).toBe('accepted');
    expect(validFixtures.submitAckUnknown.state).toBe('unknown');
    expect(validFixtures.submitAckUnknown.state).not.toBe('rejected'); // unknown ≠ rejected
    expect(isValidChunkOffset(validFixtures.resumeSnapshot.activeAttempt!.textChunkOffset)).toBe(true);
    expect(isValidEpoch(validFixtures.resumeSnapshot.epoch)).toBe(true);
    expect(isValidLastSeq(validFixtures.resumeSnapshot.replay.fromSeq)).toBe(true);
    expect(isApprovalDecision(validFixtures.approvalResponse.decision)).toBe(true);
    expect(isApprovalExpired(validFixtures.approvalRequest.expiresAt)).toBe(false);
    expect(scopeConfinesToSession(validFixtures.approvalRequest.scope, validFixtures.approvalRequest.sessionId)).toBe(true);
    expect(isCancelTargetKind(validFixtures.cancelTurn.target.kind)).toBe(true);
    expect(isCancelAckState(validFixtures.cancelAckStopping.state)).toBe(true);
    expect(isCancelAckState(validFixtures.cancelAckCancelled.state)).toBe(true);
    expect(isTerminalTaskState('completed')).toBe(true);
    expect(canTaskTransition(validFixtures.taskContract.state, 'completed')).toBe(true);
    expect(isValidSteerRequest(validFixtures.steerRequest)).toBe(true);
    expect(validFixtures.steerStaleResult.state).toBe('stale');
    expect(validFixtures.steerStaleResult.draftKept).toBe(true);
    expect(assertSequentialChunk({ chunkOffset: validFixtures.textDelta.chunkOffset, text: validFixtures.textDelta.text }, 6)).toBe(true);
    expect(isValidChunkOffset(validFixtures.reasoningDelta.chunkOffset)).toBe(true);
    expect(validFixtures.attemptFinal.state).toBe('completed');
  });

  it('非法/边界帧样例被相应校验拒绝', () => {
    expect(isSubmitIntent(invalidFixtures.badIntent.intent)).toBe(false);
    expect(isValidChunkOffset(invalidFixtures.badChunkOffset.chunkOffset)).toBe(false);
    expect(isValidLastSeq(invalidFixtures.badLastSeq.lastSeq)).toBe(false);
    expect(isValidEpoch(invalidFixtures.badEpoch.epoch)).toBe(false);
    expect(isApprovalExpired(invalidFixtures.expiredApproval.expiresAt)).toBe(true);
    expect(scopeConfinesToSession(invalidFixtures.crossSessionScope.scope, invalidFixtures.crossSessionScope.sessionId)).toBe(false);
    expect(canTaskTransition(invalidFixtures.terminalRegression.from, invalidFixtures.terminalRegression.to)).toBe(false);
    expect(isValidSteerRequest(invalidFixtures.unboundSteer)).toBe(false);
  });
});