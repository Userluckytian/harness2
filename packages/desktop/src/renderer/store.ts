// 渲染端状态仓库：纯 TS（不依赖 React/DOM），React 组件经 useSyncExternalStore 订阅。
// 状态只由 store action 修改；controller（app-controller.ts）负责把 window.harness2 的
// 异步事件接到 action 上。单测直接驱动 action。
import type { ConnectionStatus, SessionSummaryShape, StatusDetail } from '../shared/protocol.js';

export interface SessionMeta {
  id: string;
  cwd?: string;
  mtimeMs: number;
  firstUserText: string;
  messageCount: number;
  lastSeq: number;
}

export interface AppState {
  status: ConnectionStatus;
  statusDetail?: StatusDetail;
  sessions: SessionMeta[];
  /** 当前聚焦的会话（列表点击/新建后设置） */
  selectedId: string | null;
}

export function initialState(): AppState {
  return { status: 'connecting', sessions: [], selectedId: null };
}

export class AppStore {
  private state: AppState = initialState();
  private readonly listeners = new Set<() => void>();

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

  // —— actions ——

  applyStatus(status: ConnectionStatus, detail?: StatusDetail): void {
    this.set({ status, ...(detail !== undefined || this.state.statusDetail !== undefined ? { statusDetail: detail } : {}) });
  }

  setSessions(sessions: SessionSummaryShape[]): void {
    const sorted = [...sessions].sort((a, b) => b.mtimeMs - a.mtimeMs);
    this.set({ sessions: sorted });
  }

  select(sessionId: string | null): void {
    this.set({ selectedId: sessionId });
  }

  /** 新建会话后写入列表头（免一次 list 刷新；UI 立即可见） */
  addSession(summary: SessionMeta): void {
    this.set({ sessions: [summary, ...this.state.sessions.filter((s) => s.id !== summary.id)] });
  }
}
