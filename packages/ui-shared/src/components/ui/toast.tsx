// Z-78 Toast —— 纯呈现卡片（壳无关、无状态）。
//
// 数据源与宿主在 `renderer/toast/**`（`toastStore` 模块单例 + `ToastHost`）；本文件只负责
// **一张通知卡的视觉与可访问性**，两壳（desktop / web）共用同一张卡。
// 视觉依据 refs-zcode.md §Z-78：`rounded-2xl border bg-toast/60 shadow-lg backdrop-blur-xl`、
// 内网格 `[auto_minmax(0,1fr)_auto]`、入场 200ms。
import type { ReactNode } from 'react';
import { CircleCheck, CircleX, InfoIcon, XIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/** 通知语义：info 中性 / success 成功 / error 失败。 */
export type ToastKind = 'info' | 'success' | 'error';

export interface ToastCardProps {
  readonly kind: ToastKind;
  readonly message: ReactNode;
  readonly detail?: ReactNode;
  /** 手动关闭回调（由宿主接 store.dismiss）。 */
  readonly onDismiss: () => void;
  readonly className?: string;
}

function ToastIcon({ kind }: { kind: ToastKind }): ReactNode {
  if (kind === 'success') return <CircleCheck className="size-4 shrink-0 text-success" />;
  if (kind === 'error') return <CircleX className="size-4 shrink-0 text-destructive" />;
  return <InfoIcon className="size-4 shrink-0 text-foreground-subtle" />;
}

export function ToastCard({ kind, message, detail, onDismiss, className }: ToastCardProps): ReactNode {
  // error 用 role=alert / assertive（失败须被打断式播报）；其余用 role=status / polite
  // （与 ZCode `[role=status]` 一致，且不打断用户当前朗读）。
  const isError = kind === 'error';
  return (
    <div
      data-slot="toast"
      data-testid="toast"
      data-kind={kind}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      className={cn(
        'grid min-w-[280px] max-w-[380px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-2xl border border-border bg-toast/60 p-2.5 text-ui-base shadow-lg backdrop-blur-xl duration-200 animate-in fade-in-0 slide-in-from-top-2',
        className,
      )}
    >
      <ToastIcon kind={kind} />
      <div className="grid gap-0.5">
        <div className="font-medium">{message}</div>
        {detail !== undefined && detail !== null ? (
          <div className="text-ui-sm text-foreground-subtle">{detail}</div>
        ) : null}
      </div>
      <button
        type="button"
        aria-label="关闭通知"
        data-testid="toast-dismiss"
        onClick={onDismiss}
        className="inline-flex size-5 items-center justify-center rounded-sm text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
