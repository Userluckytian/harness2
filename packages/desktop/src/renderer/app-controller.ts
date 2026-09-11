// 控制器：把 window.harness2（preload 桥）的异步事件接到 store action 上。
// 纯逻辑（可注入假 api 单测）；React 组件只读 store + 调 controller 方法。
// 切换会话流程（多会话切换不断流核心路径）：subscribe → /events 全量重放（store 判重）
// → 后续增量由 WS 帧按 seq 去重追加；后台会话的帧持续缓冲进各自 SessionStream。
import type { Harness2Api, MessageReferenceShape, SubmitIntentShape, WsFrame } from '../shared/protocol.js';
import { newCancelRequestId, newClientMessageId } from '../shared/ids.js';
import { decideUndo, summarizeUndoPreview } from './features/workspace/change-review-model.js';
import type { ActiveEvent } from './chat-model.js';
import type { AppStore } from './store.js';

export interface Controller {
  start(): () => void;
  /** 额外帧观察：App 侧副作用（如 B7 系统通知）不侵入 store；返回退订 */
  startObservingFrames(listener: (frame: WsFrame) => void): () => void;
  refreshSessions(): Promise<void>;
  newSession(): Promise<void>;
  selectSession(id: string): Promise<void>;
  replaySession(id: string): Promise<void>;
  sendMessage(id: string, text: string): Promise<void>;
  /** D1：submit 提交（幂等 clientMessageId；queue 进可见队列；结果经 submit-ack 帧收敛） */
  submitMessage(
    id: string,
    rawText: string,
    opts?: { intent?: SubmitIntentShape; references?: MessageReferenceShape[]; expectedTurnId?: string },
  ): Promise<{ clientMessageId: string }>;
  /** D3/D4：取消当前 turn（三态 ack；不把取消当 undo，不假报停止） */
  cancelTurn(id: string): Promise<void>;
  /** D3：取消任务（目标为 task id） */
  cancelTask(taskId: string): Promise<void>;
  /** D4：关窗口「请求停止并退出」→ 取消全部运行中工作（如实：这是请求，不是保证已停） */
  stopAll(): Promise<void>;
  /** D5：从既有会话分叉（不改原会话） */
  forkSession(id: string, atSeq?: number): Promise<void>;
  /** D4：重订阅（带水位回放 + 在途状态补齐） */
  resumeSession(id: string): Promise<void>;
  abort(id: string): Promise<void>;
  /** B5：撤销会话最近一次被快照追踪的修改（调用既有 api.undo；失败经 store.applyFrame 报错） */
  undoSession(id: string): Promise<void>;
  /** D5：undo 前比对（dryRun）；有外部冲突返回冲突项，UI 须显式决定后才真正 undo */
  undoWithGuard(
    id: string,
    opts?: { n?: number; decision?: 'abort' | 'overwrite' },
  ): Promise<{ blocked: boolean; externallyModified: number } | undefined>;
  respondApproval(requestId: string, decision: 'allow' | 'deny'): Promise<void>;
  /** D0：拉取 S7 只读契约（run-config / plan-state / execution-view / change-review） */
  refreshRunConfig(id: string): Promise<void>;
  refreshPlanState(id: string): Promise<void>;
  refreshExecutionViews(id: string): Promise<void>;
  refreshChangeReview(id: string): Promise<void>;
  /** D0：能力盘点（serve 就绪 + 实测端点缺失） */
  refreshCapabilities(id?: string): Promise<void>;
  /** 启动时读取持久化布局（~/.harness2/desktop-layout.json 经主进程） */
  initLayout(): Promise<void>;
  /** 启动时读取会话展示态覆层（~/.harness2/desktop-metadata.json；重命名/归档的展示源） */
  initMetadata(): Promise<void>;
  /** D1：读会话草稿（~/.harness2/desktop-drafts.json；按会话隔离） */
  initDrafts(): Promise<void>;
  /** D1：写单会话草稿（内存即时生效；落盘去抖合并，避免每个按键一次写盘） */
  setDraft(id: string, text: string): void;
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
  /** 订阅 start() 的帧监听集合：store 主消费 + App 副作用（B7 通知）一条通道转发 */
  const frameListeners = new Set<(frame: WsFrame) => void>();

