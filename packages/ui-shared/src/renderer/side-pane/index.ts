// side-pane 导出面（Z2-04 右栏标签体系）：
//   纯逻辑（side-pane-model）—— tab 状态机：打开列表/顺序/激活/LRU 内存（不落盘，D-14）；
//   React 桥（side-pane-store）—— useSyncExternalStore 单例 + 订阅 Hook，宿主只做渲染接线。
//   Z2-08：后台任务 tab —— 纯逻辑（background-tasks-model：状态映射/排序/子会话关联）
//   + 面板本体（BackgroundTasksPane，数据源经壳注入）。
export * from './side-pane-model.js';
export * from './side-pane-store.js';
export * from './background-tasks-model.js';
export * from './BackgroundTasksPane.js';
// Z7：壳无关的右栏标签宿主（零 tab 启器 + 标签条 + 内容槽）——桌面 SidePanel 与 web 共用。
export { SidePaneHost, type SidePaneHostProps } from './SidePaneHost.js';
