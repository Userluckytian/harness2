// 命令面板（B6）：Ctrl+K 全局命令（VSCode/Linear 风格，顶部居中 + 半透明遮罩）。
// 受控组件：open/onClose/commands 由外层（App）传入；命令表是纯数据 { id,label,hint,run }，
// 组件只持有「触发」，实际副作用全在 App 注入的 run 回调里（保持可测、渲染进程零 Node）。
// 二态：default 态过滤命令表；会话跳转命令执行后进入 session 态，按标题过滤会话列表并选中执行。
// 过滤/键盘导航逻辑抽成纯函数导出（filterCommands / stepSelection），便于单测。
import { useEffect, useMemo, useRef, useState } from 'react';

/** 单条命令：纯数据；run 为可注入回调（副作用由 App 实现） */
export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** 「跳转到会话…」命令的固定 id：组件识别它后切换为会话选择态（App 用它注册该命令） */
export const JUMP_TO_SESSION_ID = '__jumpToSession__';

/** 会话跳转条目（App 解析好展示标题后注入） */
export interface PaletteSession {
  id: string;
  label: string;
}

/**
 * 命令过滤纯函数：query 为空 → 全量；否则大小写不敏感子串匹配 label（hint 兜底）。
 * 匹配 label 的排前面，仅匹配 hint 的排后面（简单按匹配字段排序）。
 */
export function filterCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...commands];
  const labelHit: PaletteCommand[] = [];
  const hintHit: PaletteCommand[] = [];
  for (const c of commands) {
    if (c.label.toLowerCase().includes(q)) labelHit.push(c);
    else if (c.hint !== undefined && c.hint.toLowerCase().includes(q)) hintHit.push(c);
  }
  return [...labelHit, ...hintHit];
}

/** 会话过滤纯函数：匹配展示标题（大小写不敏感子串） */
export function filterSessions(sessions: readonly PaletteSession[], query: string): PaletteSession[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...sessions];
  return sessions.filter((s) => s.label.toLowerCase().includes(q));
}

/** 键盘移动选中：边界回绕（↑ 到顶到末尾，↓ 到底回到开头）；空列表返回 -1 */
export function stepSelection(current: number, delta: -1 | 1, length: number): number {
  if (length <= 0) return -1;
  if (length === 1) return 0;
  return (current + delta + length) % length;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
  /** 会话跳转命令定位到的会话列表（进入 session 态用） */
  sessions: PaletteSession[];
  onSelectSession: (id: string) => void;
}

export function CommandPalette({ open, onClose, commands, sessions, onSelectSession }: CommandPaletteProps): React.ReactNode {
  const [mode, setMode] = useState<'commands' | 'sessions'>('commands');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开时复位并聚焦输入框
  useEffect(() => {
    if (open) {
      setMode('commands');
      setQuery('');
      setSelected(0);
      inputRef.current?.focus();
    }
  }, [open]);

  const filteredCommands = useMemo(() => filterCommands(commands, query), [commands, query]);
  const filteredSessions = useMemo(() => filterSessions(sessions, query), [sessions, query]);

  if (!open) return null;

  const listLength = mode === 'commands' ? filteredCommands.length : filteredSessions.length;

  const runSelected = (): void => {
    if (mode === 'commands') {
      const cmd = filteredCommands[selected];
      if (cmd === undefined) return;
      if (cmd.id === JUMP_TO_SESSION_ID) {
        // 进入会话选择态：清空查询，让列表展示全部会话
        setMode('sessions');
        setQuery('');
        setSelected(0);
        return;
      }
      cmd.run();
      onClose();
      return;
    }
    const s = filteredSessions[selected];
    if (s === undefined) return;
    onSelectSession(s.id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (mode === 'sessions') {
        // 会话态按一次 Esc 先回到命令态
        setMode('commands');
        setQuery('');
        setSelected(0);
      } else {
        onClose();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((cur) => stepSelection(cur, 1, listLength));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((cur) => stepSelection(cur, -1, listLength));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      runSelected();
      return;
    }
  };

  return (
    <div className="command-palette-overlay" onMouseDown={(e) => {
      // 遮罩点击关闭（面板自身 onMouseDown stopPropagation 防误关）
      if (e.target === e.currentTarget) onClose();
    }}>
      <div
        className="command-palette"
        role="dialog"
        aria-label="命令面板"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="command-palette-input-wrap">
          <span className="command-palette-prompt">›</span>
          <input
            ref={inputRef}
            className="command-palette-input"
            value={query}
            placeholder={mode === 'sessions' ? '搜索会话…' : '输入命令…'}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <ul className="command-palette-list" role="listbox">
          {listLength === 0 ? (
            <li className="command-palette-empty">无匹配项</li>
          ) : mode === 'commands' ? (
            filteredCommands.map((c, i) => (
              <li
                key={c.id}
                role="option"
                aria-selected={i === selected}
                className={`command-palette-item${i === selected ? ' selected' : ''}`}
                onMouseEnter={() => setSelected(i)}
                onClick={() => {
                  setSelected(i);
                  runSelected();
                }}
              >
                <span className="command-palette-label">{c.label}</span>
                {c.hint !== undefined && <span className="command-palette-hint">{c.hint}</span>}
              </li>
            ))
          ) : (
            filteredSessions.map((s, i) => (
              <li
                key={s.id}
                role="option"
                aria-selected={i === selected}
                className={`command-palette-item${i === selected ? ' selected' : ''}`}
                onMouseEnter={() => setSelected(i)}
                onClick={() => {
                  setSelected(i);
                  runSelected();
                }}
              >
                <span className="command-palette-label">{s.label}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
