// H-44 / H-68 特权请求流（阶段 7）：sudo.request 与 secret.request。
//   链路：请求（登记待批）→ 审批（用户应答）→ 一次性授权 → 审计留痕。
//
// 机密红线（本模块的核心不变量）：
//   1) `secret.value` / `sudo.password` **绝不**被本模块保存、返回、写日志或写审计；
//   2) secret 值只经注入的 `SecretVault.store(name, value)` 一次落地，出口仅返回 `storedAs` 引用；
//   3) sudo 口令只经注入的 `SudoCredentialSink.use(password, ctx)` 交给执行层（扩展点，本阶段不实现执行），
//      随后立即丢弃；本模块只保留**一次性授权票据**（SudoGrant），供执行层消费；
//   4) 所有错误/原因字符串出口过 redactSecrets。
//
// 与平台能力（DM 配对、容器隔离）的关系：属 H-47 未拍板范围，本模块**只留注入缝**
// （SecretVault / SudoCredentialSink / 审计 sink），不做任何平台实现。
import { randomUUID } from 'node:crypto';
import { redactSecrets } from '../config/redact.js';
import type { FlowAuditSink } from '../flows/audit.js';
import type {
  PrivilegeOutcome,
  PrivilegeSink,
  SecretFlowRequest,
  SecretFlowResponse,
  SudoFlowRequest,
  SudoFlowResponse,
} from '../flows/types.js';

/** sudo 一次性授权默认 TTL（hermes sudo.request 超时 120s 同口径） */
export const SUDO_GRANT_DEFAULT_TTL_MS = 120_000;
/** 特权请求默认过期（登记后未应答即作废） */
export const PRIVILEGE_REQUEST_DEFAULT_TTL_MS = 300_000;

/** sudo 一次性授权票据（不含口令本身） */
export interface SudoGrant {
  grantId: string;
  /** 来源 flow */
  flowId: string;
  sessionId?: string;
  command?: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}

export type SudoConsumeFailure = 'unknown' | 'expired' | 'consumed' | 'session-mismatch' | 'command-mismatch';

export type SudoConsumeResult = { ok: true; grant: SudoGrant } | { ok: false; reason: SudoConsumeFailure };

/** 机密存储缝（由宿主机提供，如写 auth.json/env 安全存储；core 不实现具体落点） */
export interface SecretVault {
  /** 存储机密；返回值只含引用（绝不回显明文） */
  store(name: string, value: string): { ok: boolean; storedAs?: string; error?: string };
}

/** sudo 口令消费缝（**扩展点**：执行层/tools 侧接线，本阶段不实现执行） */
export interface SudoCredentialSink {
  use(password: string, context: { grantId: string; command?: string }): { ok: boolean; error?: string };
}

export interface PrivilegeBrokerOptions {
  now?: () => Date;
  audit?: FlowAuditSink;
  vault?: SecretVault;
  credentialSink?: SudoCredentialSink;
  /** sudo 授权 TTL 毫秒（缺省 SUDO_GRANT_DEFAULT_TTL_MS） */
  grantTtlMs?: number;
}

/** 注册一条待处理特权流（由 FlowManager 建请求前的 spec 助手） */
export interface SudoRequestInput {
  sessionId?: string;
  reason: string;
  command?: string;
  expiresAt?: string;
}

export interface SecretRequestInput {
  sessionId?: string;
  name: string;
  prompt: string;
  metadata?: Record<string, string>;
  expiresAt?: string;
}

/** 组装 sudo 请求 spec（flowId/createdAt 由 FlowManager 补） */
export function sudoRequestSpec(
  input: SudoRequestInput,
  now: Date = new Date(),
): Omit<SudoFlowRequest, 'flowId' | 'createdAt'> & { expiresAt: string } {
  return {
    kind: 'sudo',
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    reason: input.reason,
    ...(input.command !== undefined ? { command: redactSecrets(input.command) } : {}),
    expiresAt: input.expiresAt ?? new Date(now.getTime() + PRIVILEGE_REQUEST_DEFAULT_TTL_MS).toISOString(),
  };
}

/** 组装 secret 请求 spec（flowId/createdAt 由 FlowManager 补；name/prompt 非机密） */
export function secretRequestSpec(
  input: SecretRequestInput,
  now: Date = new Date(),
): Omit<SecretFlowRequest, 'flowId' | 'createdAt'> & { expiresAt: string } {
  return {
    kind: 'secret',
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    name: input.name,
    prompt: input.prompt,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    expiresAt: input.expiresAt ?? new Date(now.getTime() + PRIVILEGE_REQUEST_DEFAULT_TTL_MS).toISOString(),
  };
}

/**
 * 特权流处理器 + 一次性授权账本。
 * 实现 `PrivilegeSink`，直接挂到 FlowManager 的 `privilege` 选项上。
 */
export class PrivilegeBroker implements PrivilegeSink {
  private readonly now: () => Date;
  private readonly audit: FlowAuditSink | undefined;
  private readonly vault: SecretVault | undefined;
  private readonly credentialSink: SudoCredentialSink | undefined;
  private readonly grantTtlMs: number;
  private readonly grants = new Map<string, SudoGrant>();

  constructor(options: PrivilegeBrokerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.audit = options.audit;
    this.vault = options.vault;
    this.credentialSink = options.credentialSink;
    this.grantTtlMs = options.grantTtlMs ?? SUDO_GRANT_DEFAULT_TTL_MS;
  }