  const dispatchFrame = (frame: WsFrame): void => {
    // B7 通知点击回传帧（本地产生，非服务帧）：聚焦窗口后跳转到对应会话。
    // 点击时窗口已被主进程 focus/restore，渲染端 selectSession 在已可见窗口内切换。
    // 该帧不回传 store（非会话数据帧）。
    if (frame.type === 'notify/click') {
      void selectSession(frame.sessionId);
      return;
    }
    store.applyFrame(frame);
    // D2/D5：turn 收尾后刷新命令日志与变更审查（真实归属数据来自 S7 只读端点）
    if (frame.type === 'turn-end') {
      void loadExecutionViews(frame.sessionId);
      void loadChangeReview(frame.sessionId);
      // D0/D4：子代理任务/队列在本轮内变化 → 重取权威状态（否则任务面板会一直空着）
      refreshAuthoritativeState(frame.sessionId);
    }
    for (const listener of [...frameListeners]) listener(frame);
  };

  // —— D0–D5：S7 只读契约加载（失败写 errors 如实显示，不静默吞） ——
  const loadRunConfig = async (id: string): Promise<void> => {
    try {
      store.setRunConfig(id, await api.runConfig(id));
    } catch (e) {
      store.setRunConfig(id, undefined, (e as Error).message);
    }
  };
  const loadPlanState = async (id: string): Promise<void> => {
    try {
      store.setPlanState(id, await api.planState(id));
    } catch (e) {
      store.setPlanState(id, undefined, (e as Error).message);
    }
  };
  const loadExecutionViews = async (id: string): Promise<void> => {
    try {
      store.setExecutionViews(id, await api.executionViews(id));
    } catch (e) {
      store.setExecutionViews(id, [], (e as Error).message);
    }
  };
  const loadChangeReview = async (id: string): Promise<void> => {
    try {
      store.setChangeReview(id, await api.changeReview(id));
    } catch (e) {
      store.setChangeReview(id, undefined, (e as Error).message);
    }
  };
  /** 切换/进入会话时拉齐四契约 */
  const refreshAllViews = (id: string): void => {
    void loadRunConfig(id);
    void loadPlanState(id);
    void loadExecutionViews(id);
    void loadChangeReview(id);
  };
  /** D0：能力盘点（serve 就绪或切换会话时刷新；失败保持上次结果，不伪造「全部可用」） */
  const loadCapabilities = async (id?: string): Promise<void> => {
    try {
      store.setCapabilities(await api.capabilities(id));
    } catch {
      // 探测失败：保持上次结果
    }
  };

  /**
   * D0/D4：重订阅，取**服务端权威**的在途 attempt / 任务 / 待批 / 队列。
   * 只在这几处触发（够用且不打扰后端）：
   *   - 切到某会话（进入视图即补齐真实状态）；
   *   - turn 收尾后（子代理任务/队列在这一轮里发生变化）；
   *   - 用户显式点「重订阅」。
   * 去抖 1s/会话：重连抖动时不至于打爆 serve；事件回放由 store 按 seq 去重，不会重复渲染。
   */
  const lastResumeAt = new Map<string, number>();
  const RESUME_MIN_INTERVAL_MS = 1000;
  const refreshAuthoritativeState = (id: string, force = false): void => {
    if (store.getState().status !== 'connected') return; // 未连接：发了也白发（等重连后再补）
    const now = Date.now();
    const prev = lastResumeAt.get(id) ?? 0;
    if (!force && now - prev < RESUME_MIN_INTERVAL_MS) return;
    lastResumeAt.set(id, now);
    const stream = store.peekStream(id);
    const lastSeq = stream?.lastSeq ?? 0;
    const epoch = (stream?.epoch ?? 0) + 1; // 新连接代次：旧 epoch 快照被 store 丢弃
    void api.resumeSubscription(id, lastSeq, epoch).catch(() => {
      // 通道未就绪/旧 serve：忽略（已发送的请求失败不影响本地状态）
    });
  };

