// 会话侧栏（B3-2 拆分产物）：SessionMenu / SessionRow / SessionList（拖拽源）。
// 原 App.tsx 第 70–318 行逐字搬入；状态与 controller 来自 ../app-shared。
import { useState } from 'react';
import { filterSessionList } from '../../shared/metadata.js';
import { controller, dragState, sessionTitle, store, targetPaneFor, useAppState } from '../app-shared.js';
import type { AppState, SessionMeta } from '../store.js';

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
