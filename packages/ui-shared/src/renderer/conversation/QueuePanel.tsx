// 队列面板（Z2-09b / Z-17「QueuePanel：有队列时，底部 dock」）：composer 之上的按需 dock。
//
// 登记项（交付报告同步）：
//   1. ZCode 无队列面板的细节条目像素依据（refs-zcode-layout.md 仅一行「QueuePanel | 有队列时 |
//      底部 dock」）——条目构成按我们 dock 族视觉自拟：位次 + 状态 chip + 摘要 + 一行说明。
//   2. **只读展示**：WsClientOp（shared/protocol.ts）没有「撤回队列条目」的 op，controller /
//      store 也没有对应动作 → 不摆假撤回按钮（等 core 提供撤回端点后只改这里加动作）。
//
// 数据链路：store.stream.queue（服务端可见队列）+ pendingSubmits（本地在途）+ submitAcks（ack
// 结论）→ composeQueueView（既有纯模型：queued/paused/pending/unconfirmed 四态）→ 本组件。
// 空队列返回 null（按需出现，不留占位高度）。
import type { ReactNode } from 'react';
import type { ComposerQueueItem } from '../features/composer/composer-model.js';

/** 四态的用户可读标签（与 ChatTranscript 旧 queue-bar 同一套词） */
const QUEUE_KIND_LABEL: Record<ComposerQueueItem['kind'], string> = {
  queued: '排队',
  paused: '暂停',
  pending: '待确认',
  unconfirmed: '未确认',
};

/** 未确认（ack 丢失）是唯一的警示态：chip 用警示色提醒「勿重复提交」 */
function kindChipClass(kind: ComposerQueueItem['kind']): string {
  return kind === 'unconfirmed'
    ? 'bg-destructive text-destructive-foreground'
    : kind === 'paused'
      ? 'bg-warning text-warning-foreground'
      : 'bg-surface text-foreground-subtle';
}

export function QueuePanel({ entries }: { entries: readonly ComposerQueueItem[] }): ReactNode {
  if (entries.length === 0) return null;
  return (
    <div
      data-testid="queue-dock"
      data-queue-count={entries.length}
      aria-label="待发送队列"
      className="mx-3 mb-2 flex max-h-[min(40dvh,20rem)] flex-col gap-1.5 overflow-y-auto rounded-2xl border border-border bg-popover p-3 shadow-xs"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-ui-xs font-medium text-foreground-subtle">待发送队列</span>
        <span className="text-ui-xs tabular-nums text-foreground-subtlest">{entries.length} 条</span>
      </div>
      {entries.map((entry, index) => (
        <div
          key={entry.id}
          data-queue-entry-id={entry.id}
          className="flex min-h-6 items-baseline gap-2 text-ui-sm text-foreground"
        >
          <span className="w-4 flex-none text-right text-ui-xs tabular-nums text-foreground-subtlest">{index + 1}</span>
          <span className={`flex-none rounded-full px-1.5 text-ui-xs leading-4 ${kindChipClass(entry.kind)}`}>
            {QUEUE_KIND_LABEL[entry.kind]}
          </span>
          <span className="min-w-0 flex-1 truncate">{entry.text}</span>
          {entry.note !== undefined && (
            <span className="flex-none text-ui-xs text-foreground-subtlest">{entry.note}</span>
          )}
        </div>
      ))}
    </div>
  );
}
