// Composer 纯逻辑（D1）：IME 不误发、自动高度、可见队列视图。
//
// 可用性红线（Global Constraints #3）：IME 不误发、草稿隔离、键盘焦点——本模块只做纯决策，
// DOM 事件由 ChatView 传入；可单测、不依赖 React/DOM。
import type { QueueEntryShape } from '../../../shared/protocol.js';

/** 键盘事件的最小形状（React.KeyboardEvent 兼容） */
export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  /** 旧式 IME 组合标志（部分 Windows/Electron 输入法在组合期只给 229，isComposing 为 false） */
  keyCode?: number;
}

/**
 * IME 组合中判定（D1「IME 不误发」）：
 *   - 标准 `isComposing`（组合事件序列）优先；
 *   - 旧式 `keyCode === 229`（Windows 中文输入法在 keydown 阶段只给 229）兜底——
 *     缺这条会在候选词上屏时误发消息。
 */
export function isImeComposing(e: KeyLike): boolean {
  if (e.isComposing === true) return true;
  if (e.keyCode === 229) return true;
  return false;
}

/** Enter 提交判定：Enter + 非 Shift + 非 IME 组合中；其余（Shift+Enter / 组合中）一律不提交 */
export function shouldSubmitOnKey(e: KeyLike): boolean {
  if (e.key !== 'Enter') return false;
  if (e.shiftKey === true) return false;
  return !isImeComposing(e);
}

export const COMPOSER_MIN_HEIGHT = 40;
export const COMPOSER_MAX_HEIGHT = 200;
export const COMPOSER_LINE_HEIGHT = 20;
export const COMPOSER_VERTICAL_PADDING = 16;

/**
 * 自动高度（纯函数，按行数推导，不依赖 DOM 测量）：随内容行数增长，夹在 min/max 之间。
 * 空内容 = 单行高度（不塌陷）。
 */
export function autoHeightFor(
  value: string,
  opts: { min?: number; max?: number; lineHeight?: number; padding?: number } = {},
): number {
  const min = opts.min ?? COMPOSER_MIN_HEIGHT;
  const max = opts.max ?? COMPOSER_MAX_HEIGHT;
  const lineHeight = opts.lineHeight ?? COMPOSER_LINE_HEIGHT;
  const padding = opts.padding ?? COMPOSER_VERTICAL_PADDING;
  const lines = value.length === 0 ? 1 : value.split('\n').length;
  const raw = lines * lineHeight + padding;
  return Math.max(min, Math.min(max, raw));
}

/** 可见队列项类型：queued=已排队 / paused=重启恢复待用户放行 / pending=等 ack / unconfirmed=ack 丢失 */
export type ComposerQueueKind = 'queued' | 'paused' | 'pending' | 'unconfirmed';

export interface ComposerQueueItem {
  id: string;
  kind: ComposerQueueKind;
  text: string;
  /** 面向用户的一行说明（pending/unconfirmed 必带） */
  note?: string;
}

export interface ComposerQueueInput {
  queue: readonly QueueEntryShape[];
  pendingSubmits: Record<string, { clientMessageId: string; rawText: string; intent: 'queue' | 'steer' }>;
  submitAcks: Record<string, { state: 'accepted' | 'rejected' | 'unknown'; reason?: string }>;
}

/**
 * 可见队列视图（D1）：把「服务端可见队列 + 本地在途提交 + ack 结论」合成一份用户可读清单。
 * 语义（明令禁止把重连当重发）：
 *   - ack 未到 → pending（「等待服务端确认…」），**不重复发送**；
 *   - ack 丢失标 unknown → unconfirmed（「未收到确认，请勿重复提交」）；
 *   - paused（重启恢复）如实展示为「待放行」，不自动执行。
 */
export function composeQueueView(input: ComposerQueueInput): ComposerQueueItem[] {
  const items: ComposerQueueItem[] = [];
  const seen = new Set<string>();
  for (const q of input.queue) {
    seen.add(q.id);
    const pending = input.pendingSubmits[q.id] !== undefined;
    const ack = input.submitAcks[q.id];
    if (ack?.state === 'unknown') {
      items.push({
        id: q.id,
        kind: 'unconfirmed',
        text: q.rawText,
        note: ack.reason ?? '未收到服务端确认（连接中断），请勿重复提交',
      });
    } else if (pending) {
      items.push({ id: q.id, kind: 'pending', text: q.rawText, note: '等待服务端确认…' });
    } else if (q.state === 'paused') {
      items.push({ id: q.id, kind: 'paused', text: q.rawText, note: '服务重启后暂停，需显式放行' });
    } else {
      items.push({ id: q.id, kind: 'queued', text: q.rawText });
    }
  }
  // 不在服务端队列但在途的提交（典型：steer 是控制输入，不落队列）
  for (const p of Object.values(input.pendingSubmits)) {
    if (seen.has(p.clientMessageId)) continue;
    const ack = input.submitAcks[p.clientMessageId];
    const unconfirmed = ack?.state === 'unknown';
    items.push({
      id: p.clientMessageId,
      kind: unconfirmed ? 'unconfirmed' : 'pending',
      text: p.rawText,
      note: unconfirmed
        ? (ack?.reason ?? '未收到服务端确认（连接中断），请勿重复提交')
        : p.intent === 'steer'
          ? '引导已提交，等待本步边界生效…'
          : '等待服务端确认…',
    });
  }
  return items;
}
