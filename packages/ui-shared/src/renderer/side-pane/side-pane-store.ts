// 右栏标签体系的 React 桥（Z2-04）：把 side-pane-model 的纯操作包成
// useSyncExternalStore 可订阅的内存单例。桌面只做渲染接线；web 未来复用同一份。
// 存储 = 模块级 Map（进程内存），**不写 localStorage**（D-14），重启不保留（Z-13）。
import { useSyncExternalStore } from 'react';
import {
  closeAllSidePaneTabs,
  closeOtherSidePaneTabs,
  closeSidePaneTab,
  moveSidePaneTab,
  openSidePaneTab,
  activateSidePaneTab,
  sidePaneOf,
  type SidePaneMemory,
  type SidePaneSessionTabs,
  type SidePaneTabId,
} from './side-pane-model.js';

export interface SidePaneStore {
  /** 全量内存快照（不可变引用；无 mutation 时引用稳定，配 useSyncExternalStore） */
  getSnapshot(): SidePaneMemory;
  subscribe(listener: () => void): () => void;
  /** 打开（幂等：已开仅激活）并激活 */
  open(sessionId: string, tabId: SidePaneTabId): void;
  /** 关闭单个 tab（激活回落见 model） */
  close(sessionId: string, tabId: SidePaneTabId): void;
  /** 关闭其他（只留指定 tab） */
  closeOthers(sessionId: string, tabId: SidePaneTabId): void;
  /** 全部关闭（删桶，回启动器） */
  closeAll(sessionId: string): void;
  /** 激活已打开的 tab */
  activate(sessionId: string, tabId: SidePaneTabId): void;
  /** 拖拽排序（from → 落位后最终下标 to） */
  move(sessionId: string, fromIndex: number, toIndex: number): void;
}

/** 建一份标签内存（应用用模块单例；测试各自新建互不串扰） */
export function createSidePaneStore(): SidePaneStore {
  let memory: SidePaneMemory = new Map();
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const l of [...listeners]) l();
  };
  const apply = (next: SidePaneMemory): void => {
    if (next === memory) return; // 纯操作判等免渲染
    memory = next;
    emit();
  };
  return {
    getSnapshot: () => memory,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: (sessionId, tabId) => apply(openSidePaneTab(memory, sessionId, tabId)),
    close: (sessionId, tabId) => apply(closeSidePaneTab(memory, sessionId, tabId)),
    closeOthers: (sessionId, tabId) => apply(closeOtherSidePaneTabs(memory, sessionId, tabId)),
    closeAll: (sessionId) => apply(closeAllSidePaneTabs(memory, sessionId)),
    activate: (sessionId, tabId) => apply(activateSidePaneTab(memory, sessionId, tabId)),
    move: (sessionId, fromIndex, toIndex) => apply(moveSidePaneTab(memory, sessionId, fromIndex, toIndex)),
  };
}

/** 应用单例（右栏宿主与路由触发方共用同一条内存态） */
export const sidePaneStore: SidePaneStore = createSidePaneStore();

/** 订阅某会话桶的打开列表与激活 tab（无桶 = 空态，宿主据此显示启动器） */
export function useSidePaneTabs(sessionId: string): SidePaneSessionTabs {
  const memory = useSyncExternalStore(sidePaneStore.subscribe, sidePaneStore.getSnapshot, sidePaneStore.getSnapshot);
  return sidePaneOf(memory, sessionId);
}
