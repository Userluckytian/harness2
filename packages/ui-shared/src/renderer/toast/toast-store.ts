// 全局 Toast 通知的**壳无关数据源**（纯 TS，无 React、无壳全局对象）。
//
// 为什么要模块单例而非 React Context：真实使用点散落在 React 组件之外（如 controller
// 的异步失败分支、桌面 composer 配置桥），这些位置拿不到 React 树；Context Provider 方案
// 无法覆盖。模块单例 + `useSyncExternalStore` 让「任意位置 toast(...)」与「壳覆层里的
// ToastHost 渲染」解耦：谁都能发，宿主只负责订阅渲染。
//
// 行为约定（见交付报告）：
//   * 默认自动消失 4000ms；显式 `timeoutMs <= 0` 常驻；
//   * **error 类默认常驻不自动消失**——失败要让用户看见，误删则用户可能错过；
//   * 多条堆叠（数组按入队顺序），可手动逐条关闭。
import type { ToastKind } from '../../components/ui/toast.js';

export type { ToastKind };

/** 默认自动消失时长（info / success）。 */
export const TOAST_DEFAULT_TIMEOUT_MS = 4000;

export interface ToastInput {
  readonly kind: ToastKind;
  /** 主文案（必填、非空才值得提示）。 */
  readonly message: string;
  /** 补充说明（可选，如实描述原因/引用）。 */
  readonly detail?: string;
  /**
   * 自动消失毫秒数。省略时按 kind 取默认（info/success 4000，error 常驻）；
   * `<= 0` 表示常驻、只能手动关闭。
   */
  readonly timeoutMs?: number;
}

export interface ToastItem extends ToastInput {
  readonly id: string;
}

type Listener = () => void;

class ToastStore {
  private items: readonly ToastItem[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = 0;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** useSyncExternalStore 快照：未变更时引用稳定（仅在入队/出队时替换数组）。 */
  getSnapshot = (): readonly ToastItem[] => this.items;

  /** 入队一条通知，返回其 id（供调用方提前关闭）。 */
  toast = (input: ToastInput): string => {
    const id = `toast-${(this.seq += 1).toString(36)}`;
    const item: ToastItem = { id, ...input };
    this.items = [...this.items, item];
    this.emit();
    const timeout = input.timeoutMs ?? (input.kind === 'error' ? 0 : TOAST_DEFAULT_TIMEOUT_MS);
    if (timeout > 0) {
      const timer = setTimeout(() => {
        this.timers.delete(id);
        this.dismiss(id);
      }, timeout);
      this.timers.set(id, timer);
    }
    return id;
  };

  dismiss = (id: string): void => {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    if (!this.items.some((it) => it.id === id)) return;
    this.items = this.items.filter((it) => it.id !== id);
    this.emit();
  };

  /** 清空全部（含定时器）；测试与「重置」场景用。 */
  clear = (): void => {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.items.length === 0) return;
    this.items = [];
    this.emit();
  };

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export const toastStore = new ToastStore();

/** 壳无关便捷入口：任意位置 `toast({ kind: 'error', message: '…' })`。 */
export function toast(input: ToastInput): string {
  return toastStore.toast(input);
}
