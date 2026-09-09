// 渲染端根组件：状态角标 + 会话侧栏（拖拽源）+ 分栏对话区（1/2/3 栏，DnD 绑定会话）。
// 布局纯逻辑见 shared/layout.ts；持久化经主进程落 ~/.harness2/desktop-layout.json。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { displayToolName, type ChatItem } from './chat-model.js';
import type {
  ConnectionStatus,
  SettingsNotifyDetails,
  SettingsPreferencesShape,
  SettingsTheme,
} from '../shared/protocol.js';
import { MAX_PANES } from '../shared/layout.js';
import { applyTheme, themeLabel } from './theme.js';
import { SettingsDialog } from './components/SettingsDialog.js';
import { ConversationHeader } from './components/ConversationHeader.js';
import { DiffCard } from './components/DiffCard.js';
import { AppStore, type AppState, type SessionMeta } from './store.js';
import { createController } from './app-controller.js';
import { filterSessionList } from '../shared/metadata.js';
import { composeNotifyContent, shouldNotifyOnTurnEnd } from '../shared/notify.js';
import { resolveFileRefs } from '../shared/file-ref.js';
import {
  CommandPalette,
  JUMP_TO_SESSION_ID,
  type PaletteCommand,
  type PaletteSession,
} from './components/CommandPalette.js';

/** 主题循环顺序（命令面板「切换主题」按序推进） */
const THEME_CYCLE: readonly SettingsTheme[] = ['warmPaper', 'dark', 'system'];

export const store = new AppStore();
export const controller = createController(store, window.harness2);

/** 拖拽载荷：jsdom 无 dataTransfer，模块级回退（优先 dataTransfer） */
export const dragState: { sessionId: string | null } = { sessionId: null };

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

/** 点击会话时目标分栏：优先空栏，其次第一栏 */
function targetPaneFor(state: AppState): number {
  const empty = state.layout.panes.findIndex((p) => p.sessionId === null);
  return empty >= 0 ? empty : 0;
}

/** 会话展示标题：覆层 title 优先，否则 firstUserText（空会话回落占位） */
function sessionTitle(state: AppState, s: { id: string; firstUserText: string }): string {
  const t = store.displayTitleFor(s.id) ?? s.firstUserText;
  return t.length > 0 ? t : '(空会话)';
}

function SessionMenu({
  onRename,
  onArchive,
  onRestore,
  onDelete,
}: {
  onRename: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}): React.ReactNode {
  return (
    <div className="session-menu" role="menu">
      <button type="button" className="session-menu-item" role="menuitem" onClick={onRename}>
        重命名
      </button>
      <button type="button" className="session-menu-item" role="menuitem" onClick={onArchive}>
        归档
      </button>
      <button type="button" className="session-menu-item" role="menuitem" onClick={onRestore}>
        恢复
      </button>
      <button type="button" className="session-menu-item danger" role="menuitem" onClick={onDelete}>
        删除…
      </button>
    </div>
  );
}

