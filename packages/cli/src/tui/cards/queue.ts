// cards/queue.ts — P3-B：阻塞卡片调度器（纯 reducer，G-21～G-24 展示顺序）。
//
// 规格依据：docs/refs/refs-grok-build.md G-4x——优先级固定
//   `permission > cancel-turn > question > elicitation`；
//   多卡同时到达按此展示顺序，其余排队；G-21 permission 遮盖其他卡片。
//
// 设计（对齐 input/focus.ts 的纯 reducer 风格：不可变返回、headless 可测、零依赖）：
//  - state.pending 恒按「展示顺序」维护：优先级降序、同级 FIFO（先 push 在前）。
//    push 时插入到第一个**严格更低优先级**卡片之前——同级自然排在其后（FIFO），
//    更高优先级排在其前（遮盖），因此 pending[0] 恒为当前应展示的 active 卡；
//  - resolve 按 id 移除（不限于 active：排队中的卡也可能因超时/取消被结算——
//    core ApprovalQueue.settle 对任意 requestId 落定的同语义）；active 被移除后，
//    新 pending[0] 即按优先级顶出的下一张；
//  - 重复 id 的 push 幂等忽略（对齐 core ApprovalQueue.register 的重复 requestId 拒绝）；
//  - 卡片携带的 route/应答语义见 types.ts——本模块只裁决**顺序**，不碰应答通道。
import { CARD_PRIORITY, type BlockCard, type CardKind } from './types.js';

/** 卡片队列状态：pending 恒为展示顺序（active = pending[0]）；空队列 = 无阻塞卡 */
export interface CardQueueState {
  readonly pending: readonly BlockCard[];
}

/** 初始状态：无卡片 */
export function initialCardQueue(): CardQueueState {
  return { pending: [] };
}

/** 当前应展示的卡片（G-21～G-24 优先级最高者）；空队列返回 null */
export function activeCard(state: CardQueueState): BlockCard | null {
  return state.pending[0] ?? null;
}

/** 全部待展示卡（展示顺序：active 在前）；诊断/浮层栈用 */
export function pendingCards(state: CardQueueState): readonly BlockCard[] {
  return state.pending;
}

/** 卡片是否在队列中 */
export function hasCard(state: CardQueueState, id: string): boolean {
  return state.pending.some((c) => c.id === id);
}

/**
 * 入队：插到第一个严格更低优先级卡之前 → 高优先级遮盖（G-21）、同级 FIFO、
 * active 恒为最高优先级最早 push 的卡。重复 id 幂等忽略（原状态原引用返回）。
 */
export function pushCard(state: CardQueueState, card: BlockCard): CardQueueState {
  if (hasCard(state, card.id)) return state; // 幂等：同 id 不重复入队
  const at = state.pending.findIndex((c) => CARD_PRIORITY[c.kind] < CARD_PRIORITY[card.kind]);
  if (at < 0) return { pending: [...state.pending, card] }; // 全部 >= 它 → 追加到队尾
  return { pending: [...state.pending.slice(0, at), card, ...state.pending.slice(at)] };
}

/**
 * 结算移除：按 id 从队列任意位置移除（返回被移除的卡，供接线层按 route 分发应答；
 * id 不存在时原状态原引用返回、卡为 null——不抛错，对齐 core respond 的 unknown 三态思路）。
 */
export function resolveCard(
  state: CardQueueState,
  id: string,
): { readonly state: CardQueueState; readonly card: BlockCard | null } {
  const at = state.pending.findIndex((c) => c.id === id);
  if (at < 0) return { state, card: null };
  const card = state.pending[at]!;
  return { state: { pending: [...state.pending.slice(0, at), ...state.pending.slice(at + 1)] }, card };
}

/** 按优先级顶出：active 被 resolve 后下一张展示卡（等价 activeCard(resolve 后的状态)；诊断用） */
export function nextCardAfter(state: CardQueueState, id: string): BlockCard | null {
  return activeCard(resolveCard(state, id).state);
}

/** 优先级查询（测试/诊断用） */
export function priorityOf(kind: CardKind): number {
  return CARD_PRIORITY[kind];
}
