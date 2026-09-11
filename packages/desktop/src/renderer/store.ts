// 渲染端状态仓库：纯 TS（不依赖 React/DOM），React 组件经 useSyncExternalStore 订阅。
// 状态只由 store action 修改；controller（app-controller.ts）负责把 window.harness2 的
// 异步事件接到 action 上。单测直接驱动 action。
//
// 多会话"切换不断流"核心：每个会话独立 SessionStream 缓冲（事件 + 在途 delta + 审批 +
// 未读计数），与是否正在渲染无关；切换会话 = 选中 id 变化 + 必要时全量重放（store 自动判重）。
import type {
  AttemptSnapshotShape,
  CancelAckStateShape,
  CapabilityReportShape,
  ChangeSetShape,
  ConnectionStatus,
  EffectiveRunConfigShape,
  PlanStateShape,
  QueueEntryShape,
  SessionEventShape,
  SessionSummaryShape,
  SessionEventsPayloadShape,
  StatusDetail,
  SubmitAckStateShape,
  TaskContractShape,
  ToolExecutionViewShape,
  WsFrame,
} from '../shared/protocol.js';
import { acceptDelta, type DeltaWatermark } from './delivery.js';
import { getDraftValue, normalizeDrafts, setDraftValue, type DraftsMap } from '../shared/drafts.js';
import type { FileRefSkipReason, FileRefSource } from '../shared/file-ref.js';
import * as layoutFns from '../shared/layout.js';
import {
  assignSession as assignPaneInLayout,
  boundSessionIds,
  defaultLayout,
  normalizeLayout,
  type DesktopLayout,
} from '../shared/layout.js';
import {
  applyEvent,
  emptyLive,
  mergeReplay,
  projectChatItems,
  type ActiveEvent,
  type ChatItem,
  type LiveDelta,
  type TurnEndInfo,
} from './chat-model.js';
import {
  normalizeMetadata,
  displayTitle,
  isArchived,
  type SessionMetadataEntry,
  type SessionMetadataMap,
} from '../shared/metadata.js';

export interface SessionMeta {
  id: string;
  cwd?: string;
  mtimeMs: number;
  firstUserText: string;
  messageCount: number;
  lastSeq: number;
}

/** 提交的本地在途记录（ack 未到；丢失时标 unknown，绝不自动重发） */
export interface PendingSubmit {
  clientMessageId: string;
  rawText: string;
  intent: 'queue' | 'steer';
  ts: number;
}

