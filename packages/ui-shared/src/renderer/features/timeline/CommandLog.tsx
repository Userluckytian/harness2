// 命令执行日志卡（D2）：真实 shell / cwd / 输出（范围读取）/ exit code / 取消状态。
// 只读展示：不重跑命令、不写任何文件；归属由 S7 toolExecutionView 提供（未执行绝不显示为已执行）。
import { useState } from 'react';
import {
  OUTPUT_WINDOW_LINES,
  commandSourceLabel,
  exitCodeLabel,
  sliceOutputLines,
  statusLabel,
  type TimelineToolRow,
} from './execution-log.js';

/** 输出窗口增量（点「更多行」每次追加） */
const WINDOW_STEP = 200;

export function CommandLog({ row, displayName }: { row: TimelineToolRow; displayName?: string }) {
  const [windowLines, setWindowLines] = useState(OUTPUT_WINDOW_LINES);
  const [copied, setCopied] = useState(false);
  const output = sliceOutputLines(row.outputRef, 0, windowLines);
  const isCommand = row.tool === 'bash';
  const sourceLabel = commandSourceLabel(row.commandSource);
  const shownCommand = row.commandSource === 'executed' ? row.actualCommand : row.plannedCommand;

  const copyOutput = (): void => {
    const text = row.outputRef;
    // clipboard 在某些环境（无权限/无 API）不可用：失败不抛、不误导（不显示「已复制」）
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <div className={`cmd-log cmd-${row.status}`}>
      <div className="cmd-head">
        <span className="cmd-tool">{displayName ?? row.tool}</span>
        {isCommand && sourceLabel.length > 0 && (
          <span className={`cmd-source cmd-source-${row.commandSource}`}>{sourceLabel}</span>
        )}
        <span className={`cmd-status cmd-status-${row.status}`}>{statusLabel(row.status)}</span>
        {exitCodeLabel(row).length > 0 && <span className="cmd-exit">{exitCodeLabel(row)}</span>}
        {row.durationMs !== undefined && row.durationMs > 0 && (
          <span className="cmd-duration">{(row.durationMs / 1000).toFixed(2)}s</span>
        )}
      </div>
      {shownCommand !== undefined && shownCommand.length > 0 && <pre className="cmd-command">{shownCommand}</pre>}
      <div className="cmd-meta">
        {row.cwd.length > 0 && <span className="cmd-cwd">cwd: {row.cwd}</span>}
        {row.shell !== undefined && row.shell.length > 0 && <span className="cmd-shell">shell: {row.shell}</span>}
      </div>
      {row.outputRef.length > 0 && (
        <div className="cmd-output">
          <div className="cmd-output-head">
            <span>
              输出（{output.from + 1}–{output.to} / {output.total} 行{row.outputTruncated ? '，来源已截断' : ''}）
            </span>
            <button type="button" className="cmd-copy" onClick={copyOutput}>
              {copied ? '已复制' : '复制输出'}
            </button>
          </div>
          <pre className="cmd-output-body">{output.lines.join('\n')}</pre>
          <div className="cmd-output-more">
            {output.hasAfter && (
              <button type="button" onClick={() => setWindowLines((n) => n + WINDOW_STEP)}>
                加载更多（还有 {output.total - output.to} 行）
              </button>
            )}
            {windowLines > OUTPUT_WINDOW_LINES && (
              <button type="button" onClick={() => setWindowLines(OUTPUT_WINDOW_LINES)}>
                收起
              </button>
            )}
          </div>
        </div>
      )}
      {row.error !== undefined && row.error.length > 0 && (
        <details className="cmd-error">
          <summary>错误详情</summary>
          <pre>{row.error}</pre>
        </details>
      )}
    </div>
  );
}
