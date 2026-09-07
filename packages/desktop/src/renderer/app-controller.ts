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
  /** 启动时读取会话展示态覆层（~/.harness2/desktop-metadata.json；重命名/归档的展示源） */
  initMetadata(): Promise<void>;
  /** 重命名会话（仅展示态 title 覆层，不碰事件日志）；返回新覆层整体 */
  renameSession(id: string, title: string): Promise<void>;
  /** 归档/恢复（archived 覆盖层软删除；数据仍在，可随时恢复） */
  archiveSession(id: string, archived: boolean): Promise<void>;
  /** 物理删除（serve 无 delete API；本轮 = 覆层 deleted 标记 + 从侧栏移除，不伪造删除） */
  deleteSession(id: string): Promise<void>;
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
      // 主动查询一次当前状态：onConnectionStatus 只订阅，可能错过启动前已发出的 connected
      // （2026-09-07 修复：新建会话按钮 disabled={status!=='connected'}，状态竞态会导致永远灰着）
      void api.getStatus().then((s) => {
        store.applyStatus(s.status, s.detail);
        if (s.status === 'connected') void refreshSessions();
      }).catch(() => {
        // 通道尚未就绪：等 onConnectionStatus 事件补齐
      });
      void refreshSessions();
      return () => {
        statusUnsub();
        eventUnsub();
      };
    },
    refreshSessions,
    async newSession(): Promise<void> {
      try {
        const created = await api.createSession(); // cwd 由主进程补齐（渲染进程零 Node/零文件系统）
        await subscribeSession(created.id);
        await refreshSessions();
        store.select(created.id);
        await replaySession(created.id);
        // 自动打入首个空分栏：否则只出现在侧栏，用户会感觉「新建没反应」
        // （2026-09-07 用户报告：点新建无变化）
        const empty = store.getState().layout.panes.findIndex((p) => p.sessionId === null);
        store.assignToPane(empty >= 0 ? empty : 0, created.id);
        await persistLayout();
      } catch (e) {
        // 避免「点击无反应」：失败也反馈到状态栏（此前为未处理 rejection）
        store.applyFrame({ type: 'error', error: (e as Error).message });
      }
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
    async initMetadata(): Promise<void> {
      try {
        store.applyMetadata(await api.metadataGet());
      } catch {
        // 覆层加载失败：保持空（回退默认展示）
      }
    },
    async renameSession(id: string, title: string): Promise<void> {
      store.updateMetadata(id, { title });
      try {
        // 磁盘为唯一事实源：写回后整体回读校准（含 normalize 丢弃的空 title 等边界）
        store.applyMetadata(await api.metadataSet(id, { title }));
      } catch (e) {
        store.applyFrame({ type: 'error', error: `重命名保存失败: ${(e as Error).message}` });
      }
    },
    async archiveSession(id: string, archived: boolean): Promise<void> {
      store.updateMetadata(id, { archived });
      try {
        store.applyMetadata(await api.metadataSet(id, { archived }));
      } catch (e) {
        store.applyFrame({ type: 'error', error: `归档保存失败: ${(e as Error).message}` });
      }
    },
    async deleteSession(id: string): Promise<void> {
      // 核实（2026-09-07）：serve API 无物理删除端点（core/src/server/http.ts route() 仅
      // GET/POST /api/sessions、GET events、POST fork/undo/redo）→ 如实降级：覆层 deleted
      // 标记（侧栏隐藏，数据保留）+ 从当前视图移除；**绝不伪造物理删除**（事件日志原样保留，
      // 如需物理清理走 serve 数据目录/CLI）。
      store.updateMetadata(id, { deleted: true });
      try {
        await api.metadataSet(id, { deleted: true });
      } catch (e) {
        store.applyFrame({ type: 'error', error: `删除标记保存失败: ${(e as Error).message}` });
      }
      store.removeSessionFromView(id);
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
