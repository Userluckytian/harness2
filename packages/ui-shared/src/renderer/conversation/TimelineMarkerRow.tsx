// TimelineMarkerRow.tsx — Z-92 `timelineMarker` 行（Z3-07 真实子集：compact /
// checkpointRestored / retryNotice 三变体；forkNotice/forkCreated/modelChange/goalSet/
// goalVerify 无数据源，不实现 —— 登记见 chat-model.ts TimelineMarkerVariant 注释）。
//
// 视觉依据：refs-zcode.md Z-92 表只给语义（「TimelineMarkerRowView；compact = 压缩边界」），
// 无像素级细节 —— 按标记行的通用风格自定（交付报告已登记）：
//   - 居中细分隔的标记行：左右细线（--color-border）+ 中部低饱徽章，不抢对话主体视觉；
//   - 字号只用 text-ui-caption / text-ui-2xs，颜色只用语义 token（Z-60～Z-64 纪律）；
//   - retry-notice 沿用既有 attempt 行的文案口径（「尝试失败：<error>」），半截产出
//     （P3-b，assistant/attempt 是日志权威）在标记行内可展开，仍标注「未完成 / 已中断」。
import type { ReactNode } from 'react';
import { AlertTriangleIcon, ArchiveIcon, HistoryIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TimelineMarkerVariant } from '../chat-model.js';

/** compact 徽章摘要的单行截断上限（摘要原文可能到 COMPACTION_MAX_SUMMARY_CHARS 量级） */
export const MARKER_SUMMARY_MAX_CHARS = 80;

/** compact 摘要展示行：压平空白为单行 + 超长截断（原文经 title 全文可见） */
export function compactSummaryLine(summary: string, max: number = MARKER_SUMMARY_MAX_CHARS): string {
  const one = summary.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max)}…`;
}

/** checkpointRestored 文案（rewindToSeq 是唯一真实数据） */
export function checkpointRestoredText(rewindToSeq: number): string {
  return `已回退到序号 ${rewindToSeq}`;
}

/** retry-notice 文案（沿用既有 attempt 行口径） */
export function retryNoticeText(error: string): string {
  return `尝试失败：${error}`;
}

interface TimelineMarkerRowProps {
  variant: TimelineMarkerVariant;
  /** compact：压缩摘要原文（展示层截断） */
  summary?: string;
  /** checkpoint-restored：回退目标 seq */
  rewindToSeq?: number;
  /** retry-notice：失败/取消原因 */
  error?: string;
  /** retry-notice：半截产出（P3-b；有才给展开入口，绝不伪造） */
  partialText?: string;
}

/** 变体 → 徽章图标与标签色（低饱：标记行一律 foreground-subtle 系，错误才用 destructive） */
function variantGlyph(variant: TimelineMarkerVariant): { Icon: LucideIcon; className: string } {
  switch (variant) {
    case 'compact':
      return { Icon: ArchiveIcon, className: 'text-foreground-subtle' };
    case 'checkpoint-restored':
      return { Icon: HistoryIcon, className: 'text-foreground-subtle' };
    case 'retry-notice':
      return { Icon: AlertTriangleIcon, className: 'text-destructive' };
  }
}

/**
 * Z-92 时间线标记行：居中细分隔 + 低饱徽章。三种变体共用同一行形，只有徽章内容不同。
 * 无耗时/模型/子会话等附加字段一律不显示（红线⑩：没有的数据不显示）。
 */
export function TimelineMarkerRow({
  variant,
  summary,
  rewindToSeq,
  error,
  partialText,
}: TimelineMarkerRowProps): ReactNode {
  const { Icon, className } = variantGlyph(variant);
  return (
    <div
      className="flex w-full items-center gap-2 py-0.5"
      data-testid="timeline-marker"
      data-variant={variant}
      role="note"
    >
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="flex min-w-0 items-center gap-1.5 text-ui-caption">
        <Icon size={12} aria-hidden className={cn('shrink-0', className)} />
        {variant === 'compact' && (
          <>
            <span className={cn('shrink-0', className)}>上下文已压缩</span>
            {(summary ?? '').length > 0 && (
              <span
                className="min-w-0 truncate text-ui-2xs text-foreground-subtlest"
                title={summary}
                data-testid="marker-summary"
              >
                {compactSummaryLine(summary ?? '')}
              </span>
            )}
          </>
        )}
        {variant === 'checkpoint-restored' && (
          <span className={cn('shrink-0', className)} data-testid="marker-rewind">
            {checkpointRestoredText(rewindToSeq ?? 0)}
          </span>
        )}
        {variant === 'retry-notice' && (
          <>
            <span className={cn('shrink-0', className)} data-testid="marker-retry">
              {retryNoticeText(error ?? '')}
            </span>
            {partialText !== undefined && partialText.length > 0 && (
              <details className="min-w-0" data-testid="marker-partial">
                <summary className="cursor-pointer text-ui-2xs text-foreground-subtle hover:text-foreground">
                  未完成 / 已中断的产出（{partialText.length} 字）
                </summary>
                <div className="max-h-60 overflow-y-auto border-l border-border pl-2 text-ui-2xs whitespace-pre-wrap text-foreground-subtle">
                  {partialText}
                </div>
              </details>
            )}
          </>
        )}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}
