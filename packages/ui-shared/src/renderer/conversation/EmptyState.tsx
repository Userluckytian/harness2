// EmptyState.tsx — Z10-1「会话已选中但还没有消息」（新任务态）空态的 1:1 复刻。
//
// 权威依据：
//   * docs/ai-framework/plans/2026-10-13-phase-Z10-p1-p2-parity.md §0.2（编排者内置浏览器实测
//     1440×900）：Logo/水印顶部居中、问候语 36px「上午好呀，有什么想让我帮忙的吗」、
//     composer 下方 4 建议 chip「周报总结 / 报错修复 / PPT 制作 / 闲时任务」（各 ≈103×32、y=511）。
//   * docs/refs/refs-zcode-layout.md Z-18 / §①：空态 = 时段问候语（边界 5/9/12/14/18/23 点）
//     + Logo 水印；建议提示在 composer **下方**。故本模块拆两个同位组件：
//       - `ConversationEmptyState`（Logo + 问候）→ 转录区（composer 之上，ZCode y=80/262）；
//       - `ConversationSuggestionChips`（4 建议 chip）→ composer 之下（ZCode y=511）。
//
// 诚实口径（红线⑩）：
//   * **Logo mark 是本仓中性占位**（复用左上浮层品牌行的鱼形 mark 轮廓），**不是** ZCode 商标；
//     尺寸按实测容器比例 400×320 居中；占位性质明确写在 `ConversationLogoMark` 注释里，
//     待正式品牌资产定稿后只替换该组件。
//   * **6 档问候只有「上午」一档逐字对齐 ZCode 实测原文**；其余 5 档按同一句式
//     「〈问候〉，有什么想让我帮忙的吗」自拟（分档边界沿用既有 `ChatEmptyState` 的
//     5/9/12/14/18/23 点），**不是** ZCode 原文，不得当原文引用。
//   * 4 建议 chip 文案逐字取自 §0.2 实测；点击 = 把文案**预填进 composer**（由壳注入
//     `onPickSuggestion` 承接，壳接既有 composer 编辑原语），**不是**直接发送。
//
// 壳无关：零 Node / 零 Electron；文案、时钟与回调全部 props 注入（缺省给本仓这套）。
import type { ReactNode } from 'react';

/** 建议 chip 文案（Z10-1 §0.2 实测逐字；顺序亦同实测） */
export const EMPTY_STATE_SUGGESTIONS: readonly string[] = ['周报总结', '报错修复', 'PPT 制作', '闲时任务'];

/**
 * 6 档时间问候，返回**完整句子**「〈问候〉，有什么想让我帮忙的吗」。
 * 分档边界沿用既有实现（`components/ChatEmptyState.tsx` 的 5/9/12/14/18/23 点）：
 *   [23,5) 深夜 · [5,9) 清晨 · [9,12) 上午 · [12,14) 中午 · [14,18) 下午 · [18,23) 傍晚。
 * **仅「上午」档逐字对齐 ZCode 实测原文**（「上午好呀，…」）；其余按同句式自拟。
 */
export function timeGreetingForHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const salutation =
    h >= 23 || h < 5
      ? '夜深了'
      : h < 9
        ? '清晨好呀'
        : h < 12
          ? '上午好呀' // ← 唯一逐字对齐 ZCode 实测的档位
          : h < 14
            ? '中午好呀'
            : h < 18
              ? '下午好呀'
              : '傍晚好呀';
  return `${salutation}，有什么想让我帮忙的吗`;
}

/**
 * 空态 Logo mark（**本仓中性占位**，非 ZCode 商标）。
 *
 * 复用左上浮层品牌行（`layout/top-overlay.tsx` 的 `BrandMark`）同一鱼形轮廓 —— 与品牌行
 * 视觉语言一致；放大到实测容器比例 400×320 内居中，低对比度（foreground-subtlest）。
 * 纯装饰（aria-hidden）；**占位性质**：待正式品牌资产（Logo / 水印）定稿后仅替换本组件。
 */
export function ConversationLogoMark(): ReactNode {
  return (
    <div className="h2-empty-mark" data-testid="conversation-empty-mark" aria-hidden>
      <svg width={220} height={220} viewBox="0 0 24 24" fill="none" role="img" focusable="false">
        <path
          d="M3 12c3.2-4.2 7.2-6.3 12-6.3 2.6 0 4.9.7 6 1.9-1.5.9-2.4 2.2-2.7 4.4-.3 2.2.4 3.9 2.7 4.6-1.1 1.2-3.4 1.9-6 1.9-4.8 0-8.8-2.1-12-6.5Z"
          fill="currentColor"
        />
      </svg>
    </div>
  );
}

export interface ConversationEmptyStateProps {
  /** 时钟注入（测试断言 6 档分档）；缺省取当前时间。 */
  readonly now?: Date;
  /** 覆盖问候句（缺省按 `now` 分档）；供壳/测试显式指定。 */
  readonly greeting?: string;
}

/**
 * 空态主体（会话已选中但无消息）：Logo mark + 时间问候。
 * 只负责 composer **之上**的视觉块；建议 chip 由 `ConversationSuggestionChips` 渲染在 composer 之下
 * （与 ZCode 实测布局一致：问候 y=262、composer y=394、chip y=511）。
 */
export function ConversationEmptyState({ now = new Date(), greeting }: ConversationEmptyStateProps): ReactNode {
  return (
    <div className="h2-empty" data-testid="conversation-empty">
      <ConversationLogoMark />
      <p className="h2-empty-greeting" data-testid="conversation-empty-greeting">
        {greeting ?? timeGreetingForHour(now.getHours())}
      </p>
    </div>
  );
}

export interface ConversationSuggestionChipsProps {
  /** 建议文案（缺省 = §0.2 实测 4 条）。 */
  readonly suggestions?: readonly string[];
  /** 点击回调（壳注入）：把文案预填进该会话 composer —— 非直接发送。未注入则不渲染（不摆死 chip）。 */
  readonly onPickSuggestion?: (text: string) => void;
}

/**
 * composer 下方的 4 建议 chip（Z10-1 §0.2）。
 * 未注入 `onPickSuggestion` 时**不渲染**（红线⑩：不摆点了没反应的假 chip）。
 */
export function ConversationSuggestionChips({
  suggestions = EMPTY_STATE_SUGGESTIONS,
  onPickSuggestion,
}: ConversationSuggestionChipsProps): ReactNode {
  if (onPickSuggestion === undefined || suggestions.length === 0) return null;
  return (
    <div className="h2-empty-suggestions" data-testid="conversation-empty-suggestions" aria-label="建议提示">
      {suggestions.map((text) => (
        <button
          key={text}
          type="button"
          data-testid="conversation-empty-suggestion"
          className="h2-empty-suggestion"
          title={text}
          onClick={() => onPickSuggestion(text)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
