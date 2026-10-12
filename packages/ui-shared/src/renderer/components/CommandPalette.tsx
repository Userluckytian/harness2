// 命令面板（B6）：Ctrl+K 全局命令（VSCode/Linear 风格，顶部居中 + 半透明遮罩）。
// 受控组件：open/onClose/commands 由外层（壳装配）传入；命令表是纯数据 { id,label,hint,run }，
// 组件只持有「触发」，实际副作用全在壳注入的 run 回调里（保持可测、渲染进程零 Node）。
//
// Z-17（phase-Z8 §7）：新增 **tabbed 布局**（layout="tabbed" 显式开启）——输入框下 role=tablist
// 四 tab（全部 | 操作 | 任务 | 文件），命令按 group 分区、disabled 占位项、files 数据源、
// ←→ 切 tab；placeholder 统一「搜索操作、任务或文件」，任务/文件 tab 取代会话态 mode。
// **layout 缺省 = 'classic'**：保持 Z7 二态行为（default 过滤命令表 / JUMP_TO_SESSION_ID 切
// 会话态）逐字不变——两壳旧组装与旧单测（placeholder「输入命令…」「搜索会话…」）不破。
// 两壳接线（传 layout="tabbed" + files/onSelectFile + 按 §7 补全命令表）由另一批改 desktop/web。
// 过滤/tab/键盘导航逻辑全抽成纯函数导出（filterCommands / stepSelection / groupCommands /
// visibleItems / filterItems / tabCommands），便于单测。
import { useEffect, useMemo, useRef, useState } from 'react';

/** 单条命令：纯数据；run 为可注入回调（副作用由壳实现） */
export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
  /** Z-17「全部」tab 的分区标题（建议/面板/配置/应用…）；缺省 = 归尾部无组区 */
  group?: string;
  /** Z-17 红线⑩：无真实通道面的命令如实占位——渲染但 title=disabledHint、data-placeholder、不可选中/不可 run */
  disabled?: boolean;
  /** 占位原因提示（disabled 时作 title 属性） */
  disabledHint?: string;
}

/** 「跳转到会话…」命令的固定 id：classic 态组件识别它后切换为会话选择态（壳用它注册该命令） */
export const JUMP_TO_SESSION_ID = '__jumpToSession__';

/** 会话跳转条目（壳解析好展示标题后注入） */
export interface PaletteSession {
  id: string;
  label: string;
}

/** Z-17 文件 tab 条目（当前任务最近变更文件；壳注入） */
export interface PaletteFile {
  id: string;
  label: string;
  hint?: string;
}

/** 面板布局：classic = Z7 二态（默认，向后兼容钉）；tabbed = Z-17 四 tab */
export type PaletteLayout = 'classic' | 'tabbed';

/** Z-17 tab 标识 */
export type PaletteTab = 'all' | 'commands' | 'tasks' | 'files';

/** tab 文本（精确匹配规格 §7）与顺序 */
export const PALETTE_TABS: ReadonlyArray<{ tab: PaletteTab; label: string }> = [
  { tab: 'all', label: '全部' },
  { tab: 'commands', label: '操作' },
  { tab: 'tasks', label: '任务' },
  { tab: 'files', label: '文件' },
];

/** tabbed 态统一 placeholder（规格 §7 实测文案） */
export const TABBED_PLACEHOLDER = '搜索操作、任务或文件';
/** 任务 tab 空态（如实，红线⑩） */
export const TASKS_EMPTY_TEXT = '暂无最近任务';
/** 文件 tab 空态（如实，红线⑩） */
export const FILES_EMPTY_TEXT = '当前任务暂无最近变更';
/** 组标题文案 */
export const TASKS_GROUP_LABEL = '最近任务';
export const FILES_GROUP_LABEL = '最近变更';

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

/* —— Z-17 tabbed 纯函数（便于单测，无 React 依赖）—— */

/** 列表扁平条目：可选项（命令/会话/文件）+ 组头行（kind:'group'，非 option、不可选中） */
export type PaletteRow =
  | { kind: 'group'; key: string; label: string }
  | { kind: 'command'; key: string; command: PaletteCommand; disabled: boolean }
  | { kind: 'session'; key: string; session: PaletteSession }
  | { kind: 'file'; key: string; file: PaletteFile };