  /** D3/D4：取消当前 turn（三态 ack；不把取消当 undo，不假报停止） */
  const cancelTurnLocal = async (id: string): Promise<void> => {
    const requestId = newCancelRequestId();
    const stream = store.peekStream(id);
    const turnId = stream !== undefined ? lastTurnIdOf(stream) : undefined;
    if (turnId === undefined) {
      // 无运行中 turn：仍要服务端明确结论；用 abort 语义兜底并如实记录
      try {
        await api.abort(id);
      } catch (e) {
        store.applyFrame({ type: 'error', error: `取消失败: ${(e as Error).message}` });
      }
      return;
    }
    try {
      await api.cancel({ requestId, target: { kind: 'turn', id: turnId } });
    } catch (e) {
      store.applyFrame({ type: 'error', error: `取消失败: ${(e as Error).message}` });
    }
  };
  /** D3：取消单个任务（目标 task id，不误伤兄弟） */
  const cancelTaskLocal = async (taskId: string): Promise<void> => {
    const requestId = newCancelRequestId();
    try {
      await api.cancel({ requestId, target: { kind: 'task', id: taskId } });
    } catch (e) {
      store.applyFrame({ type: 'error', error: `取消任务失败: ${(e as Error).message}` });
    }
  };
  /** D4：把运行态推给主进程（关窗口提示依据；fire-and-forget） */
  const pushBusy = (): void => {
    const counts = store.runtimeCounts();
    const busy = counts.runningTurns > 0 || counts.backgroundTasks > 0 || store.anyPendingApprovals();
    void api.setBusy(busy, counts).catch(() => {});
  };

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

  /** 切换会话并重放（notify/click 回传与命令面板共用） */
  const selectSession = async (id: string): Promise<void> => {
    await subscribeSession(id);
    store.select(id);
    await replaySession(id); // 切换 = 全量重放（含 active 标记），随后增量按 seq 去重接入
    // D0：切到该会话即拉齐只读契约（有效配置/计划/命令日志/变更审查）
    if (store.getState().status === 'connected') refreshAllViews(id);
    // D0/D4：取服务端权威在途状态（任务/待批/队列；重连恢复也靠它）
    refreshAuthoritativeState(id);
  };

  const persistLayout = async (): Promise<void> => {
    try {
      await api.saveLayout(store.getState().layout);
    } catch {
      // 持久化失败不影响使用
    }
  };

  /** D1：草稿落盘去抖（500ms 合并；关闭/切换期间不丢——内存即时生效，落盘尽力而为） */
  let draftsTimer: ReturnType<typeof setTimeout> | null = null;
  const persistDraftsSoon = (): void => {
    if (draftsTimer !== null) clearTimeout(draftsTimer);
    draftsTimer = setTimeout(() => {
      draftsTimer = null;
      void api.draftsSet(store.getState().drafts).catch(() => {});
    }, 500);
  };

