// Z2-01b：窗口最大化状态的**进程内单例**（不落盘、不订阅第二个来源）。
// 两处消费者共读同一份：App 根容器（linux 最大化去圆角）与会话列头窗控图标。
// 来源 = 主进程 window-state 通道（win/linux 自绘窗控 / OS 级最大化都会推）；
// 缺通道（web / 旧夹具）时恒 false —— 不猜、不摆假状态。
import { useSyncExternalStore } from 'react';
import type { Harness2Api, WindowStateShape } from '../shared/protocol.js';

type WindowStatePort = Partial<Pick<Harness2Api, 'windowGetState' | 'onWindowState'>>;

let maximized = false;
const listeners = new Set<() => void>();
let initialized = false;

function setMaximized(next: boolean): void {
  if (next === maximized) return;
  maximized = next;
  for (const listener of listeners) listener();
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  if (typeof window === 'undefined') return;
  const api = (window as { harness2?: WindowStatePort }).harness2;
  if (api === undefined) return;
  if (typeof api.windowGetState === 'function') {
    void api
      .windowGetState()
      .then((state) => setMaximized(state.maximized))
      .catch(() => {});
  }
  if (typeof api.onWindowState === 'function') {
    api.onWindowState((state: WindowStateShape) => setMaximized(state.maximized));
  }
}

export function subscribeWindowMaximized(listener: () => void): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getWindowMaximized(): boolean {
  return maximized;
}

/** 窗口最大化状态（React 订阅；无通道时恒 false） */
export function useWindowMaximized(): boolean {
  return useSyncExternalStore(subscribeWindowMaximized, getWindowMaximized, getWindowMaximized);
}

/** 测试复位（模块级单例；仅测试用） */
export function resetWindowMaximizedForTest(): void {
  maximized = false;
  listeners.clear();
  initialized = false;
}