/** 扁平行中的可选项（排除组头） */
export function selectableRows(rows: readonly PaletteRow[]): PaletteRow[] {
  return rows.filter((r) => r.kind !== 'group');
}

/** 命令的 tabbed 生效 disabled 态（显式 disabled，或 classic 专用跳转命令在 tabbed 下无意义 → 占位） */
export function isCommandDisabled(command: PaletteCommand, layout: PaletteLayout): boolean {
  return command.disabled === true || (layout === 'tabbed' && command.id === JUMP_TO_SESSION_ID);
}

/**
 * 按 group 分区（保持首次出现顺序）：有 group 的按组聚集在前（组间按首现顺序），
 * 无 group 的归尾部无组区。空组不产出。
 */
export function groupCommands(commands: readonly PaletteCommand[]): { group: string; items: PaletteCommand[] }[] {
  const order: string[] = [];
  const byGroup = new Map<string, PaletteCommand[]>();
  for (const c of commands) {
    if (c.group === undefined) continue;
    let bucket = byGroup.get(c.group);
    if (bucket === undefined) {
      bucket = [];
      byGroup.set(c.group, bucket);
      order.push(c.group);
    }
    bucket.push(c);
  }
  return order.map((group) => ({ group, items: byGroup.get(group) ?? [] }));
}

/** tab → 该 tab 可见命令：操作=全量平铺；全部=全量（分区在渲染层）；任务/文件不含命令 */
export function tabCommands(tab: PaletteTab, commands: readonly PaletteCommand[]): PaletteCommand[] {
  if (tab === 'all' || tab === 'commands') return [...commands];
  return [];
}

function matchText(query: string, label: string, hint: string | undefined): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  if (label.toLowerCase().includes(q)) return true;
  return hint !== undefined && hint.toLowerCase().includes(q);
}

/**
 * 当前 tab 的扁平行列表（含组头标记）：过滤 query + 分区。
 * - all：commands 按 group 分区（组头行），无 group 归尾部无组区；disabled 项仍渲染（占位）。
 * - commands：commands 平铺无组头。
 * - tasks：sessions（组头「最近任务」）；空 → 仅剩组头，空态由渲染层按文案显示。
 * - files：files（组头「最近变更」）。
 */
export function visibleItems(
  tab: PaletteTab,
  data: { commands: readonly PaletteCommand[]; sessions: readonly PaletteSession[]; files: readonly PaletteFile[] },
  query = '',
  layout: PaletteLayout = 'tabbed',
): PaletteRow[] {
  const rows: PaletteRow[] = [];
  if (tab === 'all' || tab === 'commands') {
    const filtered = filterCommands(data.commands, query);
    if (tab === 'commands') {
      for (const c of filtered) {
        rows.push({ kind: 'command', key: `cmd:${c.id}`, command: c, disabled: isCommandDisabled(c, layout) });
      }
      return rows;
    }
    const groups = groupCommands(filtered);
    const grouped = new Set<PaletteCommand>();
    for (const g of groups) {
      if (g.items.length === 0) continue;
      rows.push({ kind: 'group', key: `grp:${g.group}`, label: g.group });
      for (const c of g.items) {
        grouped.add(c);
        rows.push({ kind: 'command', key: `cmd:${c.id}`, command: c, disabled: isCommandDisabled(c, layout) });
      }
    }
    const rest = filtered.filter((c) => !grouped.has(c));
    for (const c of rest) {
      rows.push({ kind: 'command', key: `cmd:${c.id}`, command: c, disabled: isCommandDisabled(c, layout) });
    }
    return rows;
  }
  if (tab === 'tasks') {
    const list = filterSessions(data.sessions, query);
    rows.push({ kind: 'group', key: 'grp:tasks', label: TASKS_GROUP_LABEL });
    for (const s of list) rows.push({ kind: 'session', key: `ses:${s.id}`, session: s });
    return rows;
  }
  const list = data.files.filter((f) => matchText(query, f.label, f.hint));
  rows.push({ kind: 'group', key: 'grp:files', label: FILES_GROUP_LABEL });
  for (const f of list) rows.push({ kind: 'file', key: `fil:${f.id}`, file: f });
  return rows;
}

