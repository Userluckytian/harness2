// app-shared（桌面**组装根**）：把桌面桥 `window.harness2` 注入共享应用壳。
//
// 实现已下沉 `@harness2/ui-shared`（store / controller / 端口 / 订阅 Hook）；本文件只做两件事：
//   1. 用**桌面**的端口实现装配单例（store + controller + useAppState）；
//   2. 对外保持既有导出面（`./app-shared.js` 是桌面几十个文件的既有引用路径）。
// 旧分栏（pane）相关的兼容导出保留：调用点已随三栅拆除清零，仅为对外导出面兼容。
import { THEME_CYCLE, createAppShell, sessionTitle, StatusBadge } from '@harness2/ui-shared/renderer/app-shell.js';
import type { AppState } from '@harness2/ui-shared/renderer/store.js';

export { THEME_CYCLE, StatusBadge, sessionTitle };

/** 拖拽载荷：jsdom 无 dataTransfer，模块级回退（优先 dataTransfer）。
 * @deprecated P4-C：分栏拖拽（旧 SessionList）已随三栅拆除，当前无调用点；保留仅为对外导出面兼容。 */
export const dragState: { sessionId: string | null } = { sessionId: null };

/** 桌面应用壳（store + controller + 状态订阅）：端口 = preload 暴露的 window.harness2 */
export const shell = createAppShell(window.harness2);
export const store = shell.store;
export const controller = shell.controller;
export const useAppState = shell.useAppState;

/** 点击会话时目标分栏：优先空栏，其次第一栏
 * @deprecated P4-C：分栏状态已无渲染出口（三栅取代分栏），无调用点；后台判定改看选中态。 */
export function targetPaneFor(state: AppState): number {
  const empty = state.layout.panes.findIndex((p) => p.sessionId === null);
  return empty >= 0 ? empty : 0;
}
