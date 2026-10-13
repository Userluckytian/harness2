// Z9-5：终端 dock 的开合触发（桌面壳）。
//
// 背景（为什么是「点开关」而不是新状态）：中栏 `MainSeatView`（ui-shared/src/renderer/layout/
// frame-seat-views.tsx）自己持有 terminal 面板的开合 state，只经其底部的开关按钮
// （`data-testid="terminal-toggle"`，`aria-pressed` 反映开合）暴露给用户；ui-shared 未对外
// 暴露任何 imperative 控制口，而本批次边界**不改 ui-shared/src**。故 Ctrl+J 与命令面板
// 「切换终端」的真实动作 = 触发同一个开关按钮（等价用户点击），不新造第二套状态、
// 不伪造「已切换」。
//
// 诚实性：开关只在终端席位**已注册**时渲染（注册缝）；未注册 / 未挂载时本函数如实 no-op，
// 不抛错、不假装已开合。

/** 终端 dock 开关按钮的选择器（与 ui-shared 的 MainSeatView 契约逐字一致） */
const TERMINAL_TOGGLE_SELECTOR = '[data-testid="terminal-toggle"]';

/**
 * 触发终端面板开合（等价点击底部「终端」开关）。
 * @returns 是否命中开关（未注册终端席位 / 非 DOM 宿主 → false，如实）
 */
export function toggleTerminalDock(): boolean {
  if (typeof document === 'undefined') return false;
  const button = document.querySelector(TERMINAL_TOGGLE_SELECTOR);
  if (button instanceof HTMLElement) {
    button.click();
    return true;
  }
  return false;
}
