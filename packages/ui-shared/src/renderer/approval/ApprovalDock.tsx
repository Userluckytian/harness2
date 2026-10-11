// 审批 dock（Z-20：权限落点 = 会话底部 dock 卡片，**无遮罩、非模态**）。
//
// 位置：常驻在 composer 之上（由会话席位 `conversation/seat.tsx` 挂在 `.composer-overlay` 内），
// **不在转录滚动区里** —— 卡片出现/消失不插删滚动内容节点。
//
// 交互（Z-20）：带序号的 listbox（`role=listbox` / `role=option`）+ 底部右侧「确认」主按钮 +
// 底部左侧提示；键盘 ↑↓ / Tab 移动高亮，Enter 确认，Esc 不提交。范围 chip 用语义 token 小徽标。
//
// 语义仍归 core（见 approval-model.ts 头注）：本组件只呈现选项、回传 allow/deny，不新增第三态、
// 不放宽范围。提交中 / 已过期 / 提交失败沿用 approval-model 既有文案常量。
import { useId, useMemo, useState } from 'react';
import {
  APPROVAL_EXPIRED_TEXT,
  APPROVAL_PENDING_TEXT,
  isApprovalExpired,
  summarizeApprovalArgs,
  type ApprovalCardModel,
  type ApprovalDecision,
} from './approval-model.js';
import {
  APPROVAL_DOCK_CONFIRM_LABEL,
  APPROVAL_DOCK_HINT,
  approvalDockOptions,
  moveApprovalHighlight,
  type ApprovalDockOption,
} from './approval-dock-model.js';

export interface ApprovalDockProps {
  /** 当前会话的待批卡片（顺序即服务端到达顺序；多张纵向堆叠） */
  readonly approvals: readonly ApprovalCardModel[];
  /** 某请求是否在途（决定已发未回 → 选项区换为「提交中…」，无重复入口） */
  readonly respondingOf?: (requestId: string) => boolean;
  /** 某请求的提交失败注记（卡片保留可重试；缺省无注记） */
  readonly failureOf?: (requestId: string) => string | undefined;
  /** 回传决定（语义归 core：controller.respondApproval） */
  readonly onDecision: (requestId: string, decision: ApprovalDecision) => void;
  /** 过期就地判定注入（测试）；缺省 Date.now() */
  readonly now?: number;
}

/** 选项行（listbox 内一行；序号 + 标签 + 可选范围 chip） */
function OptionRow({
  id,
  index,
  option,
  selected,
  onSelect,
}: {
  id: string;
  index: number;
  option: ApprovalDockOption;
  selected: boolean;
  onSelect: () => void;
}): React.ReactNode {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-option-id={option.id}
      data-decision={option.decision}
      className={`flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-ui-base outline-none ${
        selected ? 'bg-selected text-foreground' : 'text-foreground hover:bg-hover'
      }`}
      onClick={onSelect}
    >
      <span className="w-4 shrink-0 text-right text-ui-xs tabular-nums text-foreground-subtlest">{index + 1}</span>
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {option.scopeLabel !== undefined && (
        <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-surface px-2 text-ui-xs font-medium text-foreground-subtle">
          {option.scopeLabel}
        </span>
      )}
    </div>
  );
}

