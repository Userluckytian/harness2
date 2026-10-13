// EmptyState.tsx — Z10-1「会话已选中但还没有消息」（新任务态）空态的 1:1 复刻。
//
// 权威依据：
//   * ZCode 源码 `packages/ui/src/v4/ConversationDraftEmptyState.tsx`（问候 6 档 / 字号自适应 /
//     到点自动换档）+ i18n `packages/ui/src/i18n/locales/zh-CN.ts:4221-4226`（6 档文案逐字）。
//   * docs/refs/refs-zcode-layout.md Z-18 / §①：空态 = 时段问候语（边界 5/9/12/14/18/23 点）
//     + Logo 水印；建议提示在 composer **下方**。故本模块拆两个同位组件：
//       - `ConversationEmptyState`（Logo + 问候）→ 转录区（composer 之上，ZCode y=80/262）；
//       - `ConversationSuggestionChips`（4 建议 chip）→ composer 之下（ZCode y=511）。
//
// 复刻口径（对齐 ZCode 源码）：
//   * 6 档问候**逐字**取自 ZCode i18n（不再自拟）：
//       [5,9) 早上好呀，新的一天开始啦 / [9,12) 上午好呀，有什么想让我帮忙的吗 /
//       [12,14) 中午好呀，要不要先休息一下 / [14,18) 下午好呀，接下来交给我吧 /
//       [18,23) 晚上好呀，今天辛苦啦 / [23,5) 夜深啦，别忘了照顾好自己哦。
//   * 字号自适应（`resolveGreetingFontSizePx`，ZCode :54-78）：上限 30px、下限 20px，
//     按「容器可用宽 / 30px 自然文本宽」等比缩小；无测量/无限宽时回退上限 30px。
//   * 到点自动换档（`getNextGreetingDelayMs`，ZCode :38-52）：算出下一个边界时刻，
//     setTimeout 到点刷新；组件卸载清 timer。
//
// 诚实口径（红线⑩）：
//   * **Logo mark 是本仓中性占位**（复用左上浮层品牌行的鱼形 mark 轮廓），**不是** ZCode 商标；
//     尺寸按实测容器比例 400×320 居中；占位性质明确写在 `ConversationLogoMark` 注释里，
//     待正式品牌资产定稿后只替换该组件。
//   * 4 建议 chip 文案逐字取自 §0.2 实测；点击 = 把文案**预填进 composer**（由壳注入
//     `onPickSuggestion` 承接，壳接既有 composer 编辑原语），**不是**直接发送。
//
// 壳无关：零 Node / 零 Electron；时钟与回调全部 props 注入（缺省取当前时间）。
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/** 建议 chip 文案（Z10-1 §0.2 实测逐字；顺序亦同实测） */
export const EMPTY_STATE_SUGGESTIONS: readonly string[] = ['周报总结', '报错修复', 'PPT 制作', '闲时任务'];

/** 问候分档边界小时（ZCode `GREETING_BOUNDARY_HOURS`，:14） */
export const GREETING_BOUNDARY_HOURS = [5, 9, 12, 14, 18, 23] as const;

/** 问候字号下限 / 上限（px），ZCode `GREETING_MIN/MAX_FONT_SIZE_PX`（:15-16） */
export const GREETING_MIN_FONT_SIZE_PX = 20;
export const GREETING_MAX_FONT_SIZE_PX = 30;

/** 6 档问候 key（ZCode i18n key 后缀，:18-24） */
export type GreetingKey = 'morningEarly' | 'morning' | 'noon' | 'afternoon' | 'evening' | 'lateNight';

/** 6 档问候文案（**逐字**取自 ZCode i18n zh-CN `chat.empty.greeting.*`） */
export const GREETING_TEXTS: Readonly<Record<GreetingKey, string>> = {
  morningEarly: '早上好呀，新的一天开始啦',
  morning: '上午好呀，有什么想让我帮忙的吗',
  noon: '中午好呀，要不要先休息一下',
  afternoon: '下午好呀，接下来交给我吧',
  evening: '晚上好呀，今天辛苦啦',
  lateNight: '夜深啦，别忘了照顾好自己哦',
};

/**
 * 按小时取问候分档 key（ZCode `getChatEmptyGreetingMessageId`，:26-36 逐字同边界）：
 *   [5,9) morningEarly · [9,12) morning · [12,14) noon · [14,18) afternoon ·
 *   [18,23) evening · [23,5) lateNight。
 */
export function greetingKeyForHour(hour: number): GreetingKey {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 5 && h < 9) return 'morningEarly';
  if (h >= 9 && h < 12) return 'morning';
  if (h >= 12 && h < 14) return 'noon';
  if (h >= 14 && h < 18) return 'afternoon';
  if (h >= 18 && h < 23) return 'evening';
  return 'lateNight';
}

/**
 * 6 档时间问候（**逐字** ZCode i18n 原文；非法小时取模回卷）。
 */
export function timeGreetingForHour(hour: number): string {
  return GREETING_TEXTS[greetingKeyForHour(hour)];
}

/**
 * 距下一个问候分档边界的毫秒数（ZCode `getNextChatEmptyGreetingDelayMs`，:38-52 保真）。
 * 找当天晚于 `date` 的最近边界；若当天边界都过了 → 次日首个边界（05:00）。
 */