/** 单会话流缓冲（渲染与缓冲解耦：后台会话只记事件不渲染） */
export interface SessionStream {
  id: string;
  events: ActiveEvent[];
  lastSeq: number;
  live: LiveDelta;
  /** turnId → turn 终态（stopReason/error/warning；来自 turn-end 帧） */
  turnEnds: Record<string, TurnEndInfo>;
  /** 正在发消息/等 turn（乐观置位，turn-end 清除） */
  running: boolean;
  /** 非当前视图期间新增的落盘事件数（后台徽标，视图聚焦时清零） */
  unread: number;
  /** 待审批（requestId → 卡片全量字段；含 scope/expiresAt/taskId 供审批中心分组） */
  approvals: Array<{
    requestId: string;
    tool: string;
    args: unknown;
    scope?: 'once' | 'session';
    expiresAt?: string;
    cwd?: string;
    taskId?: string;
    parentTaskId?: string;
  }>;
  /** 历史加载完成（首次重放成功后 true；未加载前渲染加载态） */
  loaded: boolean;
  // —— D0：S0/S3 契约状态（带水位 delta / attempt / 队列 / 任务 / 取消 / 重订阅） ——
  /** 带水位 delta 的连续性水位（attemptId → text/reasoning 各自水位） */
  watermarks: Record<string, { text?: DeltaWatermark; reasoning?: DeltaWatermark }>;
  /** 当前正在流式的 attemptId（新 attempt 开始时重置在途文本） */
  liveAttemptId?: string;
  /** attempt 终态（attemptId → 终态与半截文本；P3-b 展示标注用） */
  attempts: Record<string, { turnId: string; state: string; finalText?: string; error?: string }>;
  /** 待确认提交（clientMessageId → 本地在途；ack 丢失 → unknown，不重复提交） */
  pendingSubmits: Record<string, PendingSubmit>;
  /** submit-ack 结论（clientMessageId → ack；unknown ≠ rejected） */
  submitAcks: Record<string, { state: SubmitAckStateShape; reason?: string; queueSeq?: number }>;
  /** 服务端可见队列（submit-ack / resume-snapshot 同步；重启恢复默认 paused） */
  queue: QueueEntryShape[];
  /** 任务表（resume-snapshot 同步；D3 计划/任务面板） */
  tasks: TaskContractShape[];
  /** 连接代次（resume-subscription 携带；旧 epoch 快照丢弃） */
  epoch: number;
  /** 最近一次重订阅快照的回放区间 */
  resume?: { fromSeq: number; toSeq: number; at: number };
  /** 重连快照里的在途 attempt（D4 据此展示「仍在跑」而非永久 loading） */
  activeAttempt?: AttemptSnapshotShape;
  /** 分叉来源（forked 帧；原会话不变） */
  forkedFrom?: string;
  /** 记忆复盘（nudge）状态：运行中 + 最近一次结论 */
  nudge: {
    running: boolean;
    last?: { stopReason: string; toolCalls: number; staged: number; error?: string };
  };
}

/** 单会话的只读查询结果缓存（S7 四契约 + 能力盘点；面板渲染数据源） */
export interface SessionViews {
  runConfig?: EffectiveRunConfigShape;
  /** null = 会话暂无计划数据（非错误） */
  planState?: PlanStateShape | null;
  executionViews: ToolExecutionViewShape[];
  changeReview?: ChangeSetShape;
  capabilities?: CapabilityReportShape;
  /** 各查询的错误文案（失败时如实显示，不静默吞） */
  errors: Partial<Record<'runConfig' | 'planState' | 'executionViews' | 'changeReview', string>>;
}

export interface AppState {
  /** 通知版本号：流缓冲（streams Map）不在 AppState 里，版本号保证 notify 总产生新快照 */
  rev: number;
  status: ConnectionStatus;
  statusDetail?: StatusDetail;
  sessions: SessionMeta[];
  selectedId: string | null;
  /** 分屏布局（1..3 栏；渲染端唯一事实来自这里，持久化经主进程落盘） */
  layout: DesktopLayout;
  /** 会话展示态覆层（B3：desktop-metadata.json；title/archived 覆盖层，不碰事件日志） */
  metadata: SessionMetadataMap;
  /** 能力盘点结果（D0；无后端能力如实 disabled + 解释，不摆假入口） */
  capabilities?: CapabilityReportShape;
  /** 取消三态 ack（requestId 全局唯一 → 全局表；UI 立即展示 stopping，unknown 不假报停止） */
  cancelAcks: Record<string, CancelAckStateShape>;
  /** 会话草稿（D1：sessionId → 原始输入；按会话隔离，A/B 项目不串） */
  drafts: DraftsMap;
}

export function initialState(): AppState {
  return {
    rev: 0,
    status: 'connecting',
    sessions: [],
    selectedId: null,
    layout: defaultLayout(),
    metadata: {},
    cancelAcks: {},
    drafts: {},
  };
}

/** 本轮 @引用 的来源报告（D1：引用来源可见——哪些进了上下文、哪些被拒及原因） */
export interface RefReport {
  sources: FileRefSource[];
  skipped: Array<{ token: string; reason: FileRefSkipReason }>;
  notFound: string[];
}

