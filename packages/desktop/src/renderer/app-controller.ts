// 控制器：把 window.harness2（preload 桥）的异步事件接到 store action 上。
// 纯逻辑（可注入假 api 单测）；React 组件只读 store + 调 controller 方法。
// 切换会话流程（多会话切换不断流核心路径）：subscribe → /events 全量重放（store 判重）
// → 后续增量由 WS 帧按 seq 去重追加；后台会话的帧持续缓冲进各自 SessionStream。
import type { Harness2Api } from '../shared/protocol.js';
import type { AppStore } from './store.js';

export interface Controller {
  start(): () => void;
  refreshSessions(): Promise<void>;
  newSession(): Promise<void>;
  selectSession(id: string): Promise<void>;
  replaySession(id: string): Promise<void>;
  sendMessage(id: string, text: string): Promise<void>;
  abort(id: string): Promise<void>;
  respondApproval(requestId: string, decision: 'allow' | 'deny'): Promise<void>;
  /** 启动时读取持久化布局（~/.harness2/desktop-layout.json 经主进程） */
  initLayout(): Promise<void>;
  /** 分栏数变化 / 会话分配：更新 store 并持久化；绑定的会话自动订阅+重放 */
  setPaneCount(count: number): Promise<void>;
  assignToPane(paneIndex: number, sessionId: string | null): Promise<void>;
}

export function createController(store: AppStore, api: Harness2Api): Controller {
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
      // 事件通道未连接：主进程重连后渲染端会重新 select（重放兜底）
    }
  };

  const replaySession = async (id: string): Promise<void> => {
    try {
      store.applyReplay(await api.events(id));
    } catch {
      // 会话可能刚被并发创建（服务端尚未可见）：保持缓冲，等增量
    }
  };

  const persistLayout = async (): Promise<void> => {
    try {
      await api.saveLayout(store.getState().layout);
    } catch {
      // 持久化失败不影响使用
    }
  };

  return {
    start(): () => void {
      const statusUnsub = api.onConnectionStatus((status, detail) => {
        store.applyStatus(status, detail);
        if (status === 'connected') void refreshSessions();
      });
      const eventUnsub = api.onEvent((frame) => store.applyFrame(frame));
      void refreshSessions();
      return () => {
        statusUnsub();
        eventUnsub();
      };
    },
    refreshSessions,
    async newSession(): Promise<void> {
      const created = await api.createSession(); // cwd 由主进程补齐（渲染进程零 Node/零文件系统）
      await subscribeSession(created.id);
      await refreshSessions();
      store.select(created.id);
      await replaySession(created.id);
    },
    async selectSession(id: string): Promise<void> {
      await subscribeSession(id);
      store.select(id);
      await replaySession(id); // 切换 = 全量重放（含 active 标记），随后增量按 seq 去重接入
    },
    replaySession,
    async sendMessage(id: string, text: string): Promise<void> {
      store.markSending(id);
      try {
        await api.sendMessage(id, text);
      } catch (e) {
        store.clearRunning(id);
        store.applyFrame({ type: 'error', error: (e as Error).message });
      }
    },
    async abort(id: string): Promise<void> {
      try {
        await api.abort(id);
      } catch {
        // 通道未连接：无可取消的运行中 turn
      }
    },
    async respondApproval(requestId: string, decision: 'allow' | 'deny'): Promise<void> {
      try {
        await api.respondApproval(requestId, decision);
      } finally {
        store.removeApproval(requestId);
      }
    },
    async initLayout(): Promise<void> {
      try {
        store.applyLayout((await api.loadLayout()) as Parameters<AppStore['applyLayout']>[0]);
      } catch {
        // 布局加载失败：保持默认
      }
    },
    async setPaneCount(count: number): Promise<void> {
      store.applyPaneCount(count);
      await persistLayout();
    },
    async assignToPane(paneIndex: number, sessionId: string | null): Promise<void> {
      store.assignToPane(paneIndex, sessionId);
      if (sessionId !== null) {
        await subscribeSession(sessionId);
        await replaySession(sessionId);
      }
      await persistLayout();
    },
  };
}
