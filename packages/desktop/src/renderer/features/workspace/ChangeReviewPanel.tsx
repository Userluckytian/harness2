// 变更审查面板（D5/F5）：按任务聚合的变更清单 + 真实 diff + **外部改动不静默覆盖**的安全撤销。
// 数据源：S7 `/change-review`（拟议 vs 真实落盘）+ `/execution-view`（任务归属）。只读展示。
import { useState } from 'react';
import { buildDiffRows } from '../../components/DiffCard.js';
import { controller, store, useAppState } from '../../app-shared.js';
import { buildChangeReviewView, type ChangedFileView } from './change-review-model.js';

function FileEntry({ file, sessionId, onUndo }: { file: ChangedFileView; sessionId: string; onUndo: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const rows = buildDiffRows(file.plannedBefore, file.plannedAfter);
  const visible = expanded ? rows : rows.slice(0, 40);
  return (
    <div className={`change-file${file.dirty ? ' change-dirty' : ''}`}>
      <div className="change-head">
        <span className="change-path" title={file.file}>
          {file.file}
        </span>
        {file.dirty ? (
          <span className="change-badge change-badge-dirty" title="磁盘内容与最后已知状态不一致（外部/用户改动）">
            外部改动
          </span>
        ) : (
          <span className="change-badge change-badge-clean">与拟议一致</span>
        )}
        <button type="button" className="change-undo" onClick={onUndo}>
          撤销此次修改
        </button>
      </div>
      <div className="change-meta">
        <span>归属任务：{file.taskIds.length > 0 ? file.taskIds.join(', ') : '（无执行记录关联）'}</span>
        <span>会话：{sessionId}</span>
      </div>
      <div className="change-diff">
        {visible.map((row, i) => (
          <div
            key={i}
            className={`diff-line ${row.type === 'add' ? 'diff-add' : row.type === 'del' ? 'diff-del' : 'diff-ctx'}`}
          >
            <span className="diff-mark">{row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}</span>
            <span className="diff-text">{row.text}</span>
          </div>
        ))}
        {rows.length > 40 && (
          <button type="button" className="diff-toggle" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '… 收起 …' : `… 展开全部（${rows.length} 行）…`}
          </button>
        )}
      </div>
    </div>
  );
}

export function ChangeReviewPanel({ sessionId }: { sessionId: string | null }) {
  useAppState();
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<{ count: number; kind: 'undo' | 'redo' } | null>(null);
  if (sessionId === null) return <div className="panel-empty">未选择会话</div>;
  const views = store.peekViews(sessionId);
  const view = buildChangeReviewView(views?.changeReview, views?.executionViews ?? []);

  if (view === null) {
    return (
      <div className="panel change-panel">
        <div className="panel-head">
          <span>变更</span>
        </div>
        <div className="panel-empty">{views?.errors.changeReview ?? '尚未载入变更审查（切换会话或点刷新）'}</div>
        <div className="panel-foot">
          <button type="button" onClick={() => void controller.refreshChangeReview(sessionId)}>
            刷新变更
          </button>
        </div>
      </div>
    );
  }

  const doUndo = async (decision?: 'abort' | 'overwrite'): Promise<void> => {
    const result = await controller.undoWithGuard(sessionId, decision !== undefined ? { decision } : undefined);
    if (result === undefined) return;
    if (result.blocked) {
      // 外部改动：必须用户显式决定，绝不静默覆盖
      setPendingOverwrite({ count: result.externallyModified, kind: 'undo' });
      setNotice(null);
      return;
    }
    setPendingOverwrite(null);
    setNotice(
      result.externallyModified > 0
        ? `已按你的确认覆盖 ${result.externallyModified} 个外部改动文件`
        : '已撤销（无外部冲突）',
    );
    void controller.refreshChangeReview(sessionId);
  };

  // PD1：redo 与 undo 同守卫口径 —— 冲突阻止 + 可行动提示，显式确认才重放。
  const doRedo = async (decision?: 'abort' | 'overwrite'): Promise<void> => {
    const result = await controller.redoWithGuard(sessionId, decision !== undefined ? { decision } : undefined);
    if (result === undefined) return;
    if (result.blocked) {
      setNotice(
        result.reason === 'no-baseline'
          ? '无法安全重做：本端没有最近一次撤销的恢复基线（可能由其他端撤销，或应用重启后基线丢失）。可先在本面板撤销一次以重建基线'
          : null,
      );
      if (result.reason === 'conflict') {
        setPendingOverwrite({ count: result.externallyModified, kind: 'redo' });
      }
      return;
    }
    setPendingOverwrite(null);
    setNotice(
      result.externallyModified > 0
        ? `已按你的确认覆盖 ${result.externallyModified} 个外部改动文件并重做`
        : '已重做（无外部冲突）',
    );
    void controller.refreshChangeReview(sessionId);
  };

  const conflictLine =
    pendingOverwrite?.kind === 'redo'
      ? `检测到 ${pendingOverwrite.count} 个文件在撤销后被外部修改，重做会覆盖这些改动。`
      : `检测到 ${pendingOverwrite?.count ?? 0} 个文件被外部修改，撤销会覆盖这些改动。`;

  return (
    <div className="panel change-panel">
      <div className="panel-head">
        <span>变更</span>
        <span className="panel-mode">
          文件 {view.changedFiles} · 外部改动 {view.dirtyFiles}
        </span>
      </div>
      {view.files.length === 0 && <div className="panel-empty">本会话暂无可审查的文件变更</div>}
      {pendingOverwrite !== null && (
        <div className="change-conflict">
          <div>{conflictLine}</div>
          <div className="change-conflict-actions">
            <button
              type="button"
              className="btn-deny"
              onClick={() => (pendingOverwrite.kind === 'redo' ? void doRedo('abort') : void doUndo('abort'))}
            >
              取消（保留外部改动）
            </button>
            <button
              type="button"
              className="btn-allow"
              onClick={() => (pendingOverwrite.kind === 'redo' ? void doRedo('overwrite') : void doUndo('overwrite'))}
            >
              确认覆盖
            </button>
          </div>
        </div>
      )}
      {notice !== null && <div className="panel-notice">{notice}</div>}
      <div className="change-list">
        {view.files.map((f) => (
          <FileEntry key={f.file} file={f} sessionId={sessionId} onUndo={() => void doUndo()} />
        ))}
      </div>
      <div className="panel-foot">
        <button type="button" onClick={() => void doRedo()}>
          重做上次撤销
        </button>
        <button type="button" onClick={() => void controller.refreshChangeReview(sessionId)}>
          刷新变更
        </button>
      </div>
    </div>
  );
}