export function getNextGreetingDelayMs(date: Date = new Date()): number {
  const candidates = GREETING_BOUNDARY_HOURS.map((hour) => {
    const boundary = new Date(date);
    boundary.setHours(hour, 0, 0, 0);
    return boundary;
  });
  const tomorrowFirstBoundary = new Date(date);
  tomorrowFirstBoundary.setDate(tomorrowFirstBoundary.getDate() + 1);
  tomorrowFirstBoundary.setHours(GREETING_BOUNDARY_HOURS[0], 0, 0, 0);

  const nextBoundary = candidates.find((candidate) => candidate.getTime() > date.getTime()) ?? tomorrowFirstBoundary;

  return Math.max(1, nextBoundary.getTime() - date.getTime());
}

/**
 * 问候字号自适应（ZCode `resolveGreetingFontSizePx`，:54-78 保真）：
 * 上限 30px、下限 20px；仅当可用宽 < 30px 自然文本宽时按比例 floor 缩小。
 * 非法 / 非正 / 可用宽 ≥ 自然宽 → 回退上限 30px。
 */
export function resolveGreetingFontSizePx({
  availableWidthPx,
  naturalTextWidthPx,
}: {
  availableWidthPx: number;
  naturalTextWidthPx: number;
}): number {
  if (
    !Number.isFinite(availableWidthPx) ||
    !Number.isFinite(naturalTextWidthPx) ||
    availableWidthPx <= 0 ||
    naturalTextWidthPx <= 0 ||
    availableWidthPx >= naturalTextWidthPx
  ) {
    return GREETING_MAX_FONT_SIZE_PX;
  }

  return Math.max(
    GREETING_MIN_FONT_SIZE_PX,
    Math.min(
      GREETING_MAX_FONT_SIZE_PX,
      Math.floor(GREETING_MAX_FONT_SIZE_PX * (availableWidthPx / naturalTextWidthPx)),
    ),
  );
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
  /** 时钟注入（测试断言 6 档分档与到点换档）；缺省取当前时间（挂载时刻）。 */
  readonly now?: Date;
  /** 覆盖问候句（缺省按时间分档）；供壳/测试显式指定。 */
  readonly greeting?: string;
}

/**
 * 空态主体（会话已选中但无消息）：Logo mark + 时间问候。
 * 只负责 composer **之上**的视觉块；建议 chip 由 `ConversationSuggestionChips` 渲染在 composer 之下
 * （与 ZCode 实测布局一致：问候 y=262、composer y=394、chip y=511）。
 *
 * 字号自适应：问候容器可用宽 < 30px 自然文本宽时按比例缩小（下限 20px）；
 * 无 ResizeObserver 时回退上限并监听 window resize。
 */
export function ConversationEmptyState({ now, greeting }: ConversationEmptyStateProps = {}): ReactNode {
  const [greetingDate, setGreetingDate] = useState<Date>(() => now ?? new Date());
  const [fontSizePx, setFontSizePx] = useState(GREETING_MAX_FONT_SIZE_PX);
  const containerRef = useRef<HTMLParagraphElement | null>(null);
  const measurementRef = useRef<HTMLSpanElement | null>(null);

  // 到点自动换档：算下一个边界时刻，setTimeout 到点用当前时间刷新；卸载清 timer。
  useEffect(() => {
    const timer = setTimeout(() => {
      setGreetingDate(new Date());
    }, getNextGreetingDelayMs(greetingDate));

    return () => {
      clearTimeout(timer);
    };
  }, [greetingDate]);

  const text = greeting ?? timeGreetingForHour(greetingDate.getHours());

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measurement = measurementRef.current;
    if (!container || !measurement) {
      return;
    }

    const measure = () => {
      const containerStyle = window.getComputedStyle(container);
      const horizontalPaddingPx =
        Number.parseFloat(containerStyle.paddingLeft) + Number.parseFloat(containerStyle.paddingRight);
      const availableWidthPx = Math.max(0, container.getBoundingClientRect().width - horizontalPaddingPx);
      const naturalTextWidthPx = measurement.getBoundingClientRect().width;
      const nextFontSizePx = resolveGreetingFontSizePx({
        availableWidthPx,
        naturalTextWidthPx,
      });
      setFontSizePx((currentFontSizePx) => (currentFontSizePx === nextFontSizePx ? currentFontSizePx : nextFontSizePx));
    };

    measure();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => {
        window.removeEventListener('resize', measure);
      };
    }

    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(measurement);
    return () => {
      observer.disconnect();
    };
  }, [text]);

  return (
    <div className="h2-empty" data-testid="conversation-empty">
      <ConversationLogoMark />
      <p
        ref={containerRef}
        className="h2-empty-greeting"
        data-greeting-key={greetingKeyForHour(greetingDate.getHours())}
        style={{ '--h2-empty-greeting-font-size': `${fontSizePx}px` } as CSSProperties}
      >
        <span ref={measurementRef} aria-hidden="true" className="h2-empty-greeting-measure">
          {text}
        </span>
        <span data-testid="conversation-empty-greeting">{text}</span>
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
