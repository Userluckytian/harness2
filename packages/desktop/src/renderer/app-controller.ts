// 控制器：把 window.harness2（preload 桥）的异步事件接到 store action 上。
// 纯逻辑（可注入假 api 单测）；React 组件只读 store + 调 controller 方法。
import type { Harness2Api } from '../shared/protocol.js';
import type { AppStore } from './store.js';

export function createController(store: AppStore, api: Harness2Api): {
  start(): () => void;
  refreshSessions(): Promise<void>;
  newSession(): Promise<void>;
  selectSession(id: string): Promise<void>;
} {
  let statusUnsub: (() => void) | null = null;
  let eventUnsub: (() => void) | null = null;

  const refreshSessions = async (): Promise<void> => {
    try {
      store.setSessions(await api.listSessions());
    } catch {
      // 服务未就绪：保持现有列表（断线角标已提示）
    }
  };

  const subscribeSession = async (id: string): Promise<void> => {
    try {
      await api.subscribe(id);
    } catch {
      // 事件通道未连接：主进程会在 serve 就绪后重连；此处容忍
    }
  };

  return {
    start(): () => void {
      statusUnsub = api.onConnectionStatus((status, detail) => {
        store.applyStatus(status, detail);
        if (status === 'connected') void refreshSessions();
      });
      eventUnsub = api.onEvent(() => {
        // Task 4 接入帧处理（delta/event/turn-end/approval）
      });
      void refreshSessions();
      return () => {
        statusUnsub?.();
        eventUnsub?.();
        statusUnsub = null;
        eventUnsub = null;
      };
    },
    refreshSessions,
    async newSession(): Promise<void> {
      const created = await api.createSession(); // cwd 由主进程补齐（渲染进程零 Node/零文件系统）
      await subscribeSession(created.id);
      await refreshSessions();
      store.select(created.id);
    },
    async selectSession(id: string): Promise<void> {
      await subscribeSession(id);
      store.select(id);
    },
  };
}