/** 列表中的可导航下标（排除 disabled 占位命令；入参应为已剔除组头的 selectable 数组） */
export function selectableIndices(rows: readonly PaletteRow[]): number[] {
  const nav: number[] = [];
  rows.forEach((r, i) => {
    const disabled = r.kind === 'command' && r.disabled;
    if (!disabled) nav.push(i);
  });
  return nav;
}

/**
 * tabbed 键盘移动：在 selectable（非组头）数组内移动 current 下标，**跳过 disabled 命令**，边界回绕。
 * 全部 disabled / 空 → -1。current 落在 disabled 上时按方向就近取可导航项。
 */
export function stepOverRows(rows: readonly PaletteRow[], current: number, delta: -1 | 1): number {
  const nav = selectableIndices(rows);
  if (nav.length === 0) return -1;
  let pos = nav.indexOf(current);
  if (pos === -1) return delta === 1 ? nav[0]! : nav[nav.length - 1]!;
  pos = (pos + delta + nav.length) % nav.length;
  return nav[pos]!;
}

/** ←→ 在四 tab 间移动（回绕） */
export function stepTab(current: PaletteTab, delta: -1 | 1): PaletteTab {
  const idx = PALETTE_TABS.findIndex((t) => t.tab === current);
  const n = PALETTE_TABS.length;
  const next = (Math.max(idx, 0) + delta + n) % n;
  return PALETTE_TABS[next]!.tab;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
  /** 会话跳转命令定位到的会话列表（classic 会话态 / tabbed 任务 tab 用） */
  sessions: PaletteSession[];
  onSelectSession: (id: string) => void;
  /**
   * Z-17 布局：'tabbed' = 四 tab（全部|操作|任务|文件）+ 统一 placeholder + ←→ 切 tab；
   * 缺省 'classic' = Z7 二态（行为逐字不变，两壳旧组装不破）。
   */
  layout?: PaletteLayout;
  /** tabbed 文件 tab 数据源（壳注入；未注入或空 = 如实空态） */
  files?: PaletteFile[];
  /** tabbed 文件 tab 选中回调（可缺省；缺省时点击文件仅关闭面板） */
  onSelectFile?: (id: string) => void;
}

/**
 * 渲染命令面板。
 * @param props - 开合、关闭回调、命令表、会话候选与会话选中回调（+ tabbed 布局、文件数据源）。
 * @returns 面板元素；open=false 时返回 null。
 */
