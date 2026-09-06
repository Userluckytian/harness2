// 渲染端根组件：连接状态角标 + 会话侧栏 + 对话区（Task 3 空态；Task 4 完整对话视图）。
import { useMemo, useSyncExternalStore } from 'react';
import type { ConnectionStatus } from '../shared/protocol.js';
import { AppStore } from './store.js';
import { createController } from './app-controller.js';

export const store = new AppStore();
export const controller = createController(store, window.harness2);

export function useAppState() {
  return useSyncExternalStore(store.subscribe, store.getState);
}

const STATUS_LABEL: Record<ConnectionStatus, { text: string; className: string }> = {
  connecting: { text: '连接服务…', className: 'badge badge-connecting' },
  connected: { text: '已连接', className: 'badge badge-connected' },
  reconnecting: { text: '重连中…', className: 'badge badge-reconnecting' },
  offline: { text: '服务离线', className: 'badge badge-offline' },
};

export function StatusBadge({ status, error }: { status: ConnectionStatus; error?: string }) {
  const label = STATUS_LABEL[status];
  return (
    <span className={label.className} title={error ?? ''}>
      <span className="dot" aria-hidden />
      {label.text}
    </span>
  );
}

export function SessionList(): React.ReactNode {
  const state = useAppState();
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span>会话</span>
        <button
          type="button"
          className="btn-new"
          disabled={state.status !== 'connected'}
          onClick={() => void controller.newSession()}
        >
          ＋ 新建
        </button>
      </div>
      <ul className="session-list">
        {state.sessions.length === 0 ? (
          <li className="session-empty">暂无会话</li>
        ) : (
          state.sessions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={`session-item${state.selectedId === s.id ? ' selected' : ''}`}
                onClick={() => void controller.selectSession(s.id)}
              >
                <span className="session-title">{s.firstUserText || '(空会话)'}</span>
                <span className="session-meta">
                  {s.messageCount} 条 · {new Date(s.mtimeMs).toLocaleString()}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </aside>
  );
}

export function App(): React.ReactNode {
  const state = useAppState();
  const statusInfo = useMemo(() => STATUS_LABEL[state.status], [state.status]);
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">harness2</span>
        <StatusBadge status={state.status} error={state.statusDetail?.error} />
      </header>
      <div className="body">
        <SessionList />
        <main className="main">
          {state.selectedId === null ? (
            <div className="empty-state">
              <p>{statusInfo.text === '已连接' ? '选择或新建一个会话开始' : '等待服务就绪…'}</p>
            </div>
          ) : (
            // Task 4：对话视图（事件重放 + 流式渲染）
            <div className="empty-state">
              <p>会话 {state.selectedId}</p>
              <p className="muted">对话视图将在本会话产生消息后渲染</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
