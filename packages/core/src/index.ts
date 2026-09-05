// @harness2/core —— 会话内核（事件日志、投影、轨迹）+ agent loop + 工具系统 + Provider 缝。
export * from './session/types.js';
export * from './session/writer.js';
export * from './session/reader.js';
export * from './trajectory/view.js';
export * from './provider/types.js';
export * from './provider/mock.js';
export * from './config/index.js';
export * from './tools/types.js';
export * from './tools/registry.js';
export * from './tools/executor.js';
export * from './tools/predefined/index.js';
export * from './agent/types.js';
export * from './agent/loop.js';

export const CORE_VERSION = '0.1.0';

