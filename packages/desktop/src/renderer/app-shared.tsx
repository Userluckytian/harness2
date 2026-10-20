// app-shared（桌面**组装根**）：把桌面桥 `window.harness2` 注入共享应用壳。
//
// 实现已下沉 `@harness2/ui-shared`（store / controller / 端口 / 订阅 Hook）；本文件只做两件事：
//   1. 用**桌面**的端口实现装配单例（store + controller + useAppState）；
//   2. 对外保持既有导出面（`./app-shared.js` 是桌面几十个文件的既有引用路径）。
// 旧分栏（pane）相关的兼容导出保留：调用点已随三栅拆除清零，仅为对外导出面兼容。
import { THEME_CYCLE, createAppShell, sessionTitle, StatusBadge } from '@harness2/ui-shared/renderer/app-shell.js';
import type { AppState } from '@harness2/ui-shared/renderer/store.js';
import type { FrameAction } from '@harness2/ui-shared/renderer/layout/frame-state.js';

export { THEME_CYCLE, StatusBadge, sessionTitle };

/** 拖拽载荷：jsdom 无 dataTransfer，模块级回退（优先 dataTransfer）。
 * @deprecated P4-C：分栏拖拽（旧 SessionList）已随三栅拆除，当前无调用点；保留仅为对外导出面兼容。 */
export const dragState: { sessionId: string | null } = { sessionId: null };

/** 桌面应用壳（store + controller + 状态订阅）：端口 = preload 暴露的 window.harness2 */
export const shell = createAppShell(window.harness2);
export const store = shell.store;
export const controller = shell.controller;
export const useAppState = shell.useAppState;

/**
 * 新建会话动作（Z2-04 / Z-13「新建任务会强制收起右栏」）。
 *
 * ZCode 侧语义：App.tsx 的 draftFocusVersion 触发新任务时强制收起 Side Pane。本仓没有
 * draftFocusVersion 钩子，`controller.newSession()` 是新建会话/新任务的唯一入口 ——
 * 故在动作层收口：三处调用点（浮层 New Task、左栏 New Task、命令面板「新建会话」）
 * 统一走这里，**先**派发 `rightbar/collapse`（幂等，帧侧纯 reducer）再建会话；
 * 新会话的 tab 桶本就是空的，重开右栏即见「打开标签页」启动器（与 ZCode 一致）。
 *
 * Z-48：`cwd` 透传给 controller.newSession（「在此项目新建会话」带项目目录）；
 * 缺省 = 主进程默认根（顶部「+」/Ctrl+N/命令面板维持空白新会话，行为不变）。
 */
export function newSessionCollapsingRightbar(dispatch: (action: FrameAction) => void, cwd?: string): void {
  dispatch({ type: 'rightbar/collapse' });
  void controller.newSession(cwd);
}

/** 点击会话时目标分栏：优先空栏，其次第一栏
 * @deprecated P4-C：分栏状态已无渲染出口（三栅取代分栏），无调用点；后台判定改看选中态。 */
export function targetPaneFor(state: AppState): number {
  const empty = state.layout.panes.findIndex((p) => p.sessionId === null);
  return empty >= 0 ? empty : 0;
}
