// H-66～H-68 统一 flow 生命周期（阶段 7）：请求 → 呈现 → 应答 → 审计。
// 四类 flow（审批 / 澄清 / sudo / secret）共用同一状态机与 ack 语义，三壳只负责渲染
// `FlowPresentation` 与回投 `FlowResponse`。
//
// 不变量：
//   - 终态单调：answered/denied/expired/cancelled 之后不再迁移；迟到应答回 duplicate/expired；
//   - 种类不可串：应答 kind 与请求 kind 不一致 → invalid（不落定卡片）；
//   - 过期即拒绝（fail-closed）：过期应答不回放行，落 expired；
//   - 机密剥离：FlowRecord / 审计只保留归一后的公开 decision/detail（sudo 口令、secret 值不进记录）；
//   - 同一待处理请求可去重（同 kind + 同会话 + 同目标 → 复用既有 flowId）。
import { randomUUID } from 'node:crypto';
import { redactSecrets, redactedSummary } from '../config/redact.js';
import type { FlowAuditSink } from './audit.js';
import { applyApprovalDecision, type ApprovalGrantStore } from './approval-flow.js';
import { summarizeClarifyAnswers } from './clarify.js';
import {
  canFlowTransition,
  defaultFlowTitle,
  flowResponseMatchesKind,
  isApprovalFlowDecision,
  isFlowTerminalState,
  type ApprovalFlowRequest,
  type ApprovalFlowResponse,
  type ClarifyFlowRequest,
  type ClarifyFlowResponse,
  type FlowAck,
  type FlowId,
  type FlowPresentation,
  type FlowRequest,
  type FlowResponse,
  type FlowState,
  type PrivilegeOutcome,
  type PrivilegeSink,
  type SecretFlowRequest,
  type SecretFlowResponse,
  type SudoFlowRequest,
  type SudoFlowResponse,
} from './types.js';

/** 请求 spec：flowId/createdAt 由 manager 补 */
export type FlowRequestSpec =
  | Omit<ApprovalFlowRequest, 'flowId' | 'createdAt'>
  | Omit<ClarifyFlowRequest, 'flowId' | 'createdAt'>
  | Omit<SudoFlowRequest, 'flowId' | 'createdAt'>
  | Omit<SecretFlowRequest, 'flowId' | 'createdAt'>;

/** 呈现回调：壳在此把 FlowPresentation 渲染成自己的 UI（core 不关心形态） */
export type FlowPresenter = (presentation: FlowPresentation) => void;

export interface FlowManagerOptions {
  now?: () => Date;
  /** 审计出口（FlowAuditLog / MemoryFlowAuditSink / 宿主自定义） */
  audit?: FlowAuditSink;
  /** 呈现出口（三壳各自渲染） */
  presenter?: FlowPresenter;
  /** 默认过期毫秒（缺省 = 不过期，由壳与用户决定等待策略） */
  defaultTimeoutMs?: number;
  /** sudo/secret 处理器（approval/privileged.ts 的 PrivilegeBroker） */
  privilege?: PrivilegeSink;
  /** H-66 审批授权缓存（allow_session / allow_always） */
  grants?: ApprovalGrantStore;
  /** flowId 生成（测试可注入确定性 id） */
  idFactory?: () => string;
}

