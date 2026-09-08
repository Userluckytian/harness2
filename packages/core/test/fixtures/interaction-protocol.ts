// 协议 fixtures：共享交互契约（S0 冻结，对齐 I1 §6）的合法/非法帧样例。
// 供 S1-S7 的 executor/approval/delivery/resume/steer 等测试复用；
// 仅类型数据，不做文件 I/O。合法帧语义对齐 src/interaction/types.ts。
import type {
  ApprovalRequestContract,
  ApprovalResponse,
  ApprovalResponseAck,
  AttemptFinalFrame,
  CancelAck,
  CancelRequest,
  DeliveryDeltaFrame,
  QueueEntry,
  ResumeSnapshot,
  SteerRequest,
  SteerResult,
  SubmitAck,
  SubmitRequest,
  TaskContract,
} from '../../src/interaction/types.js';

/** 合法帧样例（按契约场景组织） */
export const validFixtures = {
  /** submit：排队意图，带文件/剪贴板引用 */
  submitQueued: {
    clientMessageId: 'cm-001',
    sessionId: '20260908-090000-abc123',
    rawText: '帮我看看 README 并给改进建议',
    references: [
      { id: 'ref-1', kind: 'file', path: 'D:\\Projects\\demo\\README.md' },
      { id: 'ref-2', kind: 'clipboard', text: '第 3 行附近有个错别字' },
    ],
    intent: 'queue',
  } satisfies SubmitRequest,
  /** submit：steer 意图，必须绑定 expectedTurnId */
  submitSteer: {
    clientMessageId: 'cm-002',
    sessionId: '20260908-090000-abc123',
    rawText: '先别改文件，把方案讲清楚',
    intent: 'steer',
    expectedTurnId: 'turn-7',
  } satisfies SubmitRequest,
  /** submit ack：accepted（明确结论） */
  submitAckAccepted: {
    clientMessageId: 'cm-001',
    sessionId: '20260908-090000-abc123',
    state: 'accepted',
    queueSeq: 1,
  } satisfies SubmitAck,
  /** submit ack：超时/崩溃窗口 → unknown（≠rejected，调用方不得当拒绝处理） */
  submitAckUnknown: {
    clientMessageId: 'cm-003',
    sessionId: '20260908-090000-abc123',
    state: 'unknown',
  } satisfies SubmitAck,
  /** 未启动 queue 项（重启恢复默认 paused，不惊喜执行） */
  queueEntry: {
    id: 'cm-001',
    revision: 2,
    rawText: '帮我看看 README 并给改进建议',
    intent: 'queue',
    state: 'paused',
  } satisfies QueueEntry,
  /** resumeSubscription 快照：带水位 replay + 在途 attempt 快照 + tasks + approvals + queue */
  resumeSnapshot: {
    epoch: 3,
    replay: { fromSeq: 4, toSeq: 17 },
    activeAttempt: {
      attemptId: 'att-2',
      turnId: 'turn-7',
      textChunkOffset: 120,
      reasoningChunkOffset: 64,
      status: 'running',
    },
    tasks: [
      {
        taskId: 'task-1',
        parentTaskId: undefined,
        background: true,
        state: 'running',
        expectedTurnId: 'turn-8',
        updatedAt: '2026-09-08T01:00:00.000Z',
      },
    ],
    pendingApprovals: [],
    queue: [
      {
        id: 'cm-001',
        revision: 2,
        rawText: '帮我看看 README 并给改进建议',
        intent: 'queue',
        state: 'paused',
      },
    ],
  } satisfies ResumeSnapshot,
  /** approval：session 作用域（「本会话总是」绑定本 sessionId，不得跨会话泄漏） */
  approvalRequest: {
    requestId: 'apr-11',
    sessionId: '20260908-090000-abc123',
    parentTaskId: 'task-1',
    taskId: 'task-2',
    tool: 'write',
    args: { path: 'README.md', content: '...' },
    cwd: 'D:\\Projects\\demo',
    scope: { mode: 'session', sessionId: '20260908-090000-abc123' },
    expiresAt: '2026-09-08T01:05:00.000Z',
  } satisfies ApprovalRequestContract,
  approvalResponse: { requestId: 'apr-11', decision: 'allow' } satisfies ApprovalResponse,
  /** respond 的 decision ack：明确三态之外还有 unknown */
  approvalResponseAck: { requestId: 'apr-11', state: 'applied' } satisfies ApprovalResponseAck,
  /** cancel：停父 turn（带 expectedId 并发防护） */
  cancelTurn: {
    requestId: 'cnl-1',
    target: { kind: 'turn', id: 'turn-7' },
    expectedId: 'turn-7',
  } satisfies CancelRequest,
  cancelAckStopping: { requestId: 'cnl-1', state: 'stopping' } satisfies CancelAck,
  cancelAckCancelled: { requestId: 'cnl-1', state: 'cancelled' } satisfies CancelAck,
  /** task：waiting-approval 中间态 */
  taskContract: {
    taskId: 'task-2',
    parentTaskId: 'task-1',
    background: true,
    state: 'waiting-approval',
    expectedTurnId: 'turn-8',
  } satisfies TaskContract,
  /** steer：合法请求 + stale 结果（保 draft，不偷偷 abort/resend） */
  steerRequest: {
    id: 'st-1',
    expectedTurnId: 'turn-7',
    text: '先别改文件',
  } satisfies SteerRequest,
  steerStaleResult: {
    id: 'st-1',
    expectedTurnId: 'turn-7',
    state: 'stale',
    draftKept: true,
  } satisfies SteerResult,
  /** text delta：完整归属 + chunkOffset 水位（0 起始，续块 = 上一块 offset + 长度） */
  textDelta: {
    type: 'text-delta',
    sessionId: '20260908-090000-abc123',
    turnId: 'turn-7',
    attemptId: 'att-2',
    chunkOffset: 0,
    text: '方案分三步：',
  } satisfies DeliveryDeltaFrame,
  reasoningDelta: {
    type: 'reasoning-delta',
    sessionId: '20260908-090000-abc123',
    turnId: 'turn-7',
    attemptId: 'att-2',
    chunkOffset: 5,
    text: '推理片段',
  } satisfies DeliveryDeltaFrame,
  /** attempt 终态：带 turnId/attemptId（禁止取「日志最后 turn」猜归属） */
  attemptFinal: {
    type: 'attempt-final',
    sessionId: '20260908-090000-abc123',
    turnId: 'turn-7',
    attemptId: 'att-2',
    state: 'completed',
    finalText: '方案分三步：…',
  } satisfies AttemptFinalFrame,
} as const;

