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
import { defaultLayout, normalizeLayout, type DesktopLayout } from '../shared/layout.js';
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
  isPinned,
  type SessionMetadataEntry,
  type SessionMetadataMap,
} from '../shared/metadata.js';
import { resumeInflightCount } from './conversation/resume-model.js';

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
  /** 可见「待发送队列」（本地乐观项 + resume-snapshot 权威队列；accepted/rejected 后移除本地项） */
  queue: QueueEntryShape[];
  /** 任务表（resume-snapshot 同步；D3 计划/任务面板） */
  tasks: TaskContractShape[];
  /** 连接代次（resume-subscription 携带；旧 epoch 快照丢弃） */
  epoch: number;
  /** 最近一次重订阅快照的回放区间与在途计数（inflight = 快照计得的在途任务/审批条数，恢复条数据源） */
  resume?: { fromSeq: number; toSeq: number; at: number; inflight: number };
  /** 重连快照里的在途 attempt（D4 据此展示「仍在跑」而非永久 loading） */
  activeAttempt?: AttemptSnapshotShape;
  /** 分叉来源（forked 帧；原会话不变） */
  forkedFrom?: string;
  /** 记忆复盘（nudge）状态：运行中 + 最近一次结论 */
  nudge: {
    running: boolean;
    last?: { stopReason: string; toolCalls: number; staged: number; error?: string };
  };
  /** D4：最近一次收到该会话帧的时刻（ms epoch）——断流判定用，不永久 loading */
  lastFrameAt?: number;
  /**
   * Z-97（T4②）：回合终态的**落定墙钟**（turnId → ms）。真 turn-end 帧无时间戳、合成终态
   * 也无落盘时刻——「已工作 {duration}」需要端点，这里记渲染端收到终态（或完成合成）的
   * 墙钟。与 `turnEnds` 刻意分表：`turnEnds` 保持**纯协议事实**（既有测试逐字段钉住），
   * 本表只服务展示推导，不写盘、不回传。
   */
  turnEndedAt: Record<string, number>;
}

/**
 * Z-97（T4①，痛点⑤核心）：悬挂回合收敛阈值 —— 会话 `running` 且当前 turnId 无终态，
 * 且**连续无活帧**超过本时长 → store 本地合成终态（interrupted，仅 UI 态，不写盘、不发网络）。
 * 口径对齐 ZCode 逻辑帧装配超时 30s（`zcode-protocol-v4/core.ts:70`）。
 */
export const HUNG_TURN_TIMEOUT_MS = 30_000;

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
  /** 分屏布局（1..3 栏）。
   * @deprecated P4-C 裁决：三栅（AppFrame）取代分栏后，pane 绑定**已无渲染出口**；
   * 仍随旧持久化文件（desktop-layout.json）读取/写回以兼容历史数据，但不再参与后台判定或视图渲染。 */
  layout: DesktopLayout;
  /** 会话展示态覆层（B3：desktop-metadata.json；title/archived 覆盖层，不碰事件日志） */
  metadata: SessionMetadataMap;
  /** 能力盘点结果（D0；无后端能力如实 disabled + 解释，不摆假入口） */
  capabilities?: CapabilityReportShape;
  /** 取消三态 ack（requestId 全局唯一 → 全局表；UI 立即展示 stopping，unknown 不假报停止） */
  cancelAcks: Record<string, CancelAckStateShape>;
  /** PD4：审批决定在途标记（requestId → true）；UI 据此禁用按钮防连点 */
  respondingApprovals: Record<string, true>;
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
    respondingApprovals: {},
    drafts: {},
  };
}

/** 本轮 @引用 的来源报告（D1：引用来源可见——哪些进了上下文、哪些被拒及原因） */
export interface RefReport {
  sources: FileRefSource[];
  skipped: Array<{ token: string; reason: FileRefSkipReason }>;
  /** 文件确认不存在（读取通道可用） */
  notFound: string[];
  /** 读取通道缺失/不可用/读取失败（P2-3：与「未找到」分开归因，不误导用户去改路径） */
  unavailable: string[];
}

export class AppStore {
  private state: AppState = initialState();
  private readonly listeners = new Set<() => void>();
  private readonly streams = new Map<string, SessionStream>();
  /** 只读查询缓存（S7 契约；不进 AppState，读经 peekViews，变更经 notify 触发渲染） */
  private readonly views = new Map<string, SessionViews>();
  /** @引用 来源报告（D1；不进 AppState，读经 peekRefReport） */
  private readonly refReports = new Map<string, RefReport>();
  /** 审批提交失败注记（requestId → 文案；不进 AppState，读经 approvalFailure；成功/重试时清除） */
  private readonly approvalFailures = new Map<string, string>();

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