/** 单个会话行：主按钮（点击进分栏/拖拽源）+ ⋯菜单 + 重命名内联编辑 / 删除二次确认 */
function SessionRow({
  state,
  s,
  menuOpen,
  editing,
  editDraft,
  confirmDelete,
  archived,
  onOpenMenu,
  onCloseMenu,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onArchive,
  onRestore,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  state: AppState;
  s: SessionMeta;
  menuOpen: boolean;
  editing: boolean;
  editDraft: string;
  confirmDelete: boolean;
  archived: boolean;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
  onStartRename: () => void;
  onCommitRename: (value: string) => void;
  onCancelRename: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}): React.ReactNode {
  const stream = store.peekStream(s.id);
  const background = store.isBackground(s.id);
  const unread = stream?.unread ?? 0;
  return (
    <li className="session-row">
      <button
        type="button"
        className={`session-item${state.selectedId === s.id ? ' selected' : ''}${archived ? ' archived' : ''}`}
        draggable
        onDragStart={(e) => {
          dragState.sessionId = s.id;
          try {
            e.dataTransfer.setData('text/plain', s.id);
            e.dataTransfer.effectAllowed = 'move';
          } catch {
            // jsdom 无 dataTransfer：回退 dragState
          }
        }}
        onClick={() => {
          // 点击 = 打入目标分栏；拖拽 = 显式分屏
          void controller.assignToPane(targetPaneFor(state), s.id);
        }}
      >
        <span className="session-title">
          {sessionTitle(state, s)}
          {background && <span className="bg-tag">后台</span>}
          {unread > 0 && <span className="unread-badge">{unread}</span>}
          {stream?.running && <span className="running-dot" title="turn 进行中" />}
        </span>
        <span className="session-meta">
          {s.messageCount} 条 · {new Date(s.mtimeMs).toLocaleString()}
        </span>
      </button>
      <div className="session-row-side">
        <button
          type="button"
          className="session-menu-btn"
          title="会话操作"
          aria-label="会话操作"
          onClick={(e) => {
            e.stopPropagation();
            onOpenMenu();
          }}
        >
          ⋯
        </button>
        {menuOpen && (
          <SessionMenu
            onRename={() => {
              onCloseMenu();
              onStartRename();
            }}
            onArchive={onArchive}
            onRestore={onRestore}
            onDelete={() => {
              onCloseMenu();
              onRequestDelete();
            }}
          />
        )}
      </div>
      {editing && (
        <div className="session-rename" onClick={(e) => e.stopPropagation()}>
          <input
            className="session-rename-input"
            value={editDraft}
            autoFocus
            placeholder="输入新标题"
            onChange={(e) => onCommitRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onCommitRename(editDraft);
              } else if (e.key === 'Escape') {
                onCancelRename();
              }
            }}
            onBlur={() => onCommitRename(editDraft)}
          />
          <button type="button" className="session-rename-save" onClick={() => onCommitRename(editDraft)}>
            ✓
          </button>
        </div>
      )}
      {confirmDelete && (
        <div className="session-delete-confirm" onClick={(e) => e.stopPropagation()}>
          <span>删除后仅从侧栏隐藏，数据保留。</span>
          <button type="button" className="btn-confirm-delete" onClick={onConfirmDelete}>
            删除
          </button>
          <button type="button" className="btn-cancel-delete" onClick={onCancelDelete}>
            取消
          </button>
        </div>
      )}
    </li>
  );
}

export function SessionList(): React.ReactNode {
  const state = useAppState();
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const { active, archived } = filterSessionList(state.sessions, state.metadata, query);

  const renderRow = (s: SessionMeta, isArchived: boolean): React.ReactNode => (
    <SessionRow
      key={s.id}
      state={state}
      s={s}
      archived={isArchived}
      menuOpen={menuFor === s.id}
      editing={editingId === s.id}
      editDraft={editDraft}
      confirmDelete={confirmDeleteFor === s.id}
      onOpenMenu={() => setMenuFor(s.id)}
      onCloseMenu={() => setMenuFor(null)}
      onStartRename={() => {
        setEditingId(s.id);
        setEditDraft(sessionTitle(state, s));
      }}
      onCommitRename={(value: string) => {
        if (editingId !== s.id) return;
        setEditingId(null);
        void controller.renameSession(s.id, value);
      }}
      onCancelRename={() => setEditingId(null)}
      onArchive={() => void controller.archiveSession(s.id, true)}
      onRestore={() => void controller.archiveSession(s.id, false)}
      onRequestDelete={() => setConfirmDeleteFor(s.id)}
      onCancelDelete={() => setConfirmDeleteFor(null)}
      onConfirmDelete={() => {
        setConfirmDeleteFor(null);
        void controller.deleteSession(s.id);
      }}
    />
  );

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
      <input
        id="session-search-input"
        className="session-search"
        placeholder="搜索会话…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="session-list">
        {active.length === 0 && archived.length === 0 ? (
          <li className="session-empty">{state.sessions.length === 0 ? '暂无会话' : '无匹配会话'}</li>
        ) : (
          active.length > 0 && active.map((s) => renderRow(s, false))
        )}
      </ul>
      {archived.length > 0 && (
        <div className="archived-section">
          <button type="button" className="archived-toggle" onClick={() => setArchivedOpen((v) => !v)}>
            <span className={`archived-caret${archivedOpen ? ' open' : ''}`}>▸</span>
            已归档（{archived.length}）
          </button>
          {archivedOpen && <ul className="session-list archived-list">{archived.map((s) => renderRow(s, true))}</ul>}
        </div>
      )}
    </aside>
  );
}

/** 参数摘要（工具行/审批按钮用；单行 ≤80 字） */
function argsSummary(args: unknown): string {
  if (args === undefined) return '';
  const one = JSON.stringify(args) ?? '';
  return one.length <= 80 ? one : `${one.slice(0, 80)}…`;
}

/** write/edit 的目标文件（args.file_path；缺失返回 undefined，供 diff 卡标题兜底） */
function diffTargetFile(args: unknown): string | undefined {
  if (typeof args === 'object' && args !== null) {
    const fp = (args as Record<string, unknown>)['file_path'];
    if (typeof fp === 'string' && fp.length > 0) return fp;
  }
  return undefined;
}

