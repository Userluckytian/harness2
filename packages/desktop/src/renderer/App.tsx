// 渲染端根组件：状态角标 + 会话侧栏 + 对话视图（气泡/工具行/reasoning 折叠/流式光标/审批）。
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatItem } from './chat-model.js';
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
          state.sessions.map((s) => {
            const stream = store.peekStream(s.id);
            const unread = stream?.unread ?? 0;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className={`session-item${state.selectedId === s.id ? ' selected' : ''}`}
                  onClick={() => void controller.selectSession(s.id)}
                >
                  <span className="session-title">
                    {s.firstUserText || '(空会话)'}
                    {unread > 0 && <span className="unread-badge">{unread}</span>}
                    {stream?.running && <span className="running-dot" title="turn 进行中" />}
                  </span>
                  <span className="session-meta">
                    {s.messageCount} 条 · {new Date(s.mtimeMs).toLocaleString()}
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </aside>
  );
}

/** 参数摘要（工具行/审批按钮用；单行 ≤80 字） */
function argsSummary(args: unknown): string {
  if (args === undefined) return '';
  const one = JSON.stringify(args) ?? '';
  return one.length <= 80 ? one : `${one.slice(0, 80)}…`;
}

export function ChatItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'turn-header':
      return <div className="turn-header">── turn</div>;
    case 'user':
      return (
        <div className="bubble-user">
          <span className="role">你</span>
          <div className="text">{item.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="bubble-assistant">
          <span className="role">{item.model ?? '助手'}</span>
          {item.reasoning !== undefined && item.reasoning.length > 0 && (
            <details className="reasoning">
              <summary>思考过程</summary>
              <div className="reasoning-body">{item.reasoning}</div>
            </details>
          )}
          <div className="text">{item.text}</div>
        </div>
      );
    case 'tool':
      return (
        <div className={`tool-row ${item.result ? (item.result.ok ? 'tool-ok' : 'tool-fail') : 'tool-pending'}`}>
          <span className="tool-line">
            &gt; {item.tool} ({argsSummary(item.args)})
          </span>
          {item.result === undefined ? (
            <span className="tool-status">运行中…</span>
          ) : (
            <span className="tool-status">
              {item.result.ok ? 'ok' : `FAILED${item.result.error !== undefined ? `: ${item.result.error}` : ''}`}
            </span>
          )}
        </div>
      );
    case 'attempt':
      return <div className="attempt-row">尝试失败：{item.error}</div>;
    case 'streaming':
      return (
        <div className="bubble-assistant streaming">
          {item.tool !== undefined ? (
            <div className="tool-row tool-pending">
              <span className="tool-line">
                &gt; {item.tool} ({argsSummary(item.args)})
              </span>
              <span className="tool-status">运行中…</span>
            </div>
          ) : (
            <div className="text">
              {item.reasoning !== undefined && item.reasoning.length > 0 && (
                <div className="reasoning-inline">（思考中…）</div>
              )}
              {item.text}
              <span className="cursor">▌</span>
            </div>
          )}
        </div>
      );
    case 'turn-summary':
      return (
        <div className="turn-summary">
          [{item.stopReason ?? '已完成'}
          {item.durationMs !== undefined && item.durationMs > 0 ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ''}]
          {item.error !== undefined && <span className="sum-err"> {item.error}</span>}
          {item.warning !== undefined && <span className="sum-warn"> {item.warning}</span>}
        </div>
      );
  }
}

export function ChatView({ streamId }: { streamId: string }) {
  const state = useAppState();
  const stream = store.peekStream(streamId);
  const items = store.chatItems(streamId);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, streamId]);

  if (stream === undefined || !stream.loaded) {
    return (
      <main className="main">
        <div className="empty-state">
          <p>加载会话…</p>
        </div>
      </main>
    );
  }

  const draftText = draft.trim();
  const send = (): void => {
    if (draftText.length === 0 || stream.running) return;
    setDraft('');
    void controller.sendMessage(streamId, draftText);
  };

  return (
    <main className="main chat">
      <div className="messages" ref={scrollRef}>
        {items.map((item, i) => (
          <ChatItemView key={item.callId ?? item.seq ?? `i${i}`} item={item} />
        ))}
        {items.length === 0 && <div className="empty-state">发送第一条消息开始对话</div>}
      </div>
      {stream.approvals.length > 0 && (
        <div className="approval-bar">
          {stream.approvals.map((a) => (
            <div key={a.requestId} className="approval-item">
              <span>
                允许执行 <b>{a.tool}</b>？{argsSummary(a.args)}
              </span>
              <button
                type="button"
                className="btn-allow"
                onClick={() => void controller.respondApproval(a.requestId, 'allow')}
              >
                允许
              </button>
              <button
                type="button"
                className="btn-deny"
                onClick={() => void controller.respondApproval(a.requestId, 'deny')}
              >
                拒绝
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer">
        <textarea
          value={draft}
          placeholder={state.status === 'connected' ? '输入消息（Enter 发送，Shift+Enter 换行）' : '服务未连接…'}
          disabled={state.status !== 'connected'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {stream.running ? (
          <button type="button" className="btn-stop" onClick={() => void controller.abort(streamId)}>
            ■ 停止
          </button>
        ) : (
          <button type="button" className="btn-send" disabled={draftText.length === 0} onClick={send}>
            发送
          </button>
        )}
      </div>
    </main>
  );
}

export function App(): React.ReactNode {
  const state = useAppState();
  const statusInfo = STATUS_LABEL[state.status];
  // controller 生命周期挂组件：启动事件订阅 + 列表刷新（卸载时退订）
  useEffect(() => controller.start(), []);
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">harness2</span>
        <StatusBadge status={state.status} error={state.statusDetail?.error} />
      </header>
      <div className="body">
        <SessionList />
        {state.selectedId === null ? (
          <main className="main">
            <div className="empty-state">
              <p>{statusInfo.text === '已连接' ? '选择或新建一个会话开始' : '等待服务就绪…'}</p>
            </div>
          </main>
        ) : (
          <ChatView streamId={state.selectedId} />
        )}
      </div>
    </div>
  );
}
