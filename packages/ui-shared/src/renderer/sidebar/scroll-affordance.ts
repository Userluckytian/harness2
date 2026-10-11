// 滚动条可供性（依据 refs-deepseek-harness.md D-24）：
//   栏内滚动条是指针可供性——指针不在栏内即隐藏（静默）；指针离开后滑块再留 2 秒
//   （避免擦过栏边缘或绕经浮层菜单时闪断）；显隐不改变布局，预留宽度由滚动区
//   自身的 `scrollbar-gutter: stable` 承担（见 sidebar.css）。
//   另外：内容没有溢出时本就不出现滑块（`overflow-y: auto` 语义），
//   本模块把「溢出」显式建成输入，装配层/测试都能直接断言。
// 纯函数状态机 + 一个副作用 hook（use-scroll-affordance.ts）。

/** 指针离开后的滑块滞留时长（ms，D-24） */
export const SCROLLBAR_LINGER_MS = 2000;

/** 可供性状态：指针是否在栏内 / 是否处于离开后的滞留窗 */
export interface ScrollAffordanceState {
  pointerInside: boolean;
  lingering: boolean;
}

/** 初始状态：指针从未进入，滑块静默 */
export function initialAffordanceState(): ScrollAffordanceState {
  return { pointerInside: false, lingering: false };
}

/**
 * 指针事件（进入 / 离开 / 几何判定在栏矩形内 / 在栏矩形外 / 滞留窗结束）。
 * `move-outside` 与 `leave` 的差别：前者用于指针仍在 DOM 子树内（例如栏内嵌套的
 * 全屏浮层）但已离开栏矩形的情形，两者都进入滞留窗且都**不重启**滞留窗。
 */
export type ScrollAffordanceEvent = 'enter' | 'leave' | 'move-inside' | 'move-outside' | 'linger-elapsed';

/**
 * 推移可供性状态。规则：
 *   - enter / move-inside：指针在栏内，立即取消滞留（滑块保持可见，不因擦边闪断）；
 *   - leave / move-outside：进入滞留窗；已在滞留窗内则不重启（否则指针停在栏外
 *     持续移动会把滑块的消失时刻一次次推后）；
 *   - linger-elapsed：滞留窗结束，滑块静默。
 */
export function reduceScrollAffordance(
  state: ScrollAffordanceState,
  event: ScrollAffordanceEvent,
): ScrollAffordanceState {
  switch (event) {
    case 'enter':
    case 'move-inside':
      return state.pointerInside && !state.lingering ? state : { pointerInside: true, lingering: false };
    case 'leave':
    case 'move-outside':
      return !state.pointerInside && state.lingering ? state : { pointerInside: false, lingering: true };
    case 'linger-elapsed':
      return state.lingering ? { ...state, lingering: false } : state;
  }
}

/** 该次状态迁移是否需要（重新）启动滞留计时器 */
export function armsLingerTimer(prev: ScrollAffordanceState, next: ScrollAffordanceState): boolean {
  return next.lingering && !prev.lingering;
}

/**
 * 滑块是否绘制：**溢出**且指针在栏内或处于滞留窗。
 * 未溢出时即便指针在栏内也不画（没有可滚内容就不给滚动条这个可供性）。
 */
export function scrollAffordance(input: {
  overflowing: boolean;
  pointerInside: boolean;
  lingering: boolean;
}): 'drawn' | 'quiet' {
  return input.overflowing && (input.pointerInside || input.lingering) ? 'drawn' : 'quiet';
}

/** 状态查询：某元素当前是否溢出（jsdom 无布局时两侧同为 0，判为未溢出） */
export function isOverflowing(element: { scrollHeight: number; clientHeight: number } | null): boolean {
  if (element === null) return false;
  return element.scrollHeight > element.clientHeight;
}
