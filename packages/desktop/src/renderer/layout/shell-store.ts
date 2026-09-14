// 壳级内存仓库（主题 / 覆层开关）：进程内临时状态，不落盘（D-14 口径：几何与开合都不持久化）。
// 用 useSyncExternalStore 绑定 React；快照不可变，无变化时引用稳定（避免无意义重渲染）。
import { useSyncExternalStore } from 'react';

export interface ShellStore<T extends object> {
  getSnapshot(): Readonly<T>;
  subscribe(listener: () => void): () => void;
  /** 浅合并写入（值全等则不动快照、不通知） */
  patch(next: Partial<T>): void;
  /** 复位为初值（重挂载语义） */
  reset(): void;
}

export function createShellStore<T extends object>(initial: T): ShellStore<T> {
  let snapshot: Readonly<T> = Object.freeze({ ...initial });
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const l of [...listeners]) l();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    patch(next) {
      let changed = false;
      for (const [k, v] of Object.entries(next)) {
        if (snapshot[k as keyof T] !== v) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      snapshot = Object.freeze({ ...snapshot, ...next });
      emit();
    },
    reset() {
      snapshot = Object.freeze({ ...initial });
      emit();
    },
  };
}

/** 绑定仓库快照的 React hook */
export function useShellStore<T extends object>(store: ShellStore<T>): Readonly<T> {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