  return {
    start(): () => void {
      const statusUnsub = api.onConnectionStatus((status, detail) => {
        store.applyStatus(status, detail);
        if (status === 'connected') {
          void refreshSessions();
          void loadCapabilities(store.getState().selectedId ?? undefined);
        }
      });
      const eventUnsub = api.onEvent((frame) => {
        dispatchFrame(frame);
      });
      // 主动查询一次当前状态：onConnectionStatus 只订阅，可能错过启动前已发出的 connected
      // （2026-09-07 修复：新建会话按钮 disabled={status!=='connected'}，状态竞态会导致永远灰着）
      void api
        .getStatus()
        .then((s) => {
          store.applyStatus(s.status, s.detail);
          if (s.status === 'connected') {
            void refreshSessions();
            void loadCapabilities();
          }
        })
        .catch(() => {
          // 通道尚未就绪：等 onConnectionStatus 事件补齐
        });
      void refreshSessions();
      // D0/F7：ack 丢失判定——提交后 5s 未收到 submit-ack → 标 unknown（不自动重发）
      const pendingTimer = setInterval(() => store.expirePendingSubmits(), 1000);
      // D4：运行态变化即上报主进程（关窗口提示依据）
      const storeUnsub = store.subscribe(pushBusy);
      pushBusy();
      return () => {
        clearInterval(pendingTimer);
        storeUnsub();
        statusUnsub();
        eventUnsub();
      };
    },
    startObservingFrames(listener: (frame: WsFrame) => void): () => void {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
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
    selectSession,
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
    async submitMessage(
      id: string,
      rawText: string,
      opts?: { intent?: SubmitIntentShape; references?: MessageReferenceShape[]; expectedTurnId?: string },
    ): Promise<{ clientMessageId: string }> {
      const clientMessageId = newClientMessageId();
      const intent: SubmitIntentShape = opts?.intent === 'steer' ? 'steer' : 'queue';
      // 本地先登记（可见队列 + pendingSubmits）；ack 到达或超时后收敛
      store.noteSubmit(id, { clientMessageId, rawText, intent });
      store.markSending(id);
      try {
        await api.submit({
          clientMessageId,
          sessionId: id,
          rawText,
          intent,
          ...(opts?.references !== undefined ? { references: opts.references } : {}),
          ...(opts?.expectedTurnId !== undefined ? { expectedTurnId: opts.expectedTurnId } : {}),
        });
      } catch (e) {
        // 发送通道失败：立即记 unknown（不重发），避免用户以为已提交
        store.applyFrame({
          type: 'submit-ack',
          clientMessageId,
          sessionId: id,
          state: 'unknown',
          reason: `提交未送达: ${(e as Error).message}`,
        });
      }
      return { clientMessageId };
    },
    cancelTurn: cancelTurnLocal,
    cancelTask: cancelTaskLocal,
    async stopAll(): Promise<void> {
      // 关窗口「请求停止并退出」：取消全部运行中 turn + 未终态任务。
      // 如实语义：这是**请求**；服务端确认前不宣称已停（cancel-ack 三态由 store 记录）。
      const runningIds = store.streamIds().filter((id) => store.peekStream(id)?.running === true);
      const cancelTasks = store
        .allTasks()
        .filter(
          ({ task }) =>
            task.state !== 'completed' &&
            task.state !== 'failed' &&
            task.state !== 'cancelled' &&
            task.state !== 'unknown',
        );
      await Promise.all([
        ...runningIds.map((id) => cancelTurnLocal(id)),
        ...cancelTasks.map(({ task }) => cancelTaskLocal(task.taskId)),
      ]);
    },
    async forkSession(id: string, atSeq?: number): Promise<void> {
      try {
        await api.fork(id, atSeq);
        // 分叉结果经 'forked' 帧回传；新会话出现在列表，等待用户主动切换（不改原会话）
        await refreshSessions();
      } catch (e) {
        store.applyFrame({ type: 'error', error: `分叉失败: ${(e as Error).message}` });
      }
    },
    async resumeSession(id: string): Promise<void> {
      // 与自动重订阅共用一条路径（同一 epoch 语义，避免双路径各推一次 epoch 导致快照被判陈旧）
      refreshAuthoritativeState(id, true);
    },
    async undoWithGuard(
      id: string,
      opts?: { n?: number; decision?: 'abort' | 'overwrite' },
    ): Promise<{ blocked: boolean; externallyModified: number } | undefined> {
      try {
        // 1) dryRun 比对：外部改动不静默覆盖（F5 硬要求）
        const preview = await api.undo(id, {
          ...(opts?.n !== undefined ? { n: opts.n } : {}),
          dryRun: true,
        });
        const summary = summarizeUndoPreview(preview);
        const verdict = decideUndo(summary, opts?.decision);
        if (!verdict.proceed) {
          return { blocked: true, externallyModified: summary.externallyModified };
        }
        // 2) 用户显式决定后（或本就无冲突）才真正恢复
        await api.undo(id, {
          ...(opts?.n !== undefined ? { n: opts.n } : {}),
        });
        await refreshSessions();
        return { blocked: false, externallyModified: summary.externallyModified };
      } catch (e) {
        store.applyFrame({ type: 'error', error: `撤销失败: ${(e as Error).message}` });
        return undefined;
      }
    },
    refreshRunConfig: loadRunConfig,
    refreshPlanState: loadPlanState,
    refreshExecutionViews: loadExecutionViews,
    refreshChangeReview: loadChangeReview,
    refreshCapabilities: loadCapabilities,
    async undoSession(id: string): Promise<void> {
      try {
        await api.undo(id);
        // undo 后事件流会收到 rewind 标记（applyFrame 重折叠），无需手动刷新；
        // 仅确保会话列表元数据（mtime/条数）与磁盘一致（尽力而为）
        await refreshSessions();
      } catch (e) {
        store.applyFrame({ type: 'error', error: `撤销失败: ${(e as Error).message}` });
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
    async initDrafts(): Promise<void> {
      try {
        store.applyDrafts(await api.draftsGet());
      } catch {
        // 草稿加载失败：保持空（不影响发送）
      }
    },
    setDraft(id: string, text: string): void {
      store.setDraft(id, text);
      persistDraftsSoon();
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

/** 事件流里最后一个 turnId（与 store 内部口径一致；取消目标定位用） */
function lastTurnIdOf(stream: { events: readonly ActiveEvent[] }): string | undefined {
  for (let i = stream.events.length - 1; i >= 0; i--) {
    const p = stream.events[i]!.payload as Record<string, unknown>;
    const t = p['turnId'];
    if (typeof t === 'string' && t.length > 0) return t;
  }
  return undefined;
}