  // —— Z-97（T4①，痛点⑤核心）：悬挂回合惰性收敛 ——
  //
  // 病灶：turn 被 cancel/断流后**没有终态帧落进 store**（真 turn-end 丢失/serve 静默死掉），
  // `running` 无人清 → 界面永远转圈。既有 `clearRunning` 只覆盖「发送失败」一条路。
  //
  // 判据（事件驱动 + 单次挂钟 setTimeout 兜底，Denia「心跳自停」思想，不给每会话常驻 tick）：
  //   - 每个**会话帧到达**、每次 **replay 完成**、每次 **resume-snapshot 落定**都刷新
  //     `lastFrameAt` 水位并重新对表（活帧 = 计时重置，天然覆盖「25s 有帧 → 不合成交」）；
  //   - `running` 时挂**一个**一次性 setTimeout：剩余静默时间到点 → 合成终态；
  //   - 若对表时已静默超阈值（旧历史重放收尾、lastFrameAt 缺失兜底等）→ **就地同步收敛**；
  //   - 收敛只写 UI 态：`turnEnds[turnId] = {stopReason:'interrupted', synthetic:true}` + 清
  //     running/在途；不写盘、不发网络。真帧后到覆盖合成：真 turn-end 走既有赋值整体覆盖；
  //     真增量帧（delta/text-delta/reasoning-delta）到达时删除该回合合成记录并复活 running。
  //   - 审批在等待 = 用户侧显式等待（非静默悬挂），不收敛（卡片仍可操作，误报「已停止」反而破坏语义）。
  /** 会话 id → 唯一挂钟兜底定时器（一计时一会话；触发/替换即清） */
  private readonly hungTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * 活帧登记：刷新静默水位并重新对表。applyFrame 对**任何**有会话归属的帧调用（含被
   * seq 判重丢弃的 event —— 帧到达本身就是传输层活着的证据）；applyReplay / markSending 同路。
   */
  private noteActivity(stream: SessionStream): void {
    stream.lastFrameAt = Date.now();
    this.armHungTurnWatch(stream);
  }

