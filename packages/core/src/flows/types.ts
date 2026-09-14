// H-66～H-68 统一 flow 契约（阶段 7）：审批 / 澄清 / 特权（sudo·secret）四类请求共用
// 「请求 → 呈现（三壳各自渲染）→ 应答 → 审计」链路。本文件只放**纯类型 + 纯函数**
// （状态机、校验、展示形状），不做任何 I/O；生命周期与审计见 ./manager.ts、./audit.ts。
//
// 三壳共用原则：core 只出契约与状态机；每个壳把 FlowPresentation 渲染成自己的 UI
// （CLI 面板 / 桌面卡片 / web 弹层），把用户应答归一为 FlowResponse 回投。
//
// 机密红线：FlowRequest / FlowResponse 里只有 sudo.password、secret.value 两个机密字段；
// 二者**永不**进入 FlowRecord、审计、日志、呈现（presentation 只带字段名与提示语）。

/** flow 会话标识（避免与 interaction/types 的 SessionId 冲突，语义相同） */
export type FlowSessionId = string;
/** flow 请求标识 */
export type FlowId = string;

// —— 种类与状态机 ——

export const FLOW_KINDS = ['approval', 'clarify', 'sudo', 'secret'] as const;
export type FlowKind = (typeof FLOW_KINDS)[number];

export function isFlowKind(v: unknown): v is FlowKind {
  return typeof v === 'string' && (FLOW_KINDS as readonly string[]).includes(v);
}

/**
 * 生命周期状态（四类共用）：
 *   pending（已登记未呈现）→ presented（已下发壳）→ answered（已应答）/ denied（明确拒绝）
 *   终态：answered / denied；旁路终态：expired（超时）/ cancelled（取消/关闭）
 */
export const FLOW_STATES = ['pending', 'presented', 'answered', 'denied', 'expired', 'cancelled'] as const;
export type FlowState = (typeof FLOW_STATES)[number];

export const FLOW_TERMINAL_STATES: ReadonlySet<FlowState> = new Set(['answered', 'denied', 'expired', 'cancelled']);

export function isFlowTerminalState(s: unknown): s is FlowState {
  return typeof s === 'string' && FLOW_TERMINAL_STATES.has(s as FlowState);
}

const FLOW_TRANSITIONS: Record<FlowState, readonly FlowState[]> = {
  // pending 允许直接落定：无头/自动应答（如策略预判）不必先过「呈现」这一步
  pending: ['presented', 'answered', 'denied', 'expired', 'cancelled'],
  presented: ['answered', 'denied', 'expired', 'cancelled'],
  answered: [],
  denied: [],
  expired: [],
  cancelled: [],
};