  // —— sudo ——

  /**
   * 处理 sudo 应答：口令非空 → 签发一次性授权票据（+可选的执行层消费接线）；取消/空口令 → 不签发。
   * 口令在本方法内使用后即丢弃，**不进入任何返回值/审计**。
   */
  handleSudo(request: SudoFlowRequest, response: SudoFlowResponse): PrivilegeOutcome {
    if (response.cancelled === true) return { decision: 'cancelled' };
    const password = response.password;
    if (typeof password !== 'string' || password.length === 0) {
      return { decision: 'skipped', reason: '未提供口令' };
    }
    const issuedAt = this.now();
    const grant: SudoGrant = {
      grantId: `sudo-${randomUUID()}`,
      flowId: request.flowId,
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      ...(request.command !== undefined ? { command: request.command } : {}),
      createdAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + this.grantTtlMs).toISOString(),
    };
    if (this.credentialSink !== undefined) {
      let used: { ok: boolean; error?: string };
      try {
        used = this.credentialSink.use(password, {
          grantId: grant.grantId,
          ...(grant.command !== undefined ? { command: grant.command } : {}),
        });
      } catch (e) {
        // P2-3：sink 抛错时错误消息**可能夹带口令**——必须同 vault 一样收口并过 redactSecrets，
        // 不能让异常原样逃出 handleSudo（调用方/日志里会出现明文）。
        used = { ok: false, error: (e as Error)?.message ?? String(e) };
      }
      if (!used.ok) {
        return { decision: 'denied', reason: redactSecrets(used.error ?? '执行层拒绝使用该口令') };
      }
    }
    this.grants.set(grant.grantId, grant);
    this.audit?.record({
      kind: 'flow/grant',
      flowId: request.flowId,
      grantId: grant.grantId,
      scope: 'once',
      ...(grant.command !== undefined ? { pattern: grant.command } : {}),
    });
    return {
      decision: 'submitted',
      granted: true,
      detail: { grantId: grant.grantId, expiresAt: grant.expiresAt, sink: this.credentialSink !== undefined },
    };
  }

  /**
   * 消费一次性授权：必须未用过、未过期、且 session/命令匹配。
   * 命令侧 fail-closed（P2-3）：票据带 command → 消费必须带**同一条**命令；不带命令消费 →
   * command-mismatch（与 session 侧对称，不给「省略即放行」的口子）。
   * 消费失败明确区分 unknown / consumed / expired / session-mismatch / command-mismatch。
   */
  consumeSudo(grantId: string, context: { sessionId?: string; command?: string } = {}): SudoConsumeResult {
    const grant = this.grants.get(grantId);
    if (grant === undefined) return { ok: false, reason: 'unknown' };
    if (grant.usedAt !== undefined) return { ok: false, reason: 'consumed' };
    if (Date.parse(grant.expiresAt) <= this.now().getTime()) {
      this.grants.delete(grantId);
      this.audit?.record({
        kind: 'flow/consume',
        grantId,
        flowId: grant.flowId,
        ok: false,
        reason: 'expired',
      });
      return { ok: false, reason: 'expired' };
    }
    if (grant.sessionId !== undefined && context.sessionId !== grant.sessionId) {
      return { ok: false, reason: 'session-mismatch' };
    }
    // P2-3：命令侧与 session 侧**对称** fail-closed——票据带 command 时，消费方必须带同样的命令，
    // 不带（context.command === undefined）同样拒绝（此前的 `context.command !== undefined` 条件
    // 会让「有命令的票据被无命令消费」fail-open，绕过绑定）。
    if (grant.command !== undefined && context.command !== grant.command) {
      return { ok: false, reason: 'command-mismatch' };
    }
    grant.usedAt = this.now().toISOString();
    this.audit?.record({
      kind: 'flow/consume',
      grantId,
      flowId: grant.flowId,
      ok: true,
    });
    return { ok: true, grant: { ...grant } };
  }

  /** 只读：某 flow 当前有效的授权（测试/诊断） */
  grantForFlow(flowId: string): SudoGrant | undefined {
    for (const grant of this.grants.values()) {
      if (grant.flowId === flowId && grant.usedAt === undefined) return { ...grant };
    }
    return undefined;
  }

  /** 只读：当前票据数（测试/诊断） */
  get grantCount(): number {
    return this.grants.size;
  }

  // —— secret ——

  /**
   * 处理 secret 应答：值只交 vault 一次，返回 `storedAs` 引用；跳过/空值不算失败。
   * **返回值与审计中绝不出现明文**。
   */
  handleSecret(request: SecretFlowRequest, response: SecretFlowResponse): PrivilegeOutcome {
    if (response.skipped === true) return { decision: 'skipped' };
    const value = response.value;
    if (typeof value !== 'string' || value.length === 0) return { decision: 'skipped', reason: '未提供内容' };
    if (this.vault === undefined) {
      return { decision: 'denied', reason: '未配置机密存储（SecretVault）' };
    }
    let stored: { ok: boolean; storedAs?: string; error?: string };
    try {
      stored = this.vault.store(request.name, value);
    } catch (e) {
      stored = { ok: false, error: (e as Error)?.message ?? String(e) };
    }
    if (!stored.ok) {
      return { decision: 'denied', reason: redactSecrets(stored.error ?? '机密存储失败') };
    }
    const storedAs = redactSecrets(stored.storedAs ?? request.name);
    return { decision: 'stored', granted: true, detail: { storedAs } };
  }
}
