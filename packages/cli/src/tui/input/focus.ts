// focus.ts — P2-B：焦点环纯状态机（G-08）。
//
// 规格依据：docs/refs/refs-grok-build.md G-08——
//   `Tab` 在 prompt / scrollback 间切换；simple 下 `Space` 亦可，vim 下 `i` 回输入；
//   **`Esc` 不是焦点键**。
//
// 设计：
//  - 两态 {prompt, scrollback} 的纯 reducer（不可变返回，headless 可测、零依赖）；
//  - 与键位表的分工：keymaps.ts 负责「哪个键算焦点动作」（simple Space / vim i 的模式
//    差异在表里），本模块只裁决动作对状态的影响——focusActionFromKey 做桥接；
//  - **Esc 负向规则**：reduceFocus 对 {type:'escape'} 恒等返回（负向断言有专测）。
//    Esc 的全部语义（G-14～G-20）归 esc-machine.ts，与焦点切换零交集；G-20 的
//    「退到最后 park 到 scrollback」由 esc-machine 产出 side effect 后经 {type:'park'} 落地。
//  - 阻塞卡片接管期（G-21～G-25）焦点归卡片内环（Tab/Shift+Tab 卡内走，不泄漏到全局），
//    本状态机此时不应被调用（接线层职责）；{type:'park'} 是卡片退完后重新进入全局环的入口。

/** 焦点窗格：prompt = 输入框；scrollback = 滚动转录区 */
export type FocusPane = 'prompt' | 'scrollback';

export interface FocusState {
  readonly pane: FocusPane;
}

/** 焦点动作（与具体按键解耦；键 → 动作的映射见 keymaps.ts + focusActionFromKey） */
export type FocusAction =
  /** Tab：两态双向切换（G-08） */
  | { readonly type: 'toggle' }
  /** 回输入框：simple Space / vim i（G-08；仅 scrollback 起始有意义，prompt 起始为恒等） */
  | { readonly type: 'to-prompt' }
  /** Esc：**恒 no-op**——Esc 不是焦点键（G-08 负向规则；占位以显式表达「收到了但不理」） */
  | { readonly type: 'escape' }
  /** 卡片退完后的 park（G-20）：焦点停到 scrollback 并给提示（提示文案由装配层出） */
  | { readonly type: 'park' };

/** 初始焦点（应用启动 = prompt） */
export function initialFocusState(pane: FocusPane = 'prompt'): FocusState {
  return { pane };
}

/** 焦点环裁决（纯函数；恒返回新对象，绝不原地改写） */
export function reduceFocus(state: FocusState, action: FocusAction): FocusState {
  switch (action.type) {
    case 'toggle':
      return { pane: state.pane === 'prompt' ? 'scrollback' : 'prompt' };
    case 'to-prompt':
      return { pane: 'prompt' };
    case 'escape':
      // G-08 负向规则：Esc 不是焦点键。任何情况下 Esc 都不改变焦点——
      // 即使未来有人把 escape 误接进焦点层，这里也兜底为恒等。
      return state;
    case 'park':
      return { pane: 'scrollback' };
  }
}

/** 键 → 焦点动作的桥接（模式差异由 keymaps.ts 表驱动；Esc 在表外，本函数不认识它）。
 * @returns 对应动作；非焦点键返回 null（含 Esc——Esc 的焦点语义不存在） */
export function focusActionFromKey(
  mode: 'simple' | 'vim',
  key: string,
  modifiers: { shift: boolean; alt: boolean; ctrl: boolean },
): FocusAction | null {
  if (key === 'tab' && !modifiers.shift && !modifiers.ctrl && !modifiers.alt) return { type: 'toggle' };
  // 模式键只在 scrollback 起始时才有焦点语义（prompt 侧 Space 是空格、vim i 是字符）；
  // 起始窗格的判定是接线层职责，本函数只按模式给「候选动作」。
  if (mode === 'simple' && key === ' ' && !modifiers.shift && !modifiers.ctrl && !modifiers.alt) {
    return { type: 'to-prompt' };
  }
  if (mode === 'vim' && key === 'i' && !modifiers.shift && !modifiers.ctrl && !modifiers.alt) {
    return { type: 'to-prompt' };
  }
  return null;
}