/** 合法状态迁移：自转移/终态出边/非法状态一律 false */
export function canFlowTransition(from: FlowState, to: FlowState): boolean {
  if (from === to) return false;
  const allowed = FLOW_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

// —— 请求形状 ——

export interface FlowRequestBase {
  flowId: FlowId;
  /** 归属会话（缺省 = 进程级/宿主级请求）；跨会话授权必须框定在自身 sessionId 内 */
  sessionId?: FlowSessionId;
  createdAt: string;
  /** ISO8601 过期时间（缺省 = 不过期，由壳/宿主决定等待策略） */
  expiresAt?: string;
}

/** H-66 审批作用域：一次 / 本会话内永久 / 全局永久 */
export type FlowApprovalScopeMode = 'once' | 'session' | 'always';

export interface ApprovalFlowRequest extends FlowRequestBase {
  kind: 'approval';
  tool: string;
  /** 已脱敏参数（调用方负责剔除敏感值；呈现前再过 redactSecrets） */
  args: unknown;
  cwd?: string;
  /** 本次请求允许的作用域集合（壳据此决定展示哪些选项） */
  scopes: readonly FlowApprovalScopeMode[];
}

/** H-67 澄清问题：数字选项 + Other 自由文本 */
export interface ClarifyFlowQuestion {
  qid: string;
  prompt: string;
  /** 数字选项（缺省 = 开放式自由文本） */
  choices?: readonly string[];
  /** 多选（仅在提供 choices 时有效） */
  multiSelect?: boolean;
  /** 推荐项下标（壳渲染 "(Recommended)"；解析时忽略该后缀） */
  recommendedIndex?: number;
}

export interface ClarifyFlowRequest extends FlowRequestBase {
  kind: 'clarify';
  questions: readonly ClarifyFlowQuestion[];
  /** 是否允许 Other 自由文本（缺省 true） */
  allowOther?: boolean;
}

/** H-44/H-68 特权：sudo 请求 */
export interface SudoFlowRequest extends FlowRequestBase {
  kind: 'sudo';
  /** 为什么需要提权（展示给用户） */
  reason: string;
  /** 待执行的命令摘要（可选；展示用，已脱敏） */
  command?: string;
}

/** H-44/H-68 特权：机密采集请求（如配置某 API key） */
export interface SecretFlowRequest extends FlowRequestBase {
  kind: 'secret';
  /** 机密名（如环境变量名 `OPENAI_API_KEY`）；不是值 */
  name: string;
  /** 提示语（展示给用户） */
  prompt: string;
  /** 可选元数据（展示用；禁止放机密值） */
  metadata?: Record<string, string>;
}

export type FlowRequest = ApprovalFlowRequest | ClarifyFlowRequest | SudoFlowRequest | SecretFlowRequest;

/** 请求是否携带「用户将输入机密」的字段（壳必须用不回显输入） */
export function flowRequestCarriesSecret(request: { kind: FlowKind }): boolean {
  return request.kind === 'sudo' || request.kind === 'secret';
}

export function isFlowRequestKind(request: { kind: FlowKind }, kind: FlowKind): boolean {
  return request.kind === kind;
}

// —— 应答形状 ——

export type ApprovalFlowDecision = 'allow_once' | 'allow_session' | 'allow_always' | 'deny';

export const APPROVAL_FLOW_DECISIONS: readonly ApprovalFlowDecision[] = [
  'allow_once',
  'allow_session',
  'allow_always',
  'deny',
];

export function isApprovalFlowDecision(v: unknown): v is ApprovalFlowDecision {
  return typeof v === 'string' && (APPROVAL_FLOW_DECISIONS as readonly string[]).includes(v);
}

export interface ApprovalFlowResponse {
  kind: 'approval';
  decision: ApprovalFlowDecision;
  /** 拒绝原因（可选；展示给模型以自适应） */
  reason?: string;
}

export interface ClarifyFlowResponse {
  kind: 'clarify';
  /** qid → 选定标签（数字解析后归一为标签文本；开放式问题 = 用户原文） */
  answers: Record<string, string[]>;
  /** qid → Other 自由文本（若有） */
  other?: Record<string, string>;
  /** 用户取消（ESC / 关闭） */
  cancelled?: boolean;
}

export interface SudoFlowResponse {
  kind: 'sudo';
  /** sudo 口令（**机密**：绝不落审计/日志/记录） */
  password?: string;
  cancelled?: boolean;
}

export interface SecretFlowResponse {
  kind: 'secret';
  /** 机密值（**机密**：绝不落审计/日志/记录） */
  value?: string;
  /** 用户跳过（不算失败） */
  skipped?: boolean;
}

export type FlowResponse = ApprovalFlowResponse | ClarifyFlowResponse | SudoFlowResponse | SecretFlowResponse;

/** 应答种类必须与请求种类一致（防壳回投错类型） */
export function flowResponseMatchesKind(kind: FlowKind, response: FlowResponse): boolean {
  return response.kind === kind;
}

// —— 应答 ack ——

export type FlowAckState = 'applied' | 'duplicate' | 'expired' | 'unknown' | 'invalid';

export function isFlowAckState(v: unknown): v is FlowAckState {
  return v === 'applied' || v === 'duplicate' || v === 'expired' || v === 'unknown' || v === 'invalid';
}

export interface FlowAck {
  flowId: FlowId;
  state: FlowAckState;
  /** invalid/unknown 的原因 */
  reason?: string;
  /**
   * 落定后的**可公开**细节（如 secret 的 storedAs 引用、sudo 的 grantId、澄清选中项数）。
   * 严禁放机密值；由 manager 组装，壳可直接展示。
   */
  detail?: Record<string, string | number | boolean>;
}

// —— 呈现契约（三壳各自渲染同一份数据） ——

export interface ApprovalPresentation {
  tool: string;
  /** 已脱敏参数摘要 */
  argsSummary: string;
  cwd?: string;
  /** 允许的作用域（壳据此渲染 o/s/a/d 选项） */
  scopes: readonly FlowApprovalScopeMode[];
  /** 是否可拒绝（恒 true；保留为显式契约） */
  deniable: true;
}

export interface ClarifyPresentation {
  questions: ReadonlyArray<{
    qid: string;
    prompt: string;
    choices?: readonly string[];
    multiSelect: boolean;
    allowOther: boolean;
    recommendedIndex?: number;
  }>;
}

export interface SecretInputPresentation {
  /** 机密名（不是值） */
  name: string;
  /** 恒 false：壳必须不回显输入 */
  echo: false;
}

export interface FlowPresentation {
  flowId: FlowId;
  kind: FlowKind;
  sessionId?: FlowSessionId;
  /** 标题（壳可直接用作卡片标题） */
  title: string;
  /** 主提示语 */
  prompt: string;
  expiresAt?: string;
  /** kind=approval */
  approval?: ApprovalPresentation;
  /** kind=clarify */
  clarify?: ClarifyPresentation;
  /** kind=secret：机密输入（不回显） */
  secretInput?: SecretInputPresentation;
  /** kind=sudo：需要口令 */
  sudoInput?: { reason: string; command?: string; echo: false };
}

/** 各 kind 的默认标题（三壳共用文案；壳可覆盖） */
export function defaultFlowTitle(kind: FlowKind): string {
  switch (kind) {
    case 'approval':
      return '需要审批';
    case 'clarify':
      return '需要澄清';
    case 'sudo':
      return '需要提权';
    case 'secret':
      return '需要输入机密';
    default: {
      const never: never = kind;
      return String(never);
    }
  }
}

// —— 特权处理缝（manager → approval/privileged 的桥） ——

/**
 * 特权应答的处理结果（**只含可公开信息**）：
 *   decision 记录到审计；detail 供 ack 回给壳（如 secret 的 storedAs 引用、sudo 的 grantId）。
 * 机密值不在此结构里——它由 PrivilegeSink 直接交给 vault/凭据通道后即丢弃。
 */
export interface PrivilegeOutcome {
  decision: string;
  reason?: string;
  granted?: boolean;
  detail?: Record<string, string | number | boolean>;
}

/** sudo / secret 应答处理器（由 approval/privileged.ts 的 PrivilegeBroker 实现） */
export interface PrivilegeSink {
  handleSudo?(request: SudoFlowRequest, response: SudoFlowResponse): PrivilegeOutcome;
  handleSecret?(request: SecretFlowRequest, response: SecretFlowResponse): PrivilegeOutcome;
}