/** 已归一、可公开的 flow 记录（不含任何机密值） */
export interface FlowRecord {
  request: FlowRequest;
  state: FlowState;
  /** 归一决策名（approval: allow_once/…；clarify: answered；sudo: submitted；secret: stored） */
  decision?: string;
  reason?: string;
  detail?: Record<string, string | number | boolean>;
  settledAt?: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function dedupeKey(spec: FlowRequestSpec): string {
  const session = spec.sessionId ?? '';
  switch (spec.kind) {
    case 'approval':
      return `approval:${session}:${spec.tool}:${stableStringify(spec.args)}`;
    case 'clarify':
      return `clarify:${session}:${spec.questions.map((q) => q.prompt).join('|')}`;
    case 'sudo':
      return `sudo:${session}:${spec.command ?? spec.reason}`;
    case 'secret':
      return `secret:${session}:${spec.name}`;
    default: {
      const never: never = spec;
      return String(never);
    }
  }
}

function requestSummary(request: FlowRequest): string {
  switch (request.kind) {
    case 'approval':
      return redactedSummary(`工具 ${request.tool}`, 200);
    case 'clarify':
      return redactedSummary(`${request.questions.length} 个问题`, 200);
    case 'sudo':
      return redactedSummary(`提权：${request.reason}`, 200);
    case 'secret':
      return redactedSummary(`机密：${request.name}`, 200);
    default: {
      const never: never = request;
      return String(never);
    }
  }
}

function requestPrompt(request: FlowRequest): string {
  switch (request.kind) {
    case 'approval':
      return `允许工具「${request.tool}」执行该操作？`;
    case 'clarify':
      return request.questions.map((q) => q.prompt).join('\n');
    case 'sudo':
      return redactedSummary(request.reason, 300);
    case 'secret':
      return redactedSummary(request.prompt, 300);
    default: {
      const never: never = request;
      return String(never);
    }
  }
}

/**
 * 统一 flow 管理器。单写者（进程内），状态在内存；持久痕跡走注入的 FlowAuditSink。
 */
export class FlowManager {
  private readonly now: () => Date;
  private readonly audit: FlowAuditSink | undefined;
  private readonly presenter: FlowPresenter | undefined;
  private readonly defaultTimeoutMs: number | undefined;
  private readonly privilege: PrivilegeSink | undefined;
  private readonly grants: ApprovalGrantStore | undefined;
  private readonly idFactory: () => string;
  private readonly records = new Map<FlowId, FlowRecord>();

  constructor(options: FlowManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.audit = options.audit;
    this.presenter = options.presenter;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.privilege = options.privilege;
    this.grants = options.grants;
    this.idFactory = options.idFactory ?? (() => `flow-${randomUUID()}`);
  }

  // —— 请求 ——

  /**
   * 登记一条 flow 请求（pending）。同 kind + 同会话 + 同目标的**未终态**请求复用既有 flowId
   * （重复请求去重，审计记 deduped）。
   */
  request(spec: FlowRequestSpec): FlowRequest {
    const key = dedupeKey(spec);
    for (const record of this.records.values()) {
      if (!isFlowTerminalState(record.state) && dedupeKey(record.request) === key) {
        this.audit?.record({
          kind: 'flow/request',
          flowId: record.request.flowId,
          flowKind: record.request.kind,
          ...(record.request.sessionId !== undefined ? { sessionId: record.request.sessionId } : {}),
          summary: requestSummary(record.request),
          deduped: true,
        });
        return record.request;
      }
    }
    const createdAt = this.now().toISOString();
    const expiresAt =
      spec.expiresAt ??
      (this.defaultTimeoutMs !== undefined
        ? new Date(this.now().getTime() + this.defaultTimeoutMs).toISOString()
        : undefined);
    const request = {
      ...spec,
      flowId: this.idFactory(),
      createdAt,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    } as FlowRequest;
    this.records.set(request.flowId, { request, state: 'pending' });
    this.audit?.record({
      kind: 'flow/request',
      flowId: request.flowId,
      flowKind: request.kind,
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      summary: requestSummary(request),
    });
    return request;
  }

  // —— 呈现 ——

  /** 下发呈现（pending → presented）；壳在此渲染。已呈现 → duplicate；终态 → duplicate/expired */
  present(flowId: FlowId): FlowAck {
    const record = this.records.get(flowId);
    if (record === undefined) return { flowId, state: 'unknown', reason: '未登记的 flow' };
    if (record.state === 'presented') return { flowId, state: 'duplicate' };
    if (isFlowTerminalState(record.state)) {
      return { flowId, state: record.state === 'expired' ? 'expired' : 'duplicate' };
    }
    const presentation = this.presentation(flowId);
    if (presentation === undefined) return { flowId, state: 'unknown' };
    this.transition(record, 'presented');
    this.audit?.record({
      kind: 'flow/presented',
      flowId,
      flowKind: record.request.kind,
      title: presentation.title,
    });
    try {
      this.presenter?.(presentation);
    } catch {
      // 呈现回调异常不回写内核（壳自担渲染失败）
    }
    return { flowId, state: 'applied' };
  }

