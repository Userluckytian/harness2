// ChatErrorBanner —— composer 上方常驻错误横幅（Z-96：发送失败可见化，主形态非 toast）。
//
// 结构（Z-96 `ChatErrorBanner.tsx:280-363` 的视觉语言内实现）：
//   图标 + 单行截断消息 +（有 detail 时）「查看详情」Dialog(`<pre>`) +「复制完整报错」+ 右上 X。
//   * 单行截断：`truncate` + title 兜全文（长 reason 不撑破 composer 宽度）。
//   * 「复制完整报错」走 navigator.clipboard（缺通道如实禁用，红线⑩，不假报已复制）；
//   * X = 关闭本条错误（onDismiss 携带指纹，装配层据此去重：同错误不立刻顶回）；
//   * 刻意不用 Radix Tooltip 包裹横幅按钮（Z-96 注释：防 update-depth 循环）→ 用原生 title。
import { useEffect, useRef, useState } from 'react';
import { CircleAlertIcon, CopyIcon, XIcon } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { toast } from '../toast/index.js';

export interface ChatErrorBannerProps {
  /** 展示消息（单行截断） */
  message: string;
  /** 完整报错原文（有则出「查看详情」/「复制完整报错」；缺 = 只展示 message） */
  detail?: string | undefined;
  /** 关闭（携带指纹，装配层去重） */
  onDismiss: () => void;
  /** 指纹（复制/详情标题稳定 key 用；仅装配层判重，组件不解释） */
  fingerprint?: string | undefined;
}

export function ChatErrorBanner({ message, detail, onDismiss, fingerprint }: ChatErrorBannerProps): React.ReactNode {
  const [detailOpen, setDetailOpen] = useState(false);
  const hasDetail = detail !== undefined && detail.length > 0;
  // 复制：navigator.clipboard.writeText（渲染进程零 Node；缺通道如实禁用，不假报已复制）
  const clipboardAvailable =
    typeof navigator !== 'undefined' &&
    navigator.clipboard !== undefined &&
    typeof navigator.clipboard.writeText === 'function';
  const copyText = hasDetail ? (detail as string) : message;
  const onCopy = (): void => {
    void navigator.clipboard
      .writeText(copyText)
      .then(() => toast({ kind: 'info', message: '已复制完整报错' }))
      .catch((e: unknown) =>
        toast({ kind: 'error', message: '复制失败', detail: e instanceof Error ? e.message : String(e) }),
      );
  };
  return (
    <div className="chat-error-banner" data-testid="chat-error-banner" data-fingerprint={fingerprint} role="alert">
      <CircleAlertIcon className="chat-error-banner-icon size-4 shrink-0" aria-hidden="true" />
      <span className="chat-error-banner-message truncate" title={message}>
        {message}
      </span>
      <div className="chat-error-banner-actions">
        {hasDetail && (
          <button
            type="button"
            className="chat-error-banner-btn"
            data-testid="chat-error-details"
            title="查看详情"
            onClick={() => setDetailOpen(true)}
          >
            查看详情
          </button>
        )}
        {hasDetail && clipboardAvailable && (
          <button
            type="button"
            className="chat-error-banner-btn"
            data-testid="chat-error-copy"
            title="复制完整报错"
            onClick={onCopy}
          >
            <CopyIcon className="size-3.5" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="chat-error-banner-btn chat-error-banner-close"
          data-testid="chat-error-dismiss"
          aria-label="关闭错误提示"
          title="关闭错误提示"
          onClick={onDismiss}
        >
          <XIcon className="size-4" aria-hidden="true" />
        </button>
      </div>
      {hasDetail && (
        <ChatErrorDetailDialog open={detailOpen} onClose={() => setDetailOpen(false)} detail={detail as string} />
      )}
    </div>
  );
}

/** 详情 Dialog：`<pre>` 承载完整原文（Z-96 详情族），可滚动不撑破视口 */
function ChatErrorDetailDialog({
  open,
  onClose,
  detail,
}: {
  open: boolean;
  onClose: () => void;
  detail: string;
}): React.ReactNode {
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (open) preRef.current?.focus();
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="max-w-lg"
        aria-describedby="chat-error-detail-desc"
        data-testid="chat-error-detail-dialog"
      >
        <DialogHeader>
          <DialogTitle>报错详情</DialogTitle>
          <DialogDescription id="chat-error-detail-desc">完整错误原文（可滚动）</DialogDescription>
        </DialogHeader>
        <pre
          ref={preRef}
          tabIndex={-1}
          className="chat-error-detail-pre mono"
          data-testid="chat-error-detail-pre"
          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          {detail}
        </pre>
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="lg" onClick={onClose}>
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
