// cards/types.ts — P3-B：阻塞卡片四件套的统一 Card 类型（G-21～G-24）。
//
// 规格依据：docs/refs/refs-grok-build.md G-4x——
//   G-21 permission prompt（工具/命令权限请求）优先级最高，遮盖其他卡片；
//   G-22 cancel-turn panel（取消确认）次之；
//   G-23 question card（`ask_user_question` 工具）选项 + 自由文本；
//   G-24 MCP elicitation（`x.ai/mcp/elicit`）优先级最低。
//   优先级固定：`permission > cancel-turn > question > elicitation`（多卡同时到达按此
//   展示顺序，其余排队——排序实现在 queue.ts，本文件只冻结枚举位与数值）。
//
// 职责边界（硬约束）：
//  - 本目录是**统一四件套的调度层**（哪张卡显示、排队顺序、卡内焦点），不重写审批语义；
//  - **审批应答仍走 core 既有通道**：卡片携带的 route 是纯数据描述符（回答该送哪条既有
//    契约），不是回调；接线层按 route 把 CardAnswer 分发出去（映射表见 CardRoute 注释）。
//    core 审批状态机（ApprovalQueue / SessionHubApproval / ApprovalGate）零改动。
//
// 与 core 审批结构的适配说明（ApprovalRequestContract → PermissionCard，字段映射表）：
//   requestId  → id（permission 卡的 id 直接复用 core requestId：全局唯一、resolve 可直通）
//   sessionId  → payload.sessionId
//   tool       → payload.tool
//   args       → payload.args（已脱敏参数，core 出站前过 redactSecrets；卡侧原样呈现）
//   cwd        → payload.cwd（可选）
//   scope      → payload.scope（复用 core ApprovalScope 类型，不复制形状）
//   expiresAt  → payload.expiresAt（只有 permission 卡有；过期判定仍以 core
//                isApprovalExpired 为准，卡层不自行做 allow/deny 裁决）
//   taskId     → payload.taskId（可选）
//   parentTaskId → payload.parentTaskId（可选）
//   （对不上的字段：无。core 契约字段全覆盖；core 没有的字段卡层一律不加——
//    避免出现「卡里有但 core 不认」的幽灵状态。）
import type { ApprovalRequestContract, ApprovalScope } from '@harness2/core';

/** 四类阻塞卡（G-21～G-24），顺序即展示优先级从高到低 */
export const CARD_KINDS = ['permission', 'cancel-turn', 'question', 'elicitation'] as const;

export type CardKind = (typeof CARD_KINDS)[number];

/** 固定优先级数值（G-21～G-24 冻结）：数值越大越先展示；仅用于排序，不做其他语义 */
export const CARD_PRIORITY: Readonly<Record<CardKind, number>> = {
  permission: 3,
  'cancel-turn': 2,
  question: 1,
  elicitation: 0,
};

/** 展示顺序（优先级高 → 低）：测试与诊断用，与 CARD_KINDS 同序 */
export const CARD_PRIORITY_ORDER: readonly CardKind[] = CARD_KINDS;

/** 卡片来源（追溯用；不参与优先级） */
export type CardSource =
  /** core 审批流（ApprovalQueue onAsk / SessionHubApproval） */
  | { readonly system: 'core-approval' }
  /** 本壳 UI 自产（cancel-turn 取消确认） */
  | { readonly system: 'ui' }
  /** 工具请求卡（question 卡来自 `ask_user_question`） */
  | { readonly system: 'tool'; readonly tool: string }
  /** MCP elicitation（`x.ai/mcp/elicit`） */
  | { readonly system: 'mcp-elicit'; readonly server: string };

// —— 各卡 payload ——

/** G-21 permission prompt payload（与 core ApprovalRequestContract 一一对应，见文件头映射表） */
export interface PermissionPayload {
  readonly sessionId: string;
  readonly tool: string;
  /** 已脱敏参数（脱敏由 core 负责；卡层原样呈现，不做二次处理） */
  readonly args: unknown;
  readonly scope: ApprovalScope;
  /** ISO8601；过期判定归 core isApprovalExpired，卡层只透传展示 */
  readonly expiresAt: string;
  readonly cwd?: string;
  readonly taskId?: string;
  readonly parentTaskId?: string;
}

/** G-22 cancel-turn panel payload：确认是否取消运行中的回合 */
export interface CancelTurnPayload {
  readonly turnId: string;
  /** 确认文案（如进行中工作摘要）；缺省用 render 层缺省文案 */
  readonly reason?: string;
}

/** G-23 question card 的单个选项 */
export interface QuestionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/** G-23 question card payload：选项 + 自由文本 */
export interface QuestionPayload {
  readonly question: string;
  readonly options: readonly QuestionOption[];
  /** 是否提供自由文本入口（G-23「选项 + 自由文本」；缺省 false） */
  readonly allowFreeText?: boolean;
}