  /** 生成呈现数据（纯数据；机密只带字段名，永不带值） */
  presentation(flowId: FlowId): FlowPresentation | undefined {
    const record = this.records.get(flowId);
    if (record === undefined) return undefined;
    const request = record.request;
    const base = {
      flowId,
      kind: request.kind,
      title: defaultFlowTitle(request.kind),
      prompt: requestPrompt(request),
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
    };
    switch (request.kind) {
      case 'approval':
        return {
          ...base,
          approval: {
            tool: request.tool,
            argsSummary: redactedSummary(stableStringify(request.args), 200),
            ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
            scopes: request.scopes,
            deniable: true,
          },
        };
      case 'clarify':
        return {
          ...base,
          clarify: {
            questions: request.questions.map((q) => ({
              qid: q.qid,
              prompt: q.prompt,
              ...(q.choices !== undefined ? { choices: q.choices } : {}),
              multiSelect: q.multiSelect === true,
              allowOther: request.allowOther !== false,
              ...(q.recommendedIndex !== undefined ? { recommendedIndex: q.recommendedIndex } : {}),
            })),
          },
        };
      case 'sudo':
        return {
          ...base,
          sudoInput: {
            reason: redactedSummary(request.reason, 300),
            ...(request.command !== undefined ? { command: redactedSummary(request.command, 200) } : {}),
            echo: false,
          },
        };
      case 'secret':
        return { ...base, secretInput: { name: request.name, echo: false } };
      default: {
        const never: never = request;
        return never;
      }
    }
  }

  // —— 应答 ——

  /**
   * 应答落定。ack 语义：
   *   applied（首次有效落定）/ duplicate（已落定再答）/ expired / unknown（未登记）/ invalid（种类不符等）。
   * 过期应答 fail-closed：落 expired，绝不放行。
   */
  respond(flowId: FlowId, response: FlowResponse): FlowAck {
    const record = this.records.get(flowId);
    if (record === undefined) return { flowId, state: 'unknown', reason: '未登记的 flow' };
    if (isFlowTerminalState(record.state)) {
      return { flowId, state: record.state === 'expired' ? 'expired' : 'duplicate' };
    }
    if (!flowResponseMatchesKind(record.request.kind, response)) {
      return { flowId, state: 'invalid', reason: `应答种类 ${response.kind} 与请求种类 ${record.request.kind} 不一致` };
    }
    if (this.isExpired(record)) {
      this.settle(record, 'expired');
      this.auditSettle(record, 'expired');
      return { flowId, state: 'expired', reason: '请求已过期' };
    }
    return this.applyResponse(record, response);
  }

  /** 取消（pending/presented → cancelled） */
  cancel(flowId: FlowId, reason?: string): FlowAck {
    const record = this.records.get(flowId);
    if (record === undefined) return { flowId, state: 'unknown' };
    if (isFlowTerminalState(record.state)) {
      return { flowId, state: record.state === 'expired' ? 'expired' : 'duplicate' };
    }
    this.settle(record, 'cancelled', reason);
    this.audit?.record({
      kind: 'flow/cancelled',
      flowId,
      flowKind: record.request.kind,
    });
    return { flowId, state: 'applied' };
  }

  /** 过期扫描：把所有到期的未终态请求落 expired（壳/宿主定时调用） */
  expireDue(now: Date = this.now()): FlowAck[] {
    const out: FlowAck[] = [];
    for (const record of this.records.values()) {
      if (isFlowTerminalState(record.state)) continue;
      if (!this.isExpired(record, now)) continue;
      this.settle(record, 'expired');
      this.auditSettle(record, 'expired');
      out.push({ flowId: record.request.flowId, state: 'expired' });
    }
    return out;
  }

  // —— 查询 ——

  get(flowId: FlowId): FlowRecord | undefined {
    const record = this.records.get(flowId);
    return record === undefined ? undefined : { ...record, request: record.request };
  }

  /** 未终态请求（诊断/重连下发） */
  pending(): FlowRequest[] {
    return [...this.records.values()].filter((r) => !isFlowTerminalState(r.state)).map((r) => r.request);
  }

  all(): FlowRecord[] {
    return [...this.records.values()].map((r) => ({ ...r, request: r.request }));
  }

  // —— 内部 ——

  private isExpired(record: FlowRecord, now: Date = this.now()): boolean {
    const expiresAt = record.request.expiresAt;
    if (expiresAt === undefined) return false;
    const t = Date.parse(expiresAt);
    return Number.isNaN(t) ? true : t <= now.getTime();
  }

  private transition(record: FlowRecord, to: FlowState): void {
    if (!canFlowTransition(record.state, to)) {
      throw new Error(`非法 flow 迁移：${record.state} → ${to}`);
    }
    record.state = to;
  }

