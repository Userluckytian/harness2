// T4 queue-panel：渲染 shell 真实持有的 FIFO 队列（T0 队列），显示排队条数与下一条预览。
// - 数据完全是真实队列（非 mock）：shell 把 queueRef 的条目传进来；
// - 文档化取消键 Ctrl+X：取消队首（下次 drain 不再执行它）；onCancel 由 shell 接回真实队列。
import React, { type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';

/** shell 队列条目（id 稳定，供取消定位；text 为完整原文） */
export interface QueuePanelItem {
  id: string;
  text: string;
}

export const QUEUE_CANCEL_KEY = 'Ctrl+X';
const PREVIEW_MAX = 42;

/** 单条预览：折成单行并截断（仅展示用，绝不改动真实队列文本） */
export function queuePreview(text: string, max: number = PREVIEW_MAX): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/** 取消队列条目：无 id 取消队首；有 id 按 id 移除。返回新数组，不改原队列。 */
export function cancelQueueItem(items: readonly QueuePanelItem[], id?: string): QueuePanelItem[] {
  if (items.length === 0) return [];
  if (id === undefined) return items.slice(1);
  return items.filter((item) => item.id !== id);
}

export interface QueuePanelProps {
  /** 真实 FIFO 队列（队首 = 下一个执行） */
  items: readonly QueuePanelItem[];
  /** 是否接管键盘（浮层打开时为 false） */
  active?: boolean;
  /** 取消队首（shell 从真实队列移除） */
  onCancel?: (id: string) => void;
  /** 列表最多预览条数 */
  maxPreview?: number;
}

export function QueuePanel({ items, active = true, onCancel, maxPreview = 3 }: QueuePanelProps): ReactElement | null {
  const head = items[0];
  useInput(
    (input, key) => {
      if (key.ctrl && input.toLowerCase() === 'x' && head !== undefined) onCancel?.(head.id);
    },
    { isActive: active && head !== undefined },
  );

  if (items.length === 0) return null;
  const rest = items.slice(1, 1 + Math.max(0, maxPreview));
  const hidden = items.length - 1 - rest.length;
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text color="yellow">
        队列 {items.length} 条 · 下一条: {head !== undefined ? queuePreview(head.text) : ''} · {QUEUE_CANCEL_KEY}{' '}
        取消队首
      </Text>
      {rest.map((item) => (
        <Text key={item.id} color="gray">
          {'  ↳ '}
          {queuePreview(item.text)}
        </Text>
      ))}
      {hidden > 0 && <Text color="gray"> … 还有 {hidden} 条</Text>}
    </Box>
  );
}