  /** 对表：running=false 撤表；静默已超阈值 → 就地收敛（调用方负责 notify）；否则挂单次兜底定时器 */
  private armHungTurnWatch(stream: SessionStream): void {
    const pending = this.hungTimers.get(stream.id);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.hungTimers.delete(stream.id);
    }
    if (!stream.running) return;
    const idle = Date.now() - (stream.lastFrameAt ?? Date.now());
    const remain = HUNG_TURN_TIMEOUT_MS - idle;
    if (remain <= 0) {
      this.convergeHungTurn(stream);
      return;
    }
    this.hungTimers.set(
      stream.id,
      setTimeout(() => {
        this.hungTimers.delete(stream.id);
        if (this.convergeHungTurn(stream)) this.notify();
      }, remain),
    );
  }

  /**
   * 合成终态（返回是否发生状态变化，供定时器回调决定是否 notify）。
   * turnId 取事件流最后一条携带 turnId 的事件（与 turn-end 帧归属同一推导）；无 turnId
   * （纯 markSending 未落盘的悬挂提交）也要清 running —— 否则痛点原样复发。
   */
  private convergeHungTurn(stream: SessionStream): boolean {
    if (!stream.running) return false;
    // 审批等待不是静默悬挂：不合成、不撤卡（下一次活帧再对表）
    if (stream.approvals.length > 0) return false;
    const turnId = lastTurnId(stream.events);
    if (turnId !== undefined && stream.turnEnds[turnId] === undefined) {
      stream.turnEnds[turnId] = { stopReason: 'interrupted', synthetic: true };
      stream.turnEndedAt[turnId] = Date.now();
    }
    stream.running = false;
    stream.live = emptyLive();
    stream.liveAttemptId = undefined;
    stream.activeAttempt = undefined;
    return true;
  }

  /** 真增量帧后到 → 删除该回合的合成终态（真实活动推翻「无响应超时」的判断） */
  private dropSyntheticEnd(stream: SessionStream, turnId: string | undefined): void {
    const id = turnId ?? lastTurnId(stream.events);
    if (id === undefined) return;
    if (stream.turnEnds[id]?.synthetic === true) delete stream.turnEnds[id];
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

  /** 更新单条会话展示态（title/archived/deleted/pinned 字段级合并）；返回值供 controller 与磁盘回读对账 */
  updateMetadata(id: string, patch: { title?: string; archived?: boolean; deleted?: boolean; pinned?: boolean }): void {
    const current = this.state.metadata[id] ?? {};
    const entry: SessionMetadataEntry = { ...current };
    if ('title' in patch) {
      const t = patch.title;
      if (typeof t === 'string' && t.trim().length > 0) entry.title = t.trim();
      else delete entry.title;
    }
    if ('archived' in patch) entry.archived = patch.archived === true;
    if ('deleted' in patch) entry.deleted = patch.deleted === true;
    if ('pinned' in patch) entry.pinned = patch.pinned === true;
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

  /** 某会话是否已置顶（覆层判定；Z8-1 / Z-07 #6） */
  isPinned(id: string): boolean {
    return isPinned(this.state.metadata, id);
  }

  /** 从当前视图移除会话（删除/归档隐藏的渲染端清理）：侧栏去项 + 分栏解绑 + 选中清理 */
  removeSessionFromView(id: string): void {
    // 审查 U1 P1-2：会话离开视图 = 永不接收帧，悬挂定时器必须随迁撤除——
    // 否则 ≤30s 窗口内它仍会对已删流触发 converge（写合成终态 + 全局 notify 空转）。
    const pending = this.hungTimers.get(id);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.hungTimers.delete(id);
    }
    this.set({
      sessions: this.state.sessions.filter((s) => s.id !== id),
      // 分栏绑定已无渲染出口与写出口（P4-C 裁决 + P1-3）：这里只为让「只读兼容的旧文件绑定」
      // 与已删会话保持一致（避免重连时按旧绑定重订阅已删会话），不影响任何视图。
      layout: { panes: this.state.layout.panes.map((p) => (p.sessionId === id ? { sessionId: null } : { ...p })) },
      ...(this.state.selectedId === id ? { selectedId: null } : {}),
    });
  }

  // —— 分屏布局（P1-3：只读兼容，无写出口） ——

  /**
   * 应用外部布局（旧 desktop-layout.json 经主进程读入）：normalizeLayout 统一校验，非法回落默认。
   * P1-3 裁决（2026-09-14）：分栏状态已无渲染出口，**写出口已删除**（无 applyPaneCount/assignToPane、
   * controller 侧无 setPaneCount/assignToPane/persistLayout）—— 本方法是唯一的入口，且只读。
   */
  applyLayout(raw: unknown): void {
    this.set({ layout: normalizeLayout(raw) });
  }

  /**
   * 会话是否处于"后台"（后台徽标累计的判定）。
   * P4-C 修复：分栏状态已无渲染出口，原实现用「是否绑定到某个分栏」判非后台，
   * 导致一旦经旧路径入栏（点过多个会话）后，切走也不再累计未读。
   * 现在语义 = **不是当前选中的会话**（选中即在前台，离开视野即后台）。
   */
  isBackground(id: string): boolean {
    return this.state.selectedId !== id;
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
        turnEndedAt: {},
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

  // —— D4：关窗口决策所需的运行态汇总（main 进程据此决定是否提示） ——

  /** 是否有任何会话在跑 turn（关窗口提示依据） */
  anyRunning(): boolean {
    for (const stream of this.streams.values()) if (stream.running) return true;
    return false;
  }

  /** 运行中的 turn 数 / 后台任务数（非终态） */
  runtimeCounts(): { runningTurns: number; backgroundTasks: number } {
    let runningTurns = 0;
    let backgroundTasks = 0;
    for (const stream of this.streams.values()) {
      if (stream.running) runningTurns += 1;
      for (const task of stream.tasks) {
        if (
          task.background &&
          task.state !== 'completed' &&
          task.state !== 'failed' &&
          task.state !== 'cancelled' &&
          task.state !== 'unknown'
        ) {
          backgroundTasks += 1;
        }
      }
    }
    return { runningTurns, backgroundTasks };
  }

  /** 是否有待审批（关窗口提示一并计入运行中工作） */
  anyPendingApprovals(): boolean {
    for (const stream of this.streams.values()) if (stream.approvals.length > 0) return true;
    return false;
  }

  /** 会话渲染条目（派生；含在途流式条目） */
  chatItems(id: string): ChatItem[] {
    const s = this.streams.get(id);
    if (!s) return [];
    // Z-97（T4b）：注入轮次耗时上下文（终态落定墙钟 + running 标记）。刻意不传 now——
    // running 耗时由 WorkIndicator 叶子自持 tick 现算（tick 纪律：时间流逝不重投影父链）。
    return projectChatItems(s.events, s.live, s.turnEnds, {
      turnEndedAt: s.turnEndedAt,
      running: s.running,
    });
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
    if (frame.type === 'cron') {
      // cron 通知帧广播全部连接、无会话归属（core ws.ts）。桌面本阶段无 cron 工作台：
      // 如实丢弃，绝不落到 ensureStream(frame.sessionId = undefined) 造幽灵流（审查 P2）。
      return;
    }
    if (
      frame.type === 'terminal/opened' ||
      frame.type === 'terminal/data' ||
      frame.type === 'terminal/exit' ||
      frame.type === 'terminal/error'
    ) {
      // Z9-2：终端帧为**连接私有**、经终端面板通道消费，不属会话流 → 此处如实忽略，
      // 不落到 ensureStream(undefined) 造幽灵流（与 cron 帧同口径）。
      return;
    }
    const id: string = frame.sessionId;
    const stream = this.ensureStream(id);
    // D4：断流判定水位（帧到达即刷新）+ Z-97（T4a）悬挂回合对表。对**任何**有会话归属的
    // 帧执行——含随后被 seq/水位判重丢弃的 event：帧到达本身就是传输层活证（旧行语义保留）。
    // 此刻 `running` 还是本帧到达前的值；本帧内才置位的 running（delta / text-delta /
    // absorbEvent / resume-snapshot）由各自分支在翻转处补一次 `armHungTurnWatch`。
    this.noteActivity(stream);
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
      // PD2：增量帧 = 服务端正在真实产出 → turn 确实在跑（重连快照无在途 attempt 的
      // 首 token 延迟窗口由此自愈；不假报停止）
      stream.running = true;
      // Z-97（T4a）：真实增量推翻「无响应超时」判断 → 删除该回合合成终态并重新挂表
      // （delta 帧无 turnId 字段，归属推导走事件流尾部，与 turn-end 帧同一口径）
      this.dropSyntheticEnd(stream, undefined);
      this.armHungTurnWatch(stream);
    } else if (frame.type === 'text-delta' || frame.type === 'reasoning-delta') {
      const kind = frame.type === 'text-delta' ? 'text' : 'reasoning';
      // PD2：同上 —— 任何真实增量都证明 turn 在跑
      stream.running = true;
      // Z-97（T4a）：同上；本帧可能被水位丢弃提前 return，判重前先把计时摆正
      this.dropSyntheticEnd(stream, frame.turnId);
      this.armHungTurnWatch(stream);
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
        // 真终态整体覆盖同 turnId 的合成记录（对象整体替换，`synthetic` 一并消失）
        stream.turnEnds[turnId] = {
          stopReason: frame.stopReason,
          ...(frame.textOutcome !== undefined ? { textOutcome: frame.textOutcome } : {}),
          ...(frame.finalText !== undefined ? { finalText: frame.finalText } : {}),
          ...(frame.partialText !== undefined ? { partialText: frame.partialText } : {}),
          ...(frame.error !== undefined ? { error: frame.error } : {}),
          ...(frame.warning !== undefined ? { warning: frame.warning } : {}),
        };
        // Z-97（T4②）：真终态落定墙钟（turnEndedAt 独立于纯协议事实的 turnEnds）
        stream.turnEndedAt[turnId] = Date.now();
      }
      stream.running = false;
      stream.live = emptyLive(); // turn 收尾：在途增量清空（落盘事件已覆盖）
      stream.liveAttemptId = undefined;
      stream.activeAttempt = undefined;
      stream.approvals = []; // turn 结束：审批等待要么已响应要么已超时，全部失效
      // D2：turn 结束即清空本地在途提交台账（ack 迟到/丢失不遗留幽灵条目）。
      // fail-closed：仍未收到 ack 的提交**如实标 unknown**（不谎报已送达），队列项保留供展示
      // 「未收到确认，请勿重复提交」；真实 ack 若随后到达会覆盖 unknown 并移除队列项。
      const stalePending = Object.values(stream.pendingSubmits);
      if (stalePending.length > 0) {
        const nextAcks = { ...stream.submitAcks };
        for (const p of stalePending) {
          if (nextAcks[p.clientMessageId] === undefined) {
            nextAcks[p.clientMessageId] = {
              state: 'unknown',
              reason: '本轮已结束仍未收到服务端确认——请勿重复提交',
            };
          }
        }
        stream.submitAcks = nextAcks;
        stream.pendingSubmits = {};
      }
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

  /**
   * submit-ack 收敛：accepted / rejected 移除本地乐观队列项（提交已落定，不再「待发送」）；
   * unknown ≠ rejected（保留待定，渲染为「未收到确认，请勿重复提交」）。
   *
   * D2 根因：旧实现 accepted 只 bump revision、从不移除，本地乐观队列项永久常驻
   * （「待发送队列」面板累积幽灵条目）。已确认送达 = 该本地项使命结束，移除即可；
   * 服务端仍会经 resume-snapshot 报告其权威队列（真实排队/恢复项照常展示）。
   */
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
    if (frame.state === 'accepted' || frame.state === 'rejected') {
      // 已落定：从可见「待发送队列」移除（accepted = 已送达服务端；rejected = 不假装已排队）。
      // unknown 刻意保留队列项（fail-closed：未知绝不当作已送达或已拒绝）。
      stream.queue = stream.queue.filter((q) => q.id !== frame.clientMessageId);
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
    // Z2-09b：恢复条计数在快照到达时刻从快照形状真实字段计得（不随流后续变化漂移）
    stream.resume = {
      fromSeq: snap.replay.fromSeq,
      toSeq: snap.replay.toSeq,
      at: Date.now(),
      inflight: resumeInflightCount(snap),
    };
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
    // PD2：快照即权威 —— 有在途 attempt = 仍在跑（不因客户端断线假报停止）；
    // 无在途 attempt（turn 已在断线窗口内跑完）= 如实落定，不留本地乐观 running（否则永久「运行中」）。
    stream.running = snap.activeAttempt !== undefined;
    // 审查 U1 P1-1：running 在本帧内翻转（false→true 是计划规格「reconnect 后无终态的
    // running 回合」的正触发场景），applyFrame 开头对表看到的还是旧值 false → 未挂表。
    // 翻转处补一次对表，否则断线重连补到的悬挂回合永不收敛（痛点⑤原样复发）。
    this.armHungTurnWatch(stream);
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
      // Z-97（T4a）：running 在本帧内翻转，applyFrame 开头的对表看到的还是旧值（已撤表）
      // → 新回合在此重新挂表（静默起点 = 本帧到达，水位已由开头 noteActivity 刷好）
      this.armHungTurnWatch(stream);
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
    const stream = this.ensureStream(id);
    stream.running = true;
    // Z-97（T4a）：悬挂看门狗起点 = 提交时刻（此后 30s 无活帧即收敛）
    this.noteActivity(stream);
    this.notify();
  }

  /** 发送失败等场景清除 running（turn-end/user-message 正常路径不走这里） */
  clearRunning(id: string): void {
    const stream = this.streams.get(id);
    if (stream === undefined || !stream.running) return;
    stream.running = false;
    // Z-97（T4a）：已如实落定 → 撤表（否则空跑的定时器无意义）
    this.armHungTurnWatch(stream);
    this.notify();
  }

  /** 审批响应后从待处理列表移除（服务端超时/取消后 turn-end 也会清） */
  removeApproval(requestId: string): void {
    this.approvalFailures.delete(requestId); // 决定已送达：失败注记一并清
    for (const stream of this.streams.values()) {
      if (stream.approvals.some((a) => a.requestId === requestId)) {
        stream.approvals = stream.approvals.filter((a) => a.requestId !== requestId);
        // 审查 U1 P1-1：审批等待期内定时器到点会「让路」（converge 对审批返回 false、
        // 不撤表也不重挂）——审批此刻清除，若不重新对表，该会话的悬挂回合永无收敛时机
        // （除非恰好再有活帧到达）。重挂=从审批清除时刻起算静默。
        this.armHungTurnWatch(stream);
      }
    }
    this.notify();
  }

  // —— PD4b：审批提交失败注记（卡片保留可重试；dock 就地显示，不静默） ——

  /** 记一次审批提交失败（controller 在 respondApproval 失败时调用） */
  markApprovalFailed(requestId: string, message: string): void {
    this.approvalFailures.set(requestId, message);
    this.notify();
  }

  /** 读某请求的失败注记（无 → undefined，不默认失败） */
  approvalFailure(requestId: string): string | undefined {
    return this.approvalFailures.get(requestId);
  }

  // —— PD4：审批决定在途反馈（防连点） ——

  markApprovalResponding(requestId: string): void {
    if (this.state.respondingApprovals[requestId] === true) return;
    this.approvalFailures.delete(requestId); // 新一轮尝试：清上次失败注记（可重试）
    this.set({ respondingApprovals: { ...this.state.respondingApprovals, [requestId]: true } });
  }

  clearApprovalResponding(requestId: string): void {
    if (this.state.respondingApprovals[requestId] !== true) return;
    const next = { ...this.state.respondingApprovals };
    delete next[requestId];
    this.set({ respondingApprovals: next });
  }

  isApprovalResponding(requestId: string): boolean {
    return this.state.respondingApprovals[requestId] === true;
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