  private settle(record: FlowRecord, state: FlowState, reason?: string): void {
    this.transition(record, state);
    record.settledAt = this.now().toISOString();
    if (reason !== undefined) record.reason = redactSecrets(reason);
  }

  private auditSettle(record: FlowRecord, state: FlowState): void {
    const flowId = record.request.flowId;
    if (state === 'expired') {
      this.audit?.record({
        kind: 'flow/expired',
        flowId,
        flowKind: record.request.kind,
      });
    }
  }

  private auditResponse(record: FlowRecord): void {
    this.audit?.record({
      kind: 'flow/response',
      flowId: record.request.flowId,
      flowKind: record.request.kind,
      decision: record.decision ?? 'unknown',
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
      ...(record.detail !== undefined ? { detail: record.detail } : {}),
    });
  }

  private applyResponse(record: FlowRecord, response: FlowResponse): FlowAck {
    const flowId = record.request.flowId;
    switch (record.request.kind) {
      case 'approval': {
        const res = response as ApprovalFlowResponse;
        if (!isApprovalFlowDecision(res.decision)) {
          return { flowId, state: 'invalid', reason: `未知审批决策：${String(res.decision)}` };
        }
        if (res.decision === 'allow_session' && record.request.sessionId === undefined) {
          return { flowId, state: 'invalid', reason: '缺少 sessionId，无法授予会话级授权' };
        }
        const granted =
          this.grants !== undefined && !(res.decision === 'allow_session' && record.request.sessionId === undefined)
            ? applyApprovalDecision(this.grants, res.decision, {
                sessionId: record.request.sessionId ?? '',
                tool: record.request.tool,
              })
            : { scope: null, granted: false };
        record.decision = res.decision;
        if (res.reason !== undefined) record.reason = redactSecrets(res.reason);
        this.settle(record, res.decision === 'deny' ? 'denied' : 'answered');
        this.auditResponse(record);
        if (granted.granted && granted.scope !== null) {
          this.audit?.record({
            kind: 'flow/grant',
            flowId,
            grantId: `approval-${flowId}`,
            scope: granted.scope,
            pattern: record.request.tool,
          });
        }
        return {
          flowId,
          state: 'applied',
          ...(granted.granted && granted.scope !== null ? { detail: { scope: granted.scope } } : {}),
        };
      }
      case 'clarify': {
        const res = response as ClarifyFlowResponse;
        if (res.cancelled === true) {
          record.decision = 'cancelled';
          this.settle(record, 'cancelled');
          this.auditResponse(record);
          return { flowId, state: 'applied', detail: { cancelled: true } };
        }
        const summary = summarizeClarifyAnswers(res.answers);
        record.decision = 'answered';
        record.detail = summary;
        this.settle(record, 'answered');
        this.auditResponse(record);
        return { flowId, state: 'applied', detail: summary };
      }
      case 'sudo': {
        const res = response as SudoFlowResponse;
        const outcome = this.privilege?.handleSudo?.(record.request, res) ?? {
          decision: 'denied',
          reason: '未配置特权处理器（PrivilegeSink）',
        };
        return this.settlePrivilege(record, outcome, res.cancelled === true);
      }
      case 'secret': {
        const res = response as SecretFlowResponse;
        const outcome = this.privilege?.handleSecret?.(record.request, res) ?? {
          decision: 'denied',
          reason: '未配置特权处理器（PrivilegeSink）',
        };
        return this.settlePrivilege(record, outcome, false);
      }
      default: {
        const never: never = record.request;
        return { flowId, state: 'invalid', reason: `未知请求种类：${String(never)}` };
      }
    }
  }

  private settlePrivilege(record: FlowRecord, outcome: PrivilegeOutcome, cancelled: boolean): FlowAck {
    const flowId = record.request.flowId;
    record.decision = outcome.decision;
    if (outcome.reason !== undefined) record.reason = redactSecrets(outcome.reason);
    if (outcome.detail !== undefined) record.detail = outcome.detail;
    const state: FlowState =
      cancelled || outcome.decision === 'cancelled'
        ? 'cancelled'
        : outcome.decision === 'denied'
          ? 'denied'
          : 'answered';
    this.settle(record, state);
    this.auditResponse(record);
    return {
      flowId,
      state: 'applied',
      ...(outcome.reason !== undefined ? { reason: redactSecrets(outcome.reason) } : {}),
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
    };
  }
}
