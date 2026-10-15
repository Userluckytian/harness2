// 恢复条（Z2-09b / Z-17「恢复条：按需」）：重订阅成功（resume-snapshot 到达）后，
// 对话页顶部的可消失细横条——告知用户在途状态已从服务端快照恢复。
//
// 显隐语义（与「重订阅是常态刷新」的区分）：
//   - controller 在切会话 / turn 收尾 / 重连后都会发 resume-subscription（常态刷新），
//     只有快照**实际携带在途状态**（inflight > 0）时才出现横条——无在途可恢复时不打扰；
//   - inflight 由 store 在快照到达时刻从 ResumeSnapshotShape 真实字段计得（resume-model.ts），
//     本组件不做任何二次推断（红线⑩：字段没有就不显示）。
//
// 交互：可手动关闭；8s 自动消失（RESUME_BAR_AUTO_DISMISS_MS）；新的快照到达（resumeAt 变化）
// 会重新显示并重置计时。关闭态只在内存（D-14），不落盘。
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { XIcon } from 'lucide-react';
import { RESUME_BAR_AUTO_DISMISS_MS, resumeRecoveryText } from './resume-model.js';

export interface ResumeBarProps {
  /** 本次恢复快照到达时刻（ms epoch；store.applyResumeSnapshot 写入 stream.resume.at） */
  readonly resumeAt: number;
  /** 快照计得的在途任务/审批条数（≤0 = 无在途可恢复，不渲染） */
  readonly inflight: number;
  /** 自动消失时长（ms）；缺省 8s。0/负值 = 不自动消失（测试注入用） */
  readonly autoDismissMs?: number;
}

/**
 * 恢复条：顶部细横条（「已恢复在途状态（N 条在途任务/审批）」+ 关闭按钮）。
 * 挂载点：会话席位（conversation/seat.tsx）顶部——对话页的第一个元素。
 */
export function ResumeBar({ resumeAt, inflight, autoDismissMs }: ResumeBarProps): ReactNode {
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const autoMs = autoDismissMs ?? RESUME_BAR_AUTO_DISMISS_MS;
  // 本次快照可见 = 快照携带在途状态且未被关闭（dismissedAt 只记「关闭时看到的快照时刻」；
  // 新快照到达即重新显示）。inflight <= 0 → 恒不可见（重订阅常态刷新不打扰）。
  const visible = inflight > 0 && dismissedAt !== resumeAt;

  // 自动消失：8s 计时挂在「当前可见的这次快照」上；关闭/换快照/卸载都清掉。
  // Hook 无条件调用（inflight 变化只影响 visible，不改 Hook 数量）。
  useEffect(() => {
    if (!visible || autoMs <= 0) return undefined;
    const timer = setTimeout(() => setDismissedAt(resumeAt), autoMs);
    return () => clearTimeout(timer);
  }, [visible, resumeAt, autoMs]);

  if (!visible) return null;
  return (
    <div
      data-testid="resume-bar"
      role="status"
      // U2-C4：满幅实底 bg-warning → 12% warning 轻底（对齐 approval-bar 的按需 dock 语言，
      // Z-60 calm：状态提示不抢正文视觉）；文本走 text-warning 语义色；关闭钮换 lucide XIcon
      // ghost（hover 才出轻底），不再是裸 `×` 文本钮。
      className="resume-bar flex flex-none items-center justify-between gap-2 border-b border-border px-3 py-1 text-warning"
    >
      <span className="min-w-0 truncate text-ui-sm">{resumeRecoveryText(inflight)}</span>
      <button
        type="button"
        data-testid="resume-bar-close"
        aria-label="关闭恢复提示"
        title="关闭（下次恢复会再次提示）"
        className="flex-none cursor-pointer rounded p-0.5 hover:bg-surface-hover"
        onClick={() => setDismissedAt(resumeAt)}
      >
        <XIcon size={16} aria-hidden />
      </button>
    </div>
  );
}