export function CommandPalette({
  open,
  onClose,
  commands,
  sessions,
  onSelectSession,
  layout = 'classic',
  files,
  onSelectFile,
}: CommandPaletteProps): React.ReactNode {
  const tabbed = layout === 'tabbed';
  const [mode, setMode] = useState<'commands' | 'sessions'>('commands');
  const [tab, setTab] = useState<PaletteTab>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开时复位并聚焦输入框
  useEffect(() => {
    if (open) {
      setMode('commands');
      setTab('all');
      setQuery('');
      setSelected(0);
      inputRef.current?.focus();
    }
  }, [open]);

  const filteredCommands = useMemo(
    () => filterCommands(tabbed ? tabCommands(tab, commands) : commands, query),
    [tabbed, tab, commands, query],
  );
  const filteredSessions = useMemo(() => filterSessions(sessions, query), [sessions, query]);
  const rows = useMemo(
    () => (tabbed ? visibleItems(tab, { commands, sessions, files: files ?? [] }, query, layout) : []),
    [tabbed, tab, commands, sessions, files, query, layout],
  );
  const selectable = useMemo(() => selectableRows(rows), [rows]);

  if (!open) return null;

  const listLength = tabbed
    ? selectable.length
    : mode === 'commands'
      ? filteredCommands.length
      : filteredSessions.length;

  /** 执行扁平行中的可选项 */
  const runRow = (row: PaletteRow | undefined): void => {
    if (row === undefined) return;
    if (row.kind === 'command') {
      if (row.disabled) return; // 占位项不可 run（键盘已跳过、点击不触发）
      row.command.run();
      onClose();
      return;
    }
    if (row.kind === 'session') {
      onSelectSession(row.session.id);
      onClose();
      return;
    }
    if (row.kind === 'file') {
      onSelectFile?.(row.file.id);
      onClose();
    }
  };

  const runSelected = (): void => {
    if (tabbed) {
      runRow(selectable[selected]);
      return;
    }
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

  /** 列表无可选行时的如实空态文案（classic 沿用「无匹配项」） */
  const emptyText = (): string => {
    if (!tabbed) return '无匹配项';
    if (tab === 'tasks') return selectable.length === 0 ? TASKS_EMPTY_TEXT : '';
    if (tab === 'files') return selectable.length === 0 ? FILES_EMPTY_TEXT : '';
    return selectable.length === 0 ? '无匹配项' : '';
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!tabbed && mode === 'sessions') {
        // 会话态按一次 Esc 先回到命令态
        setMode('commands');
        setQuery('');
        setSelected(0);
      } else {
        onClose();
      }
      return;
    }
    if (tabbed && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      setTab((cur) => stepTab(cur, e.key === 'ArrowRight' ? 1 : -1));
      setSelected(0);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((cur) => (tabbed ? stepOverRows(selectable, cur, 1) : stepSelection(cur, 1, listLength)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((cur) => (tabbed ? stepOverRows(selectable, cur, -1) : stepSelection(cur, -1, listLength)));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      runSelected();
      return;
    }
  };

  /** tabbed：渲染扁平行（组头小字行非 option；disabled 命令占位渲染） */
  const renderRows = (): React.ReactNode => {
    const empty = emptyText();
    if (empty !== '') return <li className="command-palette-empty">{empty}</li>;
    let optIdx = -1;
    return rows.map((row) => {
      if (row.kind === 'group') {
        return (
          <li key={row.key} className="command-palette-group" aria-hidden="true">
            {row.label}
          </li>
        );
      }
      optIdx += 1;
      const i = optIdx;
      const isSelected = i === selected;
      if (row.kind === 'command') {
        const c = row.command;
        return (
          <li
            key={row.key}
            role="option"
            aria-selected={isSelected}
            aria-disabled={row.disabled || undefined}
            {...(row.disabled ? { title: c.disabledHint, 'data-placeholder': '' } : {})}
            className={`command-palette-item${isSelected ? ' selected' : ''}${row.disabled ? ' disabled' : ''}`}
            onMouseEnter={() => {
              if (!row.disabled) setSelected(i);
            }}
            onClick={() => {
              if (row.disabled) return;
              setSelected(i);
              runRow(row);
            }}
          >
            <span className="command-palette-label">{c.label}</span>
            {c.hint !== undefined && <span className="command-palette-hint">{c.hint}</span>}
          </li>
        );
      }
      const label = row.kind === 'session' ? row.session.label : row.file.label;
      const hint = row.kind === 'file' ? row.file.hint : undefined;
      return (
        <li
          key={row.key}
          role="option"
          aria-selected={isSelected}
          className={`command-palette-item${isSelected ? ' selected' : ''}`}
          onMouseEnter={() => setSelected(i)}
          onClick={() => {
            setSelected(i);
            runRow(row);
          }}
        >
          <span className="command-palette-label">{label}</span>
          {hint !== undefined && <span className="command-palette-hint">{hint}</span>}
        </li>
      );
    });
  };

  return (
    <div
      className="command-palette-overlay"
      onMouseDown={(e) => {
        // 遮罩点击关闭（面板自身 onMouseDown stopPropagation 防误关）
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="command-palette" role="dialog" aria-label="命令面板" onMouseDown={(e) => e.stopPropagation()}>
        <div className="command-palette-input-wrap">
          <span className="command-palette-prompt">›</span>
          <input
            ref={inputRef}
            className="command-palette-input"
            value={query}
            placeholder={tabbed ? TABBED_PLACEHOLDER : mode === 'sessions' ? '搜索会话…' : '输入命令…'}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {tabbed && (
          <div className="command-palette-tabs" role="tablist" aria-label="命令范围">
            {PALETTE_TABS.map((t) => {
              const active = t.tab === tab;
              return (
                <button
                  key={t.tab}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`command-palette-tab${active ? ' selected' : ''}`}
                  onClick={() => {
                    setTab(t.tab);
                    setSelected(0);
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        )}
        <ul className="command-palette-list" role="listbox">
          {tabbed ? (
            renderRows()
          ) : listLength === 0 ? (
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
