// B5 write/edit diff 卡片：用会话内 rewind_points.jsonl 的文件快照 before/after（经 IPC，
// 渲染进程零 Node）经「diff」算行级差异，渲染红绿 unified diff 卡片。
// 数据源不是重读磁盘（磁盘可能已被后续覆盖）——只读快照，纯展示 + 「撤销此次修改」按钮。
import { useEffect, useState } from 'react';
import { diffLines, type Change } from 'diff';
import type { SnapshotForCallShape } from '../../shared/protocol.js';

/** 一行渲染类型：add=新增(ok)、del=删除(danger)、ctx=上下文 */
export type DiffRowType = 'add' | 'del' | 'ctx';

export interface DiffRow {
  type: DiffRowType;
  text: string;
}

/** 默认展示的行数上限（超出可展开） */
export const DEFAULT_VISIBLE_LINES = 20;

/**
 * 纯函数：把 before/after 文本经 diffLines 展开成逐行之上的渲染行。
 * 每个 Change 可能包含多行 → 拆成单行；不渲染文件头/统一头（纯展示不需 unified 头）。
 */
export function buildDiffRows(before: string | null, after: string | null): DiffRow[] {
  const changes: Change[] = diffLines(before ?? '', after ?? '');
  const rows: DiffRow[] = [];
  for (const ch of changes) {
    const type: DiffRowType = ch.added ? 'add' : ch.removed ? 'del' : 'ctx';
    // 拆成单行；末尾空串（change 末值）直接丢弃，避免多余空行
    const lines = ch.value.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    for (const text of lines) rows.push({ type, text });
  }
  return rows;
}

interface DiffCardProps {
  /** 会话 id（经 IPC 定位 rewind_points.jsonl） */
  sessionId: string;
  /** tool/call 事件 seq（= rewind_points.jsonl 条目键） */
  seq?: number;
  /** 展示兜底的文件名（条目未命中时也可用；命中时以条目 file 为准） */
  file?: string;
  /** 点「撤销此次修改」回调（调用既有 undo 能力） */
  onUndo: () => void;
}

export function DiffCard({ sessionId, seq, file, onUndo }: DiffCardProps): React.ReactNode {
  const [entry, setEntry] = useState<NonNullable<SnapshotForCallShape['entry']> | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEntry(null);
    setReadError(null);
    // 只有 write/edit 且快照键(seq)存在才发起读取；无 seq（异常数据缺失键）不读
    if (seq === undefined) {
      setReadError('缺少事件序号，无法读取快照');
      return () => {
        cancelled = true;
      };
    }
    void window.harness2
      .getSnapshotForCall(sessionId, seq)
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.entry) setEntry(res.entry);
        else setReadError(res.error ?? '未找到对应快照');
      })
      .catch(() => {
        if (!cancelled) setReadError('快照读取失败');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, seq]);

  // 读失败 / 未拿到快照 → 降级：只显示一行提示 + （若有 file）文件名，不渲染 diff 行
  if (entry === null) {
    const title = file ?? '文件';
    return (
      <div className="diff-card diff-degraded">
        <div className="diff-head">
          <span className="diff-title">{title}</span>
          {readError !== null && <span className="diff-error">{readError}</span>}
        </div>
      </div>
    );
  }

  const rows = buildDiffRows(entry.before, entry.after);
  const visible = expanded ? rows : rows.slice(0, DEFAULT_VISIBLE_LINES);
  const hasMore = rows.length > DEFAULT_VISIBLE_LINES;

  return (
    <div className="diff-card">
      <div className="diff-head">
        <span className="diff-title" title={entry.file}>
          {entry.file}
        </span>
        <button type="button" className="diff-undo" onClick={onUndo}>
          撤销此次修改
        </button>
      </div>
      <div className="diff-body">
        {visible.length === 0 && <div className="diff-empty">（无内容变化）</div>}
        {visible.map((row, i) => (
          <div key={i} className={`diff-line ${diffRowClass(row.type)}`}>
            <span className="diff-mark">{diffRowMark(row.type)}</span>
            <span className="diff-text">{row.text}</span>
          </div>
        ))}
        {hasMore && !expanded && (
          <button type="button" className="diff-toggle" onClick={() => setExpanded(true)}>
            … 展开全部（{rows.length} 行）…
          </button>
        )}
        {hasMore && expanded && (
          <button type="button" className="diff-toggle" onClick={() => setExpanded(false)}>
            … 收起 …
          </button>
        )}
      </div>
    </div>
  );
}

function diffRowClass(type: DiffRowType): string {
  return type === 'add' ? 'diff-add' : type === 'del' ? 'diff-del' : 'diff-ctx';
}

function diffRowMark(type: DiffRowType): string {
  return type === 'add' ? '+' : type === 'del' ? '-' : ' ';
}