/** G-24 MCP elicitation payload（`x.ai/mcp/elicit`） */
export interface ElicitationPayload {
  /** MCP server 名（来源标识，展示在标题） */
  readonly server: string;
  readonly message: string;
  /** MCP elicitation requestedSchema（JSON Schema 原样透传；卡层不解析不校验） */
  readonly requestedSchema?: unknown;
}

// —— resolve 通道（纯数据描述符：回答送哪条**既有** core 契约）——
//
// 接线层分发映射表（本层不实现，防止私造审批语义）：
//   core-approval → CLI ApprovalGate.choose/cancel（legacy 内联）或 serve 侧
//                   SessionHub.respondApproval(requestId, allow|deny)（WS 通道）；
//                   decision 映射：CardAnswer.permission.allow=true→'allow'，false→'deny'
//   core-cancel   → core 既有取消通道（CancelRequest.target.kind='turn'）；confirm=true
//                   才发取消，false = 继续运行（不发任何取消帧）
//   tool-result   → `ask_user_question` 工具结果回传（optionId 或自由文本）
//   mcp-elicit    → `x.ai/mcp/elicit` 响应通道（accept/decline/cancel + content）
export type CardRoute =
  | { readonly via: 'core-approval'; readonly requestId: string }
  | { readonly via: 'core-cancel'; readonly turnId: string }
  | { readonly via: 'tool-result'; readonly callId: string }
  | { readonly via: 'mcp-elicit'; readonly requestId: string };

// —— 应答类型（卡层只搬运；语义裁决全在 core）——

export type PermissionAnswer = { readonly kind: 'permission'; readonly allow: boolean };
export type CancelTurnAnswer = { readonly kind: 'cancel-turn'; readonly confirm: boolean };
export type QuestionAnswer = {
  readonly kind: 'question';
  readonly answer:
    { readonly type: 'option'; readonly optionId: string } | { readonly type: 'free-text'; readonly text: string };
};
export type ElicitationAnswer = {
  readonly kind: 'elicitation';
  readonly action: 'accept' | 'decline' | 'cancel';
  /** action=accept 时携带的表单内容（MCP requestedSchema 对应；卡层不校验） */
  readonly content?: Readonly<Record<string, unknown>>;
};

/** 统一应答：kind 判别，与 BlockCard.kind 一一对应 */
export type CardAnswer = PermissionAnswer | CancelTurnAnswer | QuestionAnswer | ElicitationAnswer;

// —— 统一 Card（kind 判别联合）——

interface CardBase {
  /** 卡片唯一 id（同 id 重复 push 在 queue 层去重；permission 卡 = core requestId） */
  readonly id: string;
  readonly source: CardSource;
}

export interface PermissionCard extends CardBase {
  readonly kind: 'permission';
  readonly payload: PermissionPayload;
  readonly route: { readonly via: 'core-approval'; readonly requestId: string };
}

export interface CancelTurnCard extends CardBase {
  readonly kind: 'cancel-turn';
  readonly payload: CancelTurnPayload;
  readonly route: { readonly via: 'core-cancel'; readonly turnId: string };
}

export interface QuestionCard extends CardBase {
  readonly kind: 'question';
  readonly payload: QuestionPayload;
  readonly route: { readonly via: 'tool-result'; readonly callId: string };
}

export interface ElicitationCard extends CardBase {
  readonly kind: 'elicitation';
  readonly payload: ElicitationPayload;
  readonly route: { readonly via: 'mcp-elicit'; readonly requestId: string };
}

/** 四件套统一卡片类型（kind 判别联合；G-21～G-24 一体调度） */
export type BlockCard = PermissionCard | CancelTurnCard | QuestionCard | ElicitationCard;

/** 卡片 kind → 应答 kind 的对应校验：卡 id 与应答必须同 kind（接线层防错配） */
export function cardAnswerKindMatches(card: BlockCard, answer: CardAnswer): boolean {
  return card.kind === answer.kind;
}

/**
 * 适配层：core ApprovalRequestContract → permission 卡（G-21）。
 * 字段映射见文件头表格；id 直接复用 requestId，resolve 时按 route.requestId 走既有通道。
 */
export function permissionCardFromApproval(approval: ApprovalRequestContract): PermissionCard {
  return {
    id: approval.requestId,
    kind: 'permission',
    source: { system: 'core-approval' },
    payload: {
      sessionId: approval.sessionId,
      tool: approval.tool,
      args: approval.args,
      scope: approval.scope,
      expiresAt: approval.expiresAt,
      ...(approval.cwd !== undefined ? { cwd: approval.cwd } : {}),
      ...(approval.taskId !== undefined ? { taskId: approval.taskId } : {}),
      ...(approval.parentTaskId !== undefined ? { parentTaskId: approval.parentTaskId } : {}),
    },
    route: { via: 'core-approval', requestId: approval.requestId },
  };
}