export class AppStore {
  private state: AppState = initialState();
  private readonly listeners = new Set<() => void>();
  private readonly streams = new Map<string, SessionStream>();
  /** 只读查询缓存（S7 契约；不进 AppState，读经 peekViews，变更经 notify 触发渲染） */
  private readonly views = new Map<string, SessionViews>();
  /** @引用 来源报告（D1；不进 AppState，读经 peekRefReport） */
  private readonly refReports = new Map<string, RefReport>();

  // —— D1：会话草稿（按会话隔离；持久化由 controller 落主进程 desktop-drafts.json） ——

  /** 整份应用草稿（drafts:get 响应）：normalize 后替换（磁盘为事实源） */
  applyDrafts(raw: unknown): void {
    this.set({ drafts: normalizeDrafts(raw) });
  }

  /** 写单会话草稿（内存即时生效；落盘由 controller 去抖合并） */
  setDraft(id: string, text: string): void {
    const next = setDraftValue(this.state.drafts, id, text);
    if (next === this.state.drafts) return;
    this.set({ drafts: next });
  }

  /** 取单会话草稿（无 → 空串） */
  draftFor(id: string): string {
    return getDraftValue(this.state.drafts, id);
  }

  /** 丢弃会话草稿（会话被物理移除时） */
  dropDraft(id: string): void {
    this.setDraft(id, '');
  }

  /** 写本轮 @引用 来源报告（发送前解析结果；UI 展示「引用来源」） */
  setRefReport(id: string, report: RefReport): void {
    this.refReports.set(id, report);
    this.notify();
  }

  /** 读最近一次 @引用 来源报告 */
  peekRefReport(id: string): RefReport | undefined {
    return this.refReports.get(id);
  }

