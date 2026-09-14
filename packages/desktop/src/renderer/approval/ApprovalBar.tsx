// 会话内联审批条（D-6x `ui-approval` 对应物：从 ChatView 内联实现迁出）。
// 位置在转录底部（既有 `.approval-bar` 样式与行为不变），只是卡片实现改由本模块统一提供。
// 决定语义与右栏审批中心完全同源（ApprovalCard 的 bar 形态），不存在第二套按钮/文案。
import { ApprovalCard } from './ApprovalCard.js';
import type { ApprovalCardModel, ApprovalDecision } from './approval-model.js';

export interface ApprovalBarProps {
  /** 当前会话的待批卡片（顺序即服务端到达顺序） */
  readonly approvals: readonly ApprovalCardModel[];
  /** 某请求是否在途（决定已发未回 → 按钮换为反馈文案） */
  readonly respondingOf?: (requestId: string) => boolean;
  /** 回传决定（语义归 core：controller.respondApproval） */
  readonly onDecision: (requestId: string, decision: ApprovalDecision) => void;
}

export function ApprovalBar({ approvals, respondingOf, onDecision }: ApprovalBarProps): React.ReactNode {
  if (approvals.length === 0) return null;
  return (
    <div className="approval-bar" data-approval-bar-count={approvals.length}>
      {approvals.map((a) => (
        <ApprovalCard
          key={a.requestId}
          card={a}
          variant="bar"
          {...(respondingOf !== undefined ? { responding: respondingOf(a.requestId) } : {})}
          labels={{ allow: '允许', deny: '拒绝' }}
          onDecision={(decision) => onDecision(a.requestId, decision)}
        />
      ))}
    </div>
  );
}
