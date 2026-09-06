// 渲染端全局类型：window.harness2 由 preload 的 contextBridge 注入。
import type { Harness2Api } from '../shared/protocol.js';

declare global {
  interface Window {
    harness2: Harness2Api;
  }
}

export {};
