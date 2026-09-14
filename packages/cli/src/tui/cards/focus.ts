// cards/focus.ts — P3-B：卡内焦点环（G-25）。
//
// 规格依据：docs/refs/refs-grok-build.md G-25——四类共用：
//   `Tab` / `Shift+Tab` 卡内环走（不泄漏到全局）。
//
// 与 P2 全局焦点环（tui/input/focus.ts）的接缝（**本文件冻结契约**）：
//  - 卡片打开期（queue.active() !== null）：全局环**挂起**——接线层收到 Tab/Shift+Tab
//    一律喂给 reduceCardFocus，**绝不调用 reduceFocus**（全局环状态原地不动）；
//    globalFocusSuspended 是接缝判定谓词（测试覆盖）。
//  - 卡片退完（active 为 null）：卡内环不再被喂键；全局环按 P2 契约恢复，
//    `{type:'park'}`（input/focus.ts）仍是卡片退完后重新进入全局环的入口（G-20）。
//  - 不泄漏的结构保证：本状态机与 reduceFocus 是**两台互不引用的机器**，卡内动作
//    枚举里根本没有「切到 prompt/scrollback」这类全局动作——卡内环想泄漏也没有出口。
//
// 设计（对齐 input/focus.ts 的纯 reducer 风格）：
//  - 焦点在「当前卡片的可交互元素」下标上循环（元素清单由 render.ts 的 CardItemView
//    提供，本模块只拿 count——零耦合）；Tab=next、Shift+Tab=prev，双向循环取模；
//  - 卡片切换/重开 → reset(count) 回到第 0 项；count 收缩（payload 变化）→ 钳制；
//  - Esc 是 Esc 语义（G-14～G-20 归 esc-machine）：卡内环对 escape 恒等返回
//    （负向断言与 P2 reduceFocus 的 Esc 负向规则同款）。
/** 卡内焦点状态：index = 焦点元素在当前卡可交互元素中的下标 */
export interface CardFocusState {
  readonly index: number;
  /** 当前卡可交互元素数（来自 render.ts items.length；0 = 无可交互元素） */
  readonly count: number;
}

export type CardFocusAction =
  /** Tab：下一个（到尾回环到首） */
  | { readonly type: 'next' }
  /** Shift+Tab：上一个（到首回环到尾） */
  | { readonly type: 'prev' }
  /** 卡片打开/切换：按新卡元素数重置到第 0 项 */
  | { readonly type: 'reset'; readonly count: number }
  /** Esc：**恒 no-op**——Esc 不是卡内焦点键（G-25 负向规则；显式占位表达「收到了但不理」） */
  | { readonly type: 'escape' };

/** 初始卡内焦点（卡片打开时由接线层发 reset(count) 落位；此处 count=0 占位） */
export function initialCardFocus(): CardFocusState {
  return { index: 0, count: 0 };
}

/** 卡内焦点环裁决（纯函数；无变化时恒返回原引用，便于接线层廉价判等） */
export function reduceCardFocus(state: CardFocusState, action: CardFocusAction): CardFocusState {
  switch (action.type) {
    case 'next': {
      if (state.count <= 0) return state; // 无元素可聚焦：恒等
      return { ...state, index: (state.index + 1) % state.count };
    }
    case 'prev': {
      if (state.count <= 0) return state;
      return { ...state, index: (state.index - 1 + state.count) % state.count };
    }
    case 'reset': {
      // 非法/空 count 一律钳为无元素态（index=0）；负数/小数不进环
      const count = Number.isInteger(action.count) && action.count > 0 ? action.count : 0;
      return { index: 0, count };
    }
    case 'escape':
      return state; // G-25 负向规则：Esc 不动卡内焦点（Esc 语义归 esc-machine）
  }
}

/**
 * 键 → 卡内焦点动作桥接（G-25 只认 Tab/Shift+Tab；↑/↓、数字直选等是接线层卡片键位，
 * 不在本环语义内）。其余键返回 null（含 Esc——语义归 esc-machine，见上）。
 */
export function cardFocusActionFromKey(
  key: string,
  modifiers: { readonly shift: boolean; readonly alt: boolean; readonly ctrl: boolean },
): CardFocusAction | null {
  if (key === 'tab' && !modifiers.ctrl && !modifiers.alt) {
    return modifiers.shift ? { type: 'prev' } : { type: 'next' };
  }
  return null;
}

/**
 * G-25 接缝谓词：卡片打开期全局焦点环挂起（接线层据此决定 Tab 走卡内环、
 * 跳过 input/focus.ts 的 reduceFocus；卡片退完返回 false，全局环恢复）。
 */
export function globalFocusSuspended(active: unknown): boolean {
  return active !== null && active !== undefined;
}
