// 渲染端状态仓库：纯 TS（不依赖 React/DOM），React 组件经 useSyncExternalStore 订阅。
// 状态只由 store action 修改；controller（app-controller.ts）负责把 window.harness2 的
// 异步事件接到 action 上。单测直接驱动 action。
//
// 多会话"切换不断流"核心：每个会话独立 SessionStream 缓冲（事件 + 在途 delta + 审批 +
// 未读计数），与是否正在渲染无关；切换会话 = 选中 id 变化 + 必要时全量重放（store 自动判重）。
import type {
  ConnectionStatus,
  SessionEventShape,
  SessionSummaryShape,
  SessionEventsPayloadShape,
  StatusDetail,
  WsFrame,
} from '../shared/protocol.js';
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
import { normalizeMetadata, displayTitle, isArchived, type SessionMetadataEntry, type SessionMetadataMap } from '../shared/metadata.js';

export interface SessionMeta {
  id: string;
  cwd?: string;
  mtimeMs: number;
  firstUserText: string;
  messageCount: number;
  lastSeq: number;
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
  /** 待审批（requestId → {tool,args}） */
  approvals: Array<{ requestId: string; tool: string; args: unknown }>;
  /** 历史加载完成（首次重放成功后 true；未加载前渲染加载态） */
  loaded: boolean;
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
}

export function initialState(): AppState {
  return { rev: 0, status: 'connecting', sessions: [], selectedId: null, layout: defaultLayout(), metadata: {} };
}

export class AppStore {
  private state: AppState = initialState();
  private readonly listeners = new Set<() => void>();
  private readonly streams = new Map<string, SessionStream>();

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
    this.set({ status, ...(detail !== undefined || this.state.statusDetail !== undefined ? { statusDetail: detail } : {}) });
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
    if (Object.keys(entry).length === 0) delete nextMetadata[id]; // 空条目不落盘
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
      };
      this.streams.set(id, s);
    }
    return s;
  }

  /** 只读流视图（不存在返回 undefined；组件据此显示加载态） */
  peekStream(id: string): SessionStream | undefined {
    return this.streams.get(id);
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

  /** 增量帧（WS delta/event/turn-end/approval-request/error）统一入口 */
  applyFrame(frame: WsFrame): void {
    if (frame.type === 'error') {
      // 协议错误：记录在 statusDetail（不打断会话流；输入框等处可见）
      this.set({ statusDetail: { ...this.state.statusDetail, error: frame.error } });
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
    } else if (frame.type === 'turn-end') {
      const turnId = lastTurnId(stream.events);
      if (turnId !== undefined) {
        stream.turnEnds[turnId] = {
          stopReason: frame.stopReason,
          ...(frame.error !== undefined ? { error: frame.error } : {}),
          ...(frame.warning !== undefined ? { warning: frame.warning } : {}),
        };
      }
      stream.running = false;
      stream.live = emptyLive(); // turn 收尾：在途增量清空（落盘事件已覆盖）
      stream.approvals = []; // turn 结束：审批等待要么已响应要么已超时，全部失效
    } else if (frame.type === 'approval-request') {
      stream.approvals = [...stream.approvals, { requestId: frame.requestId, tool: frame.tool, args: frame.args }];
    }
    // 后台会话徽标：非选中且未绑定分栏的会话，按"新消息"口径计数（assistant/message / turn-end）
    if (this.isBackground(id)) {
      if (frame.type === 'turn-end' || (frame.type === 'event' && frame.event.type === 'assistant/message')) {
        stream.unread += 1;
      }
    }
    this.notify();
  }

  /** 落盘事件应用的联动规则（delta 一致性：最终以落盘事件为准） */
  private absorbEvent(stream: SessionStream, event: SessionEventShape): void {
    if (event.type === 'user/message') {
      stream.live = emptyLive();
      stream.running = true; // 用户消息落盘 = turn 开始
    } else if (event.type === 'assistant/message') {
      stream.live.text = '';
      stream.live.reasoning = '';
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