  getState = (): AppState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    for (const l of [...this.listeners]) l();
  }

  /** 通知所有订阅者：bump rev 产生新 state 引用（useSyncExternalStore 靠引用比较触发渲染） */
  private notify(): void {
    this.state = { ...this.state, rev: this.state.rev + 1 };
    for (const l of [...this.listeners]) l();
  }

  // —— 会话列表 /选中/状态 ——

  applyStatus(status: ConnectionStatus, detail?: StatusDetail): void {
    this.set({
      status,
      ...(detail !== undefined || this.state.statusDetail !== undefined ? { statusDetail: detail } : {}),
    });
  }

  setSessions(sessions: SessionSummaryShape[]): void {
    const sorted = [...sessions].sort((a, b) => b.mtimeMs - a.mtimeMs);
    this.set({ sessions: sorted });
  }

  select(sessionId: string | null): void {
    const stream = sessionId !== null ? this.ensureStream(sessionId) : undefined;
    if (stream !== undefined && stream.unread > 0) {
      stream.unread = 0;
    }
    this.set({ selectedId: sessionId });
  }

  addSession(summary: SessionMeta): void {
    this.set({ sessions: [summary, ...this.state.sessions.filter((s) => s.id !== summary.id)] });
  }

  // —— 会话展示态覆层（B3：重命名/归档；纯内存 + 持久化经主进程 metadata:set） ——

  /** 应用整体覆层（metadata:get 响应）：normalize 后整份替换（磁盘是唯一事实源） */
  applyMetadata(raw: unknown): void {
    this.set({ metadata: normalizeMetadata(raw) });
  }

  /** 更新单条会话展示态（title/archived/deleted 字段级合并）；返回值供 controller 与磁盘回读对账 */
  updateMetadata(id: string, patch: { title?: string; archived?: boolean; deleted?: boolean }): void {
    const current = this.state.metadata[id] ?? {};
    const entry: SessionMetadataEntry = { ...current };
    if ('title' in patch) {
      const t = patch.title;
      if (typeof t === 'string' && t.trim().length > 0) entry.title = t.trim();
      else delete entry.title;
    }
    if ('archived' in patch) entry.archived = patch.archived === true;
    if ('deleted' in patch) entry.deleted = patch.deleted === true;
    const nextMetadata: SessionMetadataMap = { ...this.state.metadata };
    if (Object.keys(entry).length === 0)
      delete nextMetadata[id]; // 空条目不落盘
    else nextMetadata[id] = entry;
    this.set({ metadata: nextMetadata });
  }

  /** 取某会话展示标题（覆层 title 优先；无 → firstUserText 回落） */
  displayTitleFor(id: string): string | null {
    return displayTitle(this.state.metadata, id);
  }

  /** 某会话是否已归档（覆层判定） */
  isArchived(id: string): boolean {
    return isArchived(this.state.metadata, id);
  }

  /** 从当前视图移除会话（删除/归档隐藏的渲染端清理）：侧栏去项 + 分栏解绑 + 选中清理 */
  removeSessionFromView(id: string): void {
    this.set({
      sessions: this.state.sessions.filter((s) => s.id !== id),
      layout: { panes: this.state.layout.panes.map((p) => (p.sessionId === id ? { sessionId: null } : { ...p })) },
      ...(this.state.selectedId === id ? { selectedId: null } : {}),
    });
  }

  // —— 分屏布局 ——

  /** 应用外部布局（磁盘/IPC 未知来源）：normalizeLayout 统一校验，非法回落默认 */
  applyLayout(raw: unknown): void {
    this.set({ layout: normalizeLayout(raw) });
  }

  /** 改分栏数（1..3）：布局纯函数处理绑定去重/裁剪 */
  applyPaneCount(count: number): void {
    const { setPaneCount } = layoutFns;
    this.set({ layout: setPaneCount(this.state.layout, count) });
  }

  /** 拖拽/点击分配会话到分栏：清该会话未读（进入视野）；null = 清空该栏 */
  assignToPane(paneIndex: number, sessionId: string | null): void {
    const layout = assignPaneInLayout(this.state.layout, paneIndex, sessionId);
    if (sessionId !== null) {
      const stream = this.streams.get(sessionId);
      if (stream !== undefined) stream.unread = 0;
    }
    this.set({ layout });
  }

  /** 会话是否处于"后台"（已订阅但不在任何分栏、也非当前选中） */
  isBackground(id: string): boolean {
    if (this.state.selectedId === id) return false;
    return !boundSessionIds(this.state.layout).has(id);
  }

  // —— 会话流 ——

  private ensureStream(id: string): SessionStream {
    let s = this.streams.get(id);
    if (!s) {
      s = {
        id,
        events: [],
        lastSeq: 0,
        live: emptyLive(),
        turnEnds: {},
        running: false,
        unread: 0,
        approvals: [],
        loaded: false,
        watermarks: {},
        attempts: {},
        pendingSubmits: {},
        submitAcks: {},
        queue: [],
        tasks: [],
        epoch: 0,
        nudge: { running: false },
      };
      this.streams.set(id, s);
    }
    return s;
  }

  /** 只读查询缓存（不存在则建空壳；组件据此显示加载/空态） */
  private ensureViews(id: string): SessionViews {
    let v = this.views.get(id);
    if (!v) {
      v = { executionViews: [], errors: {} };
      this.views.set(id, v);
    }
    return v;
  }

  /** 只读视图缓存（S7 四契约）；返回引用，调用方不得改写 */
  peekViews(id: string): SessionViews | undefined {
    return this.views.get(id);
  }

  // —— D0：只读查询结果写入（controller 经 IPC 取回后调用） ——

  setRunConfig(id: string, view: EffectiveRunConfigShape | undefined, error?: string): void {
    const v = this.ensureViews(id);
    if (error !== undefined) v.errors.runConfig = error;
    else {
      delete v.errors.runConfig;
      v.runConfig = view;
    }
    this.notify();
  }

  setPlanState(id: string, plan: PlanStateShape | null | undefined, error?: string): void {
    const v = this.ensureViews(id);
    if (error !== undefined) v.errors.planState = error;
    else {
      delete v.errors.planState;
      v.planState = plan ?? null;
    }
    this.notify();
  }

  setExecutionViews(id: string, views: ToolExecutionViewShape[], error?: string): void {
    const v = this.ensureViews(id);
    if (error !== undefined) v.errors.executionViews = error;
    else {
      delete v.errors.executionViews;
      v.executionViews = views;
    }
    this.notify();
  }

  setChangeReview(id: string, set: ChangeSetShape | undefined, error?: string): void {
    const v = this.ensureViews(id);
    if (error !== undefined) v.errors.changeReview = error;
    else {
      delete v.errors.changeReview;
      v.changeReview = set;
    }
    this.notify();
  }

  /** 能力盘点（全局，不是 per-session） */
  setCapabilities(report: CapabilityReportShape): void {
    this.set({ capabilities: report });
  }

  capabilities(): CapabilityReportShape | undefined {
    return this.state.capabilities;
  }

  /** 只读流视图（不存在返回 undefined；组件据此显示加载态） */
  peekStream(id: string): SessionStream | undefined {
    return this.streams.get(id);
  }

  /** 已缓冲的会话 id 列表（后台会话也含；面板聚合展示用） */
  streamIds(): string[] {
    return [...this.streams.keys()];
  }

  /**
   * 全部会话的待审批卡片（F4：全部待批可见）。
   * 返回带 sessionId 的扁平列表；卡片字段全部来自服务端帧，不做本地推断。
   */
  allApprovals(): Array<{
    sessionId: string;
    requestId: string;
    tool: string;
    args: unknown;
    scope?: 'once' | 'session';
    expiresAt?: string;
    cwd?: string;
    taskId?: string;
    parentTaskId?: string;
  }> {
    const out: Array<{
      sessionId: string;
      requestId: string;
      tool: string;
      args: unknown;
      scope?: 'once' | 'session';
      expiresAt?: string;
      cwd?: string;
      taskId?: string;
      parentTaskId?: string;
    }> = [];
    for (const stream of this.streams.values()) {
      for (const a of stream.approvals) out.push({ sessionId: stream.id, ...a });
    }
    return out;
  }

  /** 全部会话的任务（含子会话；父子归属由 parentTaskId 表达） */
  allTasks(): Array<{ sessionId: string; task: TaskContractShape }> {
    const out: Array<{ sessionId: string; task: TaskContractShape }> = [];
    for (const stream of this.streams.values()) {
      for (const task of stream.tasks) out.push({ sessionId: stream.id, task });
    }
    return out;
  }

  /** 会话渲染条目（派生；含在途流式条目） */
  chatItems(id: string): ChatItem[] {
    const s = this.streams.get(id);
    if (!s) return [];
    return projectChatItems(s.events, s.live, s.turnEnds);
  }

  /** 最近一条落盘 assistant 正文（通知摘要数据源；无 assistant 消息返回 ''） */
  assistantText(id: string): string {
    const s = this.streams.get(id);
    if (!s) return '';
    for (let i = s.events.length - 1; i >= 0; i--) {
      const e = s.events[i]!;
      if (!e.active || e.type !== 'assistant/message') continue;
      const t = (e.payload as Record<string, unknown>)['text'];
      return typeof t === 'string' ? t : '';
    }
    return '';
  }

  /**
   * 切换/重放：GET /api/sessions/:id/events 的全量应用。
   * 与缓冲判重（mergeReplay）：陈旧响应（lastSeq 更小）不应用。
   */
  applyReplay(payload: SessionEventsPayloadShape): void {
    const stream = this.ensureStream(payload.id);
    const merged = mergeReplay(stream.lastSeq, payload);
    if (merged === null) return;
    stream.events = merged;
    stream.lastSeq = payload.lastSeq;
    stream.live = emptyLive();
    stream.loaded = true;
    if (this.state.selectedId === payload.id) stream.unread = 0;
    this.notify();
  }

  /** 增量帧（WS delta/event/turn-end/approval-request/error 及 S0/S3 新帧）统一入口 */
  applyFrame(frame: WsFrame): void {
    if (frame.type === 'error') {
      // 协议错误：记录在 statusDetail（不打断会话流；输入框等处可见）
      this.set({ statusDetail: { ...this.state.statusDetail, error: frame.error } });
      return;
    }
    if (frame.type === 'cancel-ack') {
      // 取消 ack 无 sessionId（全局 requestId 归属）：记全局表，UI 据 requestId 展示三态
      this.set({ cancelAcks: { ...this.state.cancelAcks, [frame.requestId]: frame.state } });
      return;
    }
    const id: string = frame.sessionId;
    const stream = this.ensureStream(id);
    if (frame.type === 'event') {
      const applied = applyEvent(stream.events, stream.lastSeq, frame.event);
      if (applied === null) return; // 重复/落后（重放已覆盖）
      stream.events = applied.events;
      stream.lastSeq = applied.lastSeq;
      this.absorbEvent(stream, frame.event);
    } else if (frame.type === 'delta') {
      if (frame.kind === 'tool') stream.live.toolCalls = [...stream.live.toolCalls, frame.call];
      else if (frame.kind === 'text') stream.live.text += frame.text;
      else stream.live.reasoning += frame.text;
    } else if (frame.type === 'text-delta' || frame.type === 'reasoning-delta') {
      const kind = frame.type === 'text-delta' ? 'text' : 'reasoning';
      // 新 attempt（含首块 offset=0）开始时清空在途文本，避免上一 attempt 残留拼接
      if (stream.liveAttemptId !== frame.attemptId) {
        stream.liveAttemptId = frame.attemptId;
        stream.live.text = '';
        stream.live.reasoning = '';
      }
      const slot = stream.watermarks[frame.attemptId] ?? {};
      const next = acceptDelta(slot[kind], frame.chunkOffset, frame.text);
      if (next === null) return; // 重复/重叠/缺口：丢弃（不 notify，避免无谓重渲）
      slot[kind] = next;
      stream.watermarks[frame.attemptId] = slot;
      if (kind === 'text') stream.live.text += frame.text;
      else stream.live.reasoning += frame.text;
    } else if (frame.type === 'attempt-final') {
      stream.attempts[frame.attemptId] = {
        turnId: frame.turnId,
        state: frame.state,
        ...(frame.finalText !== undefined ? { finalText: frame.finalText } : {}),
        ...(frame.error !== undefined ? { error: frame.error } : {}),
      };
      // attempt 终态：该 attempt 的水位作废（后续 attempt 从 0 重新计数）
      delete stream.watermarks[frame.attemptId];
      if (stream.liveAttemptId === frame.attemptId) stream.liveAttemptId = undefined;
    } else if (frame.type === 'turn-end') {
      const turnId = lastTurnId(stream.events);
      if (turnId !== undefined) {
        stream.turnEnds[turnId] = {
          stopReason: frame.stopReason,
          ...(frame.textOutcome !== undefined ? { textOutcome: frame.textOutcome } : {}),
          ...(frame.finalText !== undefined ? { finalText: frame.finalText } : {}),
          ...(frame.partialText !== undefined ? { partialText: frame.partialText } : {}),
          ...(frame.error !== undefined ? { error: frame.error } : {}),
          ...(frame.warning !== undefined ? { warning: frame.warning } : {}),
        };
      }
      stream.running = false;
      stream.live = emptyLive(); // turn 收尾：在途增量清空（落盘事件已覆盖）
      stream.liveAttemptId = undefined;
      stream.activeAttempt = undefined;
      stream.approvals = []; // turn 结束：审批等待要么已响应要么已超时，全部失效
    } else if (frame.type === 'approval-request') {
      stream.approvals = [
        ...stream.approvals,
        {
          requestId: frame.requestId,
          tool: frame.tool,
          args: frame.args,
          ...(frame.scope !== undefined ? { scope: frame.scope.mode } : {}),
          ...(frame.expiresAt !== undefined ? { expiresAt: frame.expiresAt } : {}),
          ...(frame.cwd !== undefined ? { cwd: frame.cwd } : {}),
          ...(frame.taskId !== undefined ? { taskId: frame.taskId } : {}),
          ...(frame.parentTaskId !== undefined ? { parentTaskId: frame.parentTaskId } : {}),
        },
      ];
    } else if (frame.type === 'submit-ack') {
      this.resolveSubmitAck(stream, frame);
    } else if (frame.type === 'resume-snapshot') {
      this.applyResumeSnapshot(stream, frame);
    } else if (frame.type === 'forked') {
      stream.forkedFrom = frame.parentSession;
    } else if (frame.type === 'nudge-started') {
      stream.nudge = { running: true, ...(stream.nudge.last !== undefined ? { last: stream.nudge.last } : {}) };
    } else if (frame.type === 'nudge-finished') {
      stream.nudge = {
        running: false,
        last: {
          stopReason: frame.stopReason,
          toolCalls: frame.toolCalls,
          staged: frame.staged,
          ...(frame.error !== undefined ? { error: frame.error } : {}),
        },
      };
    }
    // 后台会话徽标：非选中且未绑定分栏的会话，按"新消息"口径计数（assistant/message / turn-end）
    if (this.isBackground(id)) {
      if (frame.type === 'turn-end' || (frame.type === 'event' && frame.event.type === 'assistant/message')) {
        stream.unread += 1;
      }
    }
    this.notify();
  }

  /** submit-ack 收敛：accepted 保留队列项并登记序号；rejected 移除；unknown ≠ rejected（保留待定） */
  private resolveSubmitAck(stream: SessionStream, frame: Extract<WsFrame, { type: 'submit-ack' }>): void {
    stream.submitAcks = {
      ...stream.submitAcks,
      [frame.clientMessageId]: {
        state: frame.state,
        ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
        ...(frame.queueSeq !== undefined ? { queueSeq: frame.queueSeq } : {}),
      },
    };
    delete stream.pendingSubmits[frame.clientMessageId];
    if (frame.state === 'rejected') {
      // 明确拒绝：从可见队列移除（不假装已排队）
      stream.queue = stream.queue.filter((q) => q.id !== frame.clientMessageId);
    } else if (frame.state === 'accepted' && frame.queueSeq !== undefined) {
      stream.queue = stream.queue.map((q) => (q.id === frame.clientMessageId ? { ...q, revision: q.revision + 1 } : q));
    }
  }

  /**
   * 重订阅快照（S3 契约）：以服务端为权威补齐在途 attempt / 任务 / 待批 / 队列。
   * 旧 epoch（< 当前）直接丢弃；事件回放由既有 /events 全量重放负责（此处只补状态，不重复插事件）。
   */
  private applyResumeSnapshot(stream: SessionStream, frame: Extract<WsFrame, { type: 'resume-snapshot' }>): void {
    if (frame.epoch < stream.epoch) return; // 旧连接代次：丢弃
    stream.epoch = frame.epoch;
    const snap = frame.snapshot;
    stream.resume = { fromSeq: snap.replay.fromSeq, toSeq: snap.replay.toSeq, at: Date.now() };
    stream.tasks = snap.tasks;
    stream.queue = snap.queue;
    stream.activeAttempt = snap.activeAttempt;
    stream.approvals = snap.pendingApprovals.map((a) => ({
      requestId: a.requestId,
      tool: a.tool,
      args: a.args,
      scope: a.scope.mode,
      expiresAt: a.expiresAt,
      ...(a.cwd !== undefined ? { cwd: a.cwd } : {}),
      ...(a.taskId !== undefined ? { taskId: a.taskId } : {}),
      ...(a.parentTaskId !== undefined ? { parentTaskId: a.parentTaskId } : {}),
    }));
    // 在途 attempt 存在 → 会话确实仍在跑（不因客户端重连而假报停止）
    stream.running = snap.activeAttempt !== undefined || stream.running;
  }

  /** 本地登记一次提交（乐观可见队列）；ack 到达前不计入确认态 */
  noteSubmit(sessionId: string, submit: { clientMessageId: string; rawText: string; intent: 'queue' | 'steer' }): void {
    const stream = this.ensureStream(sessionId);
    stream.pendingSubmits = {
      ...stream.pendingSubmits,
      [submit.clientMessageId]: {
        clientMessageId: submit.clientMessageId,
        rawText: submit.rawText,
        intent: submit.intent,
        ts: Date.now(),
      },
    };
    if (submit.intent === 'queue') {
      stream.queue = [
        ...stream.queue,
        { id: submit.clientMessageId, revision: 0, rawText: submit.rawText, intent: 'queue', state: 'queued' },
      ];
    }
    this.notify();
  }

  /**
   * ack 丢失判定：超过 timeoutMs 仍在途 → 记 unknown（渲染为「未确认，勿重复提交」），
   * **不自动重发**（把重连当重发是明令禁止的）。返回超时项供 UI 提示。
   */
  expirePendingSubmits(timeoutMs = 5000, now = Date.now()): PendingSubmit[] {
    const expired: PendingSubmit[] = [];
    for (const stream of this.streams.values()) {
      for (const p of Object.values(stream.pendingSubmits)) {
        if (now - p.ts < timeoutMs) continue;
        expired.push(p);
        delete stream.pendingSubmits[p.clientMessageId];
        stream.submitAcks = {
          ...stream.submitAcks,
          [p.clientMessageId]: { state: 'unknown', reason: '未收到服务端确认（连接中断）——请勿重复提交' },
        };
      }
    }
    if (expired.length > 0) this.notify();
    return expired;
  }

  /** 落盘事件应用的联动规则（delta 一致性：最终以落盘事件为准） */
  private absorbEvent(stream: SessionStream, event: SessionEventShape): void {
    if (event.type === 'user/message') {
      stream.live = emptyLive();
      stream.liveAttemptId = undefined;
      stream.running = true; // 用户消息落盘 = turn 开始
    } else if (event.type === 'assistant/message') {
      stream.live.text = '';
      stream.live.reasoning = '';
      stream.liveAttemptId = undefined;
    } else if (event.type === 'tool/call') {
      const callId = (event.payload as Record<string, unknown>)['callId'];
      stream.live.toolCalls = stream.live.toolCalls.filter((c) => c.id !== callId);
    }
  }

  /** 发送用户消息（乐观置 running；真实 turn 开始以 user/message 事件落盘为准） */
  markSending(id: string): void {
    this.ensureStream(id).running = true;
    this.notify();
  }

  /** 发送失败等场景清除 running（turn-end/user-message 正常路径不走这里） */
  clearRunning(id: string): void {
    const stream = this.streams.get(id);
    if (stream === undefined || !stream.running) return;
    stream.running = false;
    this.notify();
  }

  /** 审批响应后从待处理列表移除（服务端超时/取消后 turn-end 也会清） */
  removeApproval(requestId: string): void {
    for (const stream of this.streams.values()) {
      if (stream.approvals.some((a) => a.requestId === requestId)) {
        stream.approvals = stream.approvals.filter((a) => a.requestId !== requestId);
      }
    }
    this.notify();
  }
}

/** 事件流里最后一个出现的 turnId（turn-end 帧不带 turnId，归属最近 turn） */
function lastTurnId(events: readonly ActiveEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const p = events[i]!.payload as Record<string, unknown>;
    const turnId = p['turnId'];
    if (typeof turnId === 'string') return turnId;
  }
  return undefined;
}