/** 子会话跳转按钮（阶段 8）：在空分栏（缺省第一栏）打开子会话轨迹 */
function SubagentJump({ childSessionId }: { childSessionId: string }) {
  const state = useAppState();
  return (
    <button
      type="button"
      className="subagent-jump"
      title={`打开子会话 ${childSessionId} 轨迹`}
      onClick={() => {
        void controller.assignToPane(targetPaneFor(state), childSessionId);
      }}
    >
      子会话 {childSessionId} ↗
    </button>
  );
}

export function ChatItemView({ item, sessionId }: { item: ChatItem; sessionId?: string }) {
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
    case 'tool': {
      const jump = item.childSessionId;
      // B5 diff 卡片：write/edit 成功且有快照序（seq = rewind_points.jsonl 条目键）时展示真实红绿 diff
      const showDiff = (item.tool === 'write' || item.tool === 'edit') && sessionId !== undefined;
      const targetFile = diffTargetFile(item.args);
      return (
        <div className={`tool-entry${item.result ? (item.result.ok ? 'tool-ok' : 'tool-fail') : 'tool-pending'}`}>
          <div className={`tool-row ${item.result ? (item.result.ok ? 'tool-ok' : 'tool-fail') : 'tool-pending'}`}>
            <span className="tool-line">
              &gt; {displayToolName(item.tool)} ({argsSummary(item.args)})
            </span>
            {item.result === undefined ? (
              <span className="tool-status">运行中…</span>
            ) : (
              <span className="tool-status">
                {item.result.ok ? 'ok' : `FAILED${item.result.error !== undefined ? `: ${item.result.error}` : ''}`}
              </span>
            )}
            {jump !== undefined && <SubagentJump childSessionId={jump} />}
          </div>
          {showDiff && item.result?.ok && (
            <DiffCard
              sessionId={sessionId}
              seq={item.seq}
              file={targetFile}
              onUndo={() => void controller.undoSession(sessionId)}
            />
          )}
        </div>
      );
    }
    case 'attempt':
      return <div className="attempt-row">尝试失败：{item.error}</div>;
    case 'streaming':
      return (
        <div className="bubble-assistant streaming">
          {item.tool !== undefined ? (
            <div className="tool-row tool-pending">
              <span className="tool-line">
                &gt; {displayToolName(item.tool)} ({argsSummary(item.args)})
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

export function ChatView({ streamId }: { streamId: string | null }) {
  const state = useAppState();
  const stream = streamId !== null ? store.peekStream(streamId) : undefined;
  const items = streamId !== null ? store.chatItems(streamId) : [];
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, streamId]);

  if (streamId === null) {
    return (
      <div className="chat empty-pane">
        <p>从左侧拖会话到此分屏</p>
      </div>
    );
  }
  if (stream === undefined || !stream.loaded) {
    return (
      <div className="chat empty-pane">
        <p>加载会话…</p>
      </div>
    );
  }

  const draftText = draft.trim();
  const send = (): void => {
    if (draftText.length === 0 || stream.running) return;
    setDraft('');
    // B8 @file 引用：文本含 @ 且当前会话有 cwd → 经 IPC 解析并把代码块拼到消息最前。
    // cwd 未知/为空时按无 @ 处理（不报错、不发 IPC）；UI 输入框内容保持不变（用户仍看到原文本）。
    const session = streamId !== null ? state.sessions.find((s) => s.id === streamId) : undefined;
    const cwd = session?.cwd;
    if (cwd && cwd.length > 0 && draftText.includes('@')) {
      void resolveFileRefs(draftText, cwd, (path, c) => window.harness2.readFileForRef(path, c)).then(
        ({ finalText }) => {
          void controller.sendMessage(streamId!, finalText);
        },
      );
      return;
    }
    void controller.sendMessage(streamId!, draftText);
  };

  return (
    <div className="chat">
      <div className="messages" ref={scrollRef}>
        {items.map((item, i) => (
          <ChatItemView key={item.callId ?? item.seq ?? `i${i}`} item={item} sessionId={streamId} />
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
    </div>
  );
}

export function PaneArea(): React.ReactNode {
  const state = useAppState();
  const [dragOverPane, setDragOverPane] = useState<number | null>(null);
  const panes = state.layout.panes;

  return (
    <main className="main panes">
      <div className="pane-toolbar">
        {[1, 2, 3].map((n) => (
          <button
            key={n}
            type="button"
            className={`pane-count${panes.length === n ? ' active' : ''}`}
            onClick={() => void controller.setPaneCount(n)}
          >
            {n} 栏
          </button>
        ))}
      </div>
      <div className="pane-row">
        {panes.map((pane, i) => {
          const sid = pane.sessionId;
          const session = sid !== null ? state.sessions.find((s) => s.id === sid) : undefined;
          return (
            <section
              key={i}
              className={`pane${dragOverPane === i ? ' drag-over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverPane(i);
              }}
              onDragLeave={() => setDragOverPane((cur) => (cur === i ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverPane(null);
                const fromEvent = (() => {
                  try {
                    const v = e.dataTransfer.getData('text/plain');
                    return v.length > 0 ? v : null;
                  } catch {
                    return null;
                  }
                })();
                const dragged = dragState.sessionId ?? fromEvent;
                if (dragged !== null) void controller.assignToPane(i, dragged);
                dragState.sessionId = null;
              }}
            >
              <div className="pane-head">
                <span className="pane-label">{session ? session.firstUserText || '(空会话)' : '空分栏'}</span>
                {sid !== null && (
                  <button type="button" className="pane-unbind" onClick={() => void controller.assignToPane(i, null)}>
                    ✕
                  </button>
                )}
              </div>
              {sid !== null && session !== undefined && <ConversationHeader sessionId={sid} cwd={session.cwd} />}
              <ChatView streamId={sid} />
            </section>
          );
        })}
      </div>
    </main>
  );
}

/** 主题循环：warmPaper → dark → system → warmPaper（命令面板「切换主题」用） */
export function cycleTheme(current: SettingsTheme): SettingsTheme {
  const i = THEME_CYCLE.indexOf(current);
  return THEME_CYCLE[(i + 1) % THEME_CYCLE.length] ?? 'warmPaper';
}

/** 有序「可跳转」会话（未归档且未删除；按 mtime 降序）的 id 列表 */
function selectableSessionIds(state: AppState): string[] {
  const { active } = filterSessionList(state.sessions, state.metadata, '');
  return active.map((s) => s.id);
}

/** 在会话列表中相对当前选中移动 ±1（回绕）；返回新 id 或 null（无会话） */
export function moveSession(state: AppState, delta: -1 | 1): string | null {
  const ids = selectableSessionIds(state);
  if (ids.length === 0) return null;
  const cur = state.selectedId;
  const curIdx = cur !== null ? ids.indexOf(cur) : -1;
  const next = curIdx >= 0 ? (curIdx + delta + ids.length) % ids.length : 0;
  return ids[next] ?? null;
}

export function App(): React.ReactNode {
  const state = useAppState();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<SettingsTheme>('warmPaper');
  const [notifyDetails, setNotifyDetails] = useState<SettingsNotifyDetails>('minimal');
  // controller 生命周期挂组件：启动事件订阅 + 布局加载（卸载时退订）
  useEffect(() => {
    void controller.initLayout();
    return controller.start();
  }, []);
  // 主题/通知偏好：启动时读取并应用；设置页保存后 onPreferenceChange 即时同步（保存回调里更新各状态）
  useEffect(() => {
    void window.harness2
      .settingsGetPreferences()
      .then((p: SettingsPreferencesShape) => {
        setTheme(p.theme);
        setNotifyDetails(p.notifyDetails);
        applyTheme(p.theme);
      })
      .catch(() => {});
  }, []);
  useEffect(() => applyTheme(theme), [theme]);
  // B7 任务完成系统通知：turn-end 且「窗口非聚焦 + 该会话不可见」→ 弹系统通知。
  // 判定必须发生在这两者同时成立时（聚焦抖动/窗口失焦瞬间到位），因此逐帧结算；
  // document.hasFocus() 为浏览器 API（渲染进程零 Node），助手完成后窗口不聚焦即触发。
  // 未读徽标由 store 独立处理（不重复）；点击通知则主进程聚焦 + notify/click 帧 → selectSession。
  // listener 只挂载一次（避免随 sessions/metadata 更新重建导致帧丢失竞态）；内部经
  // store.getState() 读最新会话/覆层数据，notifyDetails 用 ref 取当前偏好。
  const notifyDetailsRef = useRef(notifyDetails);
  notifyDetailsRef.current = notifyDetails;
  useEffect(() => {
    return controller.startObservingFrames((frame) => {
      queueMicrotask(() => {
        if (frame.type !== 'turn-end' || frame.sessionId.length === 0) return;
        const st = store.getState();
        const summary = st.sessions.find((s) => s.id === frame.sessionId);
        if (summary === undefined || store.peekStream(frame.sessionId) === undefined) return; // 会话未知/尚未缓冲：不弹
        const windowFocused = document.hasFocus();
        const sessionVisible = !store.isBackground(frame.sessionId);
        if (!shouldNotifyOnTurnEnd({ windowFocused, visible: sessionVisible })) return; // 前台/该会话可见时不弹
        // 完整级别带回复摘要（前 80 字），精简级别只标题（尊重设置弹窗的 notifyDetails 偏好）
        const body = notifyDetailsRef.current === 'full' ? store.assistantText(frame.sessionId) : '';
        const { title, body: composedBody } = composeNotifyContent({
          title: store.displayTitleFor(frame.sessionId),
          firstUserText: summary.firstUserText,
          replyText: body,
        });
        void window.harness2.notify(title, composedBody, frame.sessionId).catch(() => {});
      });
    });
  }, [controller]);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  // Ctrl+K / Cmd+K 命令面板（与 Ctrl+, Ctrl+N Ctrl+F 共存；屏蔽浏览器默认"定位链接"）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 命令面板的「跳转会话」候选（展示标题优先，占位空会话）
  const activeSessions = selectableSessionIds(state);
  const paletteSessions: PaletteSession[] = useMemo(
    () =>
      activeSessions.map((id) => {
        const s = state.sessions.find((it) => it.id === id);
        const label = store.displayTitleFor(id) ?? s?.firstUserText ?? '';
        return { id, label: label.length > 0 ? label : '(空会话)' };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.sessions, state.metadata, activeSessions.join('|')],
  );

  // 命令表（纯数据；副作用全在 run 回调里，经 controller/state 注入）
  const commands: PaletteCommand[] = useMemo(() => {
    const focusSearch = (): void => {
      const el = document.getElementById('session-search-input');
      el?.focus();
      el?.scrollIntoView({ block: 'nearest' });
    };
    const cycleThemeAction = (): void => {
      const next = cycleTheme(theme);
      setTheme(next);
      applyTheme(next);
      void window.harness2.settingsSetPreferences({ theme: next });
    };
    const nextId = moveSession(state, 1);
    const prevId = moveSession(state, -1);
    const archiveId = state.selectedId;
    return [
      { id: 'newSession', label: '新建会话', hint: 'Ctrl+N', run: () => void controller.newSession() },
      {
        id: 'nextSession',
        label: '切到下一个会话',
        run: () => {
          if (nextId !== null) void controller.selectSession(nextId);
        },
      },
      {
        id: 'prevSession',
        label: '上一个会话',
        run: () => {
          if (prevId !== null) void controller.selectSession(prevId);
        },
      },
      { id: 'openSettings', label: '打开设置', hint: 'Ctrl+,', run: () => setSettingsOpen(true) },
      { id: 'cycleTheme', label: `切换主题（当前：${themeLabel(theme)}）`, run: cycleThemeAction },
      { id: 'helpShortcuts', label: '帮助 / 快捷键说明', run: () => setSettingsOpen(true) },
      { id: 'setPanes1', label: '切换为单栏（1 栏）', run: () => void controller.setPaneCount(1) },
      { id: 'setPanes2', label: '切换为双栏（2 栏）', run: () => void controller.setPaneCount(2) },
      { id: 'setPanes3', label: '切换为三栏（3 栏）', run: () => void controller.setPaneCount(3) },
      {
        id: 'archiveCurrent',
        label: '归档当前会话',
        run: () => {
          if (archiveId !== null) void controller.archiveSession(archiveId, true);
        },
      },
      { id: 'search', label: '搜索会话…', hint: '聚焦侧栏搜索', run: focusSearch },
      // 特殊命令：进入「跳转会话」选择态（组件识别 JUMP_TO_SESSION_ID 后切换为会话过滤）
      { id: JUMP_TO_SESSION_ID, label: '跳转到会话…', run: () => {} },
    ];
  }, [state, theme]);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">harness2</span>
        <span className="topbar-right">
          <span className="hint">最多 {MAX_PANES} 分屏并行</span>
          <button type="button" className="btn-settings" title="设置 (Ctrl+,)" onClick={() => setSettingsOpen(true)}>
            ⚙
          </button>
          <StatusBadge status={state.status} error={state.statusDetail?.error} />
        </span>
      </header>
      <div className="body">
        <SessionList />
        <PaneArea />
      </div>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onThemeChange={(t) => {
          setTheme(t);
          applyTheme(t);
        }}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        sessions={paletteSessions}
        onSelectSession={(id) => void controller.selectSession(id)}
      />
    </div>
  );
}
