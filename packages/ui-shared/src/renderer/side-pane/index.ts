// side-pane 导出面（Z2-04 右栏标签体系）：
//   纯逻辑（side-pane-model）—— tab 状态机：打开列表/顺序/激活/LRU 内存（不落盘，D-14）；
//   React 桥（side-pane-store）—— useSyncExternalStore 单例 + 订阅 Hook，宿主只做渲染接线。
export * from './side-pane-model.js';
export * from './side-pane-store.js';
