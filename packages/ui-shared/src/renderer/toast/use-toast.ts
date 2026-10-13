// Toast 的 React 绑定（hook 层）。
//
// 数据源是模块单例（toast-store），故 hook 只做订阅/取用，不引入 Provider：
// 组件树任意深度都能 `useToast()`；非 React 代码直接 `import { toast }`。
import { useSyncExternalStore } from 'react';
import { toastStore, type ToastInput, type ToastItem } from './toast-store.js';

export interface UseToastResult {
  /** 入队一条通知，返回 id。 */
  toast: (input: ToastInput) => string;
  /** 手动关闭指定通知。 */
  dismiss: (id: string) => void;
}

export function useToast(): UseToastResult {
  // toastStore.toast / dismiss 是稳定引用（类字段箭头函数），无需 memo。
  return { toast: toastStore.toast, dismiss: toastStore.dismiss };
}

/** 订阅当前通知列表（供 ToastHost 渲染）。 */
export function useToastItems(): readonly ToastItem[] {
  return useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getSnapshot);
}
