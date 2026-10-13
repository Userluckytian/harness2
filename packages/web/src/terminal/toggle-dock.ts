// Z9-5：终端 dock 的开合触发（web 壳）。
//
// 与桌面同口径（见 desktop `renderer/terminal/toggle-dock.ts`）：中栏 `MainSeatView`
// （ui-shared/src/renderer/layout/frame-seat-views.tsx）自己持有终端面板开合 state，只经底部
// 开关按钮（`data-testid="terminal-toggle"`）暴露；ui-shared 未对外暴露 imperative 控制口，
// 且本批次边界不改 ui-shared/src。故 Ctrl+J 与命令面板「切换终端」的真实动作 = 触发同一个
// 开关按钮（等价用户点击），不新造第二套状态、不伪造「已切换」。
//
// 诚实性：开关只在终端席位已注册时渲染；未注册 / 未挂载 → 如实 no-op，不假装已开合。

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