/** 非法/边界帧样例（校验应拒绝；供负向用例复用） */
export const invalidFixtures = {
  /** intent 非法值（猜释义会被拒） */
  badIntent: { clientMessageId: 'cm-x', sessionId: 's', rawText: 'x', intent: 'chat' },
  /** 负 chunkOffset（水位跨界） */
  badChunkOffset: {
    type: 'text-delta',
    sessionId: 's',
    turnId: 't',
    attemptId: 'a',
    chunkOffset: -1,
    text: 'x',
  },
  /** 非整数 lastSeq */
  badLastSeq: { sessionId: 's', lastSeq: 1.5, epoch: 0 },
  /** 非法 epoch */
  badEpoch: { sessionId: 's', lastSeq: 0, epoch: NaN },
  /** 已过期审批（expiresAt 在过去） */
  expiredApproval: {
    requestId: 'apr-x',
    sessionId: 's',
    tool: 'write',
    args: {},
    scope: { mode: 'once' },
    expiresAt: '2000-01-01T00:00:00.000Z',
  } satisfies ApprovalRequestContract,
  /** 「本会话总是」试图框到别的 sessionId（跨会话泄漏原语） */
  crossSessionScope: {
    requestId: 'apr-y',
    sessionId: 's',
    tool: 'write',
    args: {},
    scope: { mode: 'session', sessionId: 'ANOTHER-SESSION' },
    expiresAt: '2099-01-01T00:00:00.000Z',
  } satisfies ApprovalRequestContract,
  /** 终态再迁移（completed → running）：终态单调被破坏 */
  terminalRegression: { from: 'completed', to: 'running' },
  /** 缺 expectedTurnId 的 steer */
  unboundSteer: { id: 'st-x', expectedTurnId: '', text: 'x' },
} as const;