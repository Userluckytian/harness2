// @harness2/ui-shared —— 壳层共享呈现包（desktop / web 共用）。
//
// 内容：宿主无关的 React 组件 + 纯 TS 模型 + 端口接口。子路径导入亦受支持
// （如 `@harness2/ui-shared/renderer/store.js`，见 package.json exports 通配）。
// 本文件只导出「壳的组装通常需要的东西」；细粒度符号请走子路径。
export * from './shared/protocol.js';
export * from './shared/ids.js';
export * from './shared/drafts.js';
export * from './shared/file-ref.js';
export * from './shared/layout.js';
export * from './shared/metadata.js';

export * from './renderer/app-shell.js';
export * from './renderer/app-controller.js';
export * from './renderer/chat-model.js';
export * from './renderer/delivery.js';
export * from './renderer/drafts-guard.js';
export * from './renderer/host-bridge.js';
export * from './renderer/ports.js';
export * from './renderer/store.js';