/** 单张待批卡（header + 状态 + listbox + 确认/提示行） */
function ApprovalDockCard({
  card,
  responding,
  failure,
  onDecision,
  now,
}: {
  card: ApprovalCardModel;
  responding: boolean;
  failure?: string;
  onDecision: (requestId: string, decision: ApprovalDecision) => void;
  now?: number;
}): React.ReactNode {
  const options = useMemo(() => approvalDockOptions(card), [card]);
  const expired = card.expired ?? isApprovalExpired(card.expiresAt, now);
  const [active, setActive] = useState(0);
  const activeIndex = Math.min(active, options.length - 1);
  const activeOption = options[activeIndex];
  const interactive = !responding && !expired;
  const listboxId = useId();
  const optionDomId = (i: number): string => `${listboxId}-opt-${i}`;

  const confirm = (): void => {
    if (!interactive || activeOption === undefined) return;
    onDecision(card.requestId, activeOption.decision);
  };

  const step = (delta: number): boolean => {
    const next = moveApprovalHighlight(activeIndex, delta, options.length);
    if (next === activeIndex) return false;
    setActive(next);
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!interactive) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'Tab' && !e.shiftKey) {
      // 到边界不拦截 → 焦点可自然离开（避免键盘陷阱）
      if (step(1)) e.preventDefault();
    } else if (e.key === 'Tab' && e.shiftKey) {
      if (step(-1)) e.preventDefault();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      confirm();
    } else if (e.key === 'Escape') {
      // 不提交：仅阻止默认（保持等待）
      e.preventDefault();
    }
  };

  return (
    <div
      className="flex flex-col gap-2 border-b border-border pb-3 last:border-b-0 last:pb-0"
      data-request-id={card.requestId}
      data-approval-dock-card
    >
      <div className="flex items-baseline gap-2">
        <b className="shrink-0 text-ui-base font-medium text-foreground">{card.tool}</b>
        <span className="min-w-0 flex-1 break-all text-ui-sm text-foreground-subtle">
          {summarizeApprovalArgs(card.args)}
        </span>
      </div>
      {card.cwd !== undefined && <div className="break-all text-ui-sm text-foreground-subtle">cwd: {card.cwd}</div>}

      {responding ? (
        <div className="text-ui-sm text-foreground-subtle" role="status">
          {APPROVAL_PENDING_TEXT}
        </div>
      ) : expired ? (
        <div className="text-ui-sm text-warning">{APPROVAL_EXPIRED_TEXT}</div>
      ) : (
        <>
          <div
            role="listbox"
            aria-label={`审批选项：${card.tool}`}
            aria-activedescendant={optionDomId(activeIndex)}
            tabIndex={0}
            data-approval-listbox={card.requestId}
            className="flex flex-col gap-0.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-border-hover"
            onKeyDown={onKeyDown}
          >
            {options.map((option, i) => (
              <OptionRow
                key={option.id}
                id={optionDomId(i)}
                index={i}
                option={option}
                selected={i === activeIndex}
                onSelect={() => setActive(i)}
              />
            ))}
          </div>
          {failure !== undefined && (
            <div className="text-ui-sm text-destructive" role="alert">
              {failure}
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 text-ui-sm text-foreground-subtle">{APPROVAL_DOCK_HINT}</span>
            <button
              type="button"
              data-testid={`approval-confirm-${card.requestId}`}
              className="inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-transparent bg-primary px-2 text-ui-base text-primary-foreground transition-colors hover:opacity-90 disabled:pointer-events-none disabled:opacity-45"
              onClick={confirm}
            >
              {APPROVAL_DOCK_CONFIRM_LABEL}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 审批 dock：多张待批**纵向堆叠**在同一 dock 容器内（我们当前语义 = 全部呈现；dock 在转录之外，
 * 堆叠不挤占转录滚动区，容器超出时内部滚动）。
 */
export function ApprovalDock({
  approvals,
  respondingOf,
  failureOf,
  onDecision,
  now,
}: ApprovalDockProps): React.ReactNode {
  if (approvals.length === 0) return null;
  return (
    <div
      data-testid="approval-dock"
      data-approval-count={approvals.length}
      className="mx-3 mb-2 flex max-h-[min(60dvh,32rem)] flex-col gap-3 overflow-y-auto rounded-2xl border border-border bg-popover p-3 shadow-md"
    >
      {approvals.map((card) => (
        <ApprovalDockCard
          key={card.requestId}
          card={card}
          responding={respondingOf?.(card.requestId) === true}
          {...(failureOf?.(card.requestId) !== undefined ? { failure: failureOf(card.requestId) } : {})}
          onDecision={onDecision}
          {...(now !== undefined ? { now } : {})}
        />
      ))}
    </div>
  );
}
