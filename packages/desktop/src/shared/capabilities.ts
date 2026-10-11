// 能力盘点纯逻辑（D0）已下沉 `@harness2/ui-shared/shared/capabilities.js`（web 壳同一份）。
// 本文件只做**再导出**，既有 `from '../shared/capabilities.js'` 的引用面（main/bridge、
// renderer/runtime-status、测试）保持不变；不保留第二份实现。
export * from '@harness2/ui-shared/shared/capabilities.js';
