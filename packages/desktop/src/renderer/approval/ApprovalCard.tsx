// 审批卡（D-6x `ui-approval` 对应物的呈现半部）：**一份实现，两种形态**
//   variant='card' —— 右栏审批中心的卡片（含 cwd / 范围 / 任务状态 / 过期元数据）
//   variant='bar'  —— 会话内联审批条（一行「允许执行 X？」+ 允许/拒绝）
// 两种形态共用同一套决定按钮、在途反馈与过期口径 → 不会出现「两套审批 UI 行为不一致」。
//
// 语义仍归 core（见 approval-model.ts 头注）：本组件只做两件事 —— 呈现卡片、回传 allow/deny。
import {
  APPROVAL_DECISION_LABEL,
  APPROVAL_EXPIRED_TEXT,
  APPROVAL_PENDING_TEXT,
  approvalScopeLabel,
  isApprovalExpired,
  summarizeApprovalArgs,
  type ApprovalCardModel,
  type ApprovalDecision,
} from './approval-model.js';

/** 卡片形态（card = 右栏卡片；bar = 会话内联条） */
export type ApprovalCardVariant = 'card' | 'bar';

export interface ApprovalCardLabels {
  readonly allow?: string;
  readonly deny?: string;
}

export interface ApprovalCardProps {
  readonly card: ApprovalCardModel;
  /** 在途（决定已发未回）：true 时用反馈文案替换按钮（连点无入口），可重试 */
  readonly responding?: boolean;
  /** 回传决定（语义归 core；本组件不自己发请求） */
  readonly onDecision: (decision: ApprovalDecision) => void;
  readonly variant?: ApprovalCardVariant;
  /** 覆盖默认按钮文案（内联条用「拒绝」；右栏卡片用「拒绝（不执行）」） */
  readonly labels?: ApprovalCardLabels;
  /** 是否展示元数据行（card 形态默认展示；bar 形态默认不展示） */
  readonly showMeta?: boolean;
  /** 服务端给的过期时刻（未在 card.expired 里判定时，本组件按此就地判定） */
  readonly now?: number;
}

/** 决定按钮组（两种形态共用；在途/过期时根本没有可点按钮） */
function DecisionButtons({
  responding,
  labels,
  onDecision,
}: {
  responding: boolean;
  labels?: ApprovalCardLabels;
  onDecision: (decision: ApprovalDecision) => void;
}): React.ReactNode {
  if (responding) return <span className="approval-note">{APPROVAL_PENDING_TEXT}</span>;
  return (
    <>
      <button type="button" className="btn-allow" onClick={() => onDecision('allow')}>
        {labels?.allow ?? APPROVAL_DECISION_LABEL.allow}
      </button>
      <button type="button" className="btn-deny" onClick={() => onDecision('deny')}>
        {labels?.deny ?? APPROVAL_DECISION_LABEL.deny}
      </button>
    </>
  );
}

export function ApprovalCard({
  card,
  responding = false,
  onDecision,
  variant = 'card',
  labels,
  showMeta,
  now,
}: ApprovalCardProps): React.ReactNode {
  // 过期口径：装饰层已判定（true/false）则以其为准；未判定（undefined）时按 expiresAt 就地判
  const expired = card.expired ?? isApprovalExpired(card.expiresAt, now);
  const scopeLabel = approvalScopeLabel(card.scope);
  const meta = showMeta ?? variant === 'card';
  const args = summarizeApprovalArgs(card.args, variant === 'bar' ? 80 : 120);

  if (variant === 'bar') {
    return (
      <div className="approval-item" data-request-id={card.requestId} data-approval-variant="bar">
        <span>
          允许执行 <b>{card.tool}</b>？{args}
        </span>
        <DecisionButtons responding={responding} labels={labels} onDecision={onDecision} />
      </div>
    );
  }

  return (
    <div
      className={`approval-card${expired ? ' approval-expired' : ''}`}
      data-request-id={card.requestId}
      data-approval-variant="card"
    >
      <div className="approval-card-main">
        <b>{card.tool}</b>
        <span className="approval-args">{args}</span>
      </div>
      {meta && (
        <div className="approval-card-meta">
          {card.cwd !== undefined && <span>cwd: {card.cwd}</span>}
          {scopeLabel !== undefined && <span>范围: {scopeLabel}</span>}
          {card.taskStateLabel !== undefined && <span>任务状态: {card.taskStateLabel}</span>}
          {card.expiresAt !== undefined && <span>过期: {card.expiresAt}</span>}
        </div>
      )}
      {expired ? (
        <div className="approval-note">{APPROVAL_EXPIRED_TEXT}</div>
      ) : (
        <div className="approval-actions">
          <DecisionButtons responding={responding} labels={labels} onDecision={onDecision} />
        </div>
      )}
    </div>
  );
}
