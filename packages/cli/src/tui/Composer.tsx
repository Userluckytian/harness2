// Composer：常驻底部多行输入框（受控 InputState + 视觉光标 + 软折行渲染）。
// T0 行为原样保留：忙时仍可编辑草稿、Enter 交上层排队/执行、Esc 停止当前 turn、
// Ctrl+C 退出协议、Ctrl+D 空草稿退出、queuedCount 页脚、空闲 Ctrl+C 提示只进局部 state。
// T1 新增：输入内核迁到 input.ts（grapheme/软折行/词移动/Home End/历史往返），
// 视觉光标按显示列渲染，软折行多行渲染，Shift+Enter 换行并给出行尾 \ 的终端替代键提示。
//
// 词移动按键（已实测 ink 7.1.1 parse-keypress 的解析结果）：
//   '\x1b[1;5D'（Ctrl+Left）→ key.leftArrow=true, key.ctrl=true
//   '\x1b[1;3D'（Alt+Left） → key.leftArrow=true, key.meta=true
// 两者都能被区分，故同时支持 Ctrl 与 Alt(meta)+方向键做词移动。
//
// IME 诚实说明：ink 7 的 useInput 只有按键流，没有 OS IME composition 事件通道，
// 无法观测真实组合中文本。这里保留 input.ts 的 composing/canSubmit 挂点并用其拦截 Enter，
// 但**不伪造** composition 行为；真机 IME 组合仍需手工签收（见计划「残留手工验收清单」）。
import React from 'react';
import { useInput, useStdout, Box, Text } from 'ink';
import { matchCommands } from '../command-registry.js';
import { createCtrlCGuard, type ExitReason } from './shutdown.js';
import {
  canSubmit,
  createHistoryState,
  createInputState,
  graphemeBoundaries,
  historyNext,
  historyPrev,
  historyPush,
  layoutInput,
  moveVertical,
  reduceInput,
  selectionRange,
  type InputState,
} from './input.js';

const CTRL_C_WINDOW_MS = 2000;
/** 边框 2 列 + 提示符 "> " 2 列 */
const CHROME_WIDTH = 4;
const FALLBACK_COLUMNS = 80;

export interface ComposerProps {
  /** 双行视觉提示当前输入多行状态；true 时仍可编辑草稿 */
  busy?: boolean;
  /** 输入焦点（浮层打开时 false，卸载非激活键盘监听实现互斥） */
  active?: boolean;
  /** Enter 发送（携带清空后的内容；由调用方决定语义，忙时由上层排队） */
  onSend: (text: string) => void;
  /** Ctrl+C 两次 / 空 buffer 时 Ctrl+D 的上交退出钩子（reason 供退出码区分） */
  onExit: (reason?: ExitReason) => void;
  /** 忙时 Esc / Ctrl+C 触发：取消当前 turn */
  onAbort?: () => void;
  /** 上层 FIFO 队列长度（>0 时页脚提示） */
  queuedCount?: number;
}

interface Cell {
  text: string;
  start: number;
  end: number;
  active: boolean;
}

/** 把一行按 grapheme 拆成可高亮单元（选区/光标均用反显）。 */
function rowCells(rowText: string, localCursor: number | null, selStart: number | null, selEnd: number | null): Cell[] {
  const boundaries = graphemeBoundaries(rowText);
  const cells: Cell[] = [];
  for (let i = 1; i < boundaries.length; i += 1) {
    const start = boundaries[i - 1] ?? 0;
    const end = boundaries[i] ?? rowText.length;
    const selected = selStart !== null && selEnd !== null && selEnd > selStart && start >= selStart && end <= selEnd;
    const cursor = localCursor !== null && localCursor === start && localCursor < rowText.length;
    cells.push({ text: rowText.slice(start, end), start, end, active: selected || cursor });
  }
  if (localCursor !== null && localCursor === rowText.length) {
    // 行尾光标：占位一个反显空格单元
    cells.push({ text: ' ', start: rowText.length, end: rowText.length, active: true });
  }
  return cells;
}

/** 合并相邻同态单元，减少 Text 节点。 */
function groupCells(cells: Cell[]): { text: string; active: boolean }[] {
  const groups: { text: string; active: boolean }[] = [];
  for (const cell of cells) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.active === cell.active) last.text += cell.text;
    else groups.push({ text: cell.text, active: cell.active });
  }
  return groups;
}

export function Composer({
  busy = false,
  active = true,
  onSend,
  onExit,
  onAbort,
  queuedCount = 0,
}: ComposerProps): React.ReactElement {
  const [draft, setDraft] = React.useState<InputState>(() => createInputState(''));
  const [candidateIndex, setCandidateIndex] = React.useState(0);
  // 空闲 Ctrl+C 首次按键的瞬时页脚提示（局部 state，不污染 draft）
  const [ctrlCHint, setCtrlCHint] = React.useState<string | null>(null);
  const historyRef = React.useRef(createHistoryState());
  const ctrlCGuardRef = React.useRef(createCtrlCGuard({ windowMs: CTRL_C_WINDOW_MS }));
  const hintTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const { stdout } = useStdout();
  const inputWidth = Math.max(1, (stdout.columns ?? FALLBACK_COLUMNS) - CHROME_WIDTH);

  const layout = layoutInput(draft, inputWidth);

  const clearCtrlCHint = (): void => {
    if (hintTimerRef.current !== null) {
      clearTimeout(hintTimerRef.current);
      hintTimerRef.current = null;
    }
    setCtrlCHint(null);
  };
  const showCtrlCHint = (msg: string): void => {
    clearCtrlCHint();
    setCtrlCHint(msg);
    hintTimerRef.current = setTimeout(() => {
      hintTimerRef.current = null;
      setCtrlCHint(null);
    }, CTRL_C_WINDOW_MS);
  };
  // 卸载清理提示定时器（退出后无遗留 timer）
  React.useEffect(
    () => () => {
      if (hintTimerRef.current !== null) clearTimeout(hintTimerRef.current);
    },
    [],
  );

  // 命令名阶段：value 以 / 开头且不含空格/换行（输入单个命令名，未进入参数）
  const commandNameActive = draft.value.startsWith('/') && !draft.value.includes(' ') && !draft.value.includes('\n');
  const candidates = commandNameActive ? matchCommands(draft.value) : [];
  // 防越界：候选变化后 clamp 高亮索引
  const safeCandidateIndex = candidates.length === 0 ? 0 : Math.min(candidateIndex, candidates.length - 1);

  useInput(
    (ch, key) => {
      const isCtrlC = Boolean(key.ctrl && ch === 'c');
      // 任何非 Ctrl+C 按键都视为退出协议中断：重置窗口并清掉提示
      if (!isCtrlC) {
        ctrlCGuardRef.current.reset();
        if (ctrlCHint !== null) clearCtrlCHint();
      }

      // —— 命令名阶段：↑↓ 切候选、Tab 补全候选（不发送）；其余按键照常 ——
      if (candidates.length > 0) {
        if (key.upArrow) {
          setCandidateIndex((i) => (i - 1 + candidates.length) % candidates.length);
          return;
        }
        if (key.downArrow) {
          setCandidateIndex((i) => (i + 1) % candidates.length);
          return;
        }
        if (key.tab) {
          const chosen = candidates[safeCandidateIndex];
          if (chosen !== undefined) {
            setDraft((d) => reduceInput(d, { type: 'setValue', value: chosen }));
            setCandidateIndex(0);
          }
          return;
        }
        // 其余按键落到普通输入流（Enter 触发 onSend 等）
      }

      if (isCtrlC) {
        const verdict = ctrlCGuardRef.current.press({ busy });
        if (verdict === 'cancel') {
          clearCtrlCHint();
          onAbort?.();
          return;
        }
        if (verdict === 'confirm') {
          clearCtrlCHint();
          onExit('sigint');
          return;
        }
        showCtrlCHint('（再按一次 Ctrl+C 退出）');
        return;
      }
      if (key.ctrl && ch === 'd') {
        if (draft.value.trim().length === 0) onExit('eof');
        return;
      }
      if (key.shift && key.return) {
        // Shift+Enter 换行（ink 将 '\x1b[13;2u' 解析为 shift+return）
        setDraft((d) => reduceInput(d, { type: 'insert', text: '\n' }));
        return;
      }
      if (key.return) {
        const text = draft.value;
        if (text.trim().length === 0) return;
        // IME 组合未提交时不发送（composing 目前恒为空，见文件头「IME 诚实说明」）
        if (!canSubmit(draft)) return;
        if (text.trimEnd().endsWith('\\')) {
          // 行尾 \ 续行（终端无法区分 Shift+Enter 时的替代键）：去掉该反斜杠后换行
          setDraft(createInputState(`${text.trimEnd().slice(0, -1)}\n`));
          return;
        }
        historyRef.current = historyPush(historyRef.current, text);
        setDraft(createInputState(''));
        setCandidateIndex(0);
        onSend(text);
        return;
      }
      if (key.home) {
        setDraft((d) => reduceInput(d, { type: 'move', dir: 'lineStart' }));
        return;
      }
      if (key.end) {
        setDraft((d) => reduceInput(d, { type: 'move', dir: 'lineEnd' }));
        return;
      }
      if (key.upArrow || key.downArrow) {
        const dir = key.upArrow ? 'up' : 'down';
        const rowCount = layout.rows.length;
        const insideMultiRow = rowCount > 1 && (dir === 'up' ? layout.cursorRow > 0 : layout.cursorRow < rowCount - 1);
        if (insideMultiRow) {
          // 跨软折行视觉行移动
          setDraft((d) => moveVertical(d, inputWidth, dir));
          return;
        }
        // 到达输入框视觉边界：交给历史（走到头会恢复原 draft 与 selection）
        const result = dir === 'up' ? historyPrev(historyRef.current, draft) : historyNext(historyRef.current, draft);
        historyRef.current = result.history;
        if (result.next !== null) setDraft(result.next);
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const word = Boolean(key.ctrl || key.meta);
        const dir = key.leftArrow ? (word ? 'wordLeft' : 'left') : word ? 'wordRight' : 'right';
        setDraft((d) => reduceInput(d, key.shift ? { type: 'select', dir } : { type: 'move', dir }));
        return;
      }
      if (key.backspace) {
        setDraft((d) => reduceInput(d, { type: 'backspace' }));
        return;
      }
      if (key.delete) {
        setDraft((d) => reduceInput(d, { type: 'delete' }));
        return;
      }
      if (key.escape) {
        if (busy) {
          // 忙时 Esc：停止当前 turn（不清草稿）
          onAbort?.();
          return;
        }
        setDraft(createInputState(''));
        return;
      }
      if (ch !== undefined && ch !== '' && !key.ctrl && !key.meta) {
        setDraft((d) => reduceInput(d, { type: 'insert', text: ch }));
      }
    },
    { isActive: active },
  );

  const selection = selectionRange(draft);
  const rows = layout.rows;

  const renderRow = (rowText: string, rowIndex: number): React.ReactNode => {
    const rowStart = layout.rowStarts[rowIndex] ?? 0;
    const rowEnd = layout.rowEnds[rowIndex] ?? rowStart + rowText.length;
    const hard = layout.rowHard[rowIndex] ?? false;
    const isCursorRow = rowIndex === layout.cursorRow;
    const localCursor = isCursorRow ? draft.cursor - rowStart : null;
    const selStart = selection === null ? null : Math.max(selection.start, rowStart) - rowStart;
    const selEnd = selection === null ? null : Math.min(selection.end, rowEnd) - rowStart;
    const hasSelection = selStart !== null && selEnd !== null && selEnd > selStart;
    const marker = hard ? '¶' : '';
    // 无选区且非光标行：整行单个 Text，保证行尾标记与正文连续（既有测试断言 'a¶'）
    if (localCursor === null && !hasSelection) {
      return <Text key={`r${rowIndex}`}>{rowText + marker}</Text>;
    }
    const groups = groupCells(rowCells(rowText, localCursor, selStart, selEnd));
    return (
      <Text key={`r${rowIndex}`}>
        {groups.map((g, gi) => (
          <Text key={`c${gi}`} inverse={g.active || undefined}>
            {g.text}
          </Text>
        ))}
        {hard && <Text color="gray">¶</Text>}
      </Text>
    );
  };

  return (
    <Box flexDirection="column" borderStyle="round" flexShrink={0}>
      {busy && (
        <Text color="gray">
          Esc 停止当前 turn · Enter 排队
          {queuedCount > 0 ? ` · 已排队 ${queuedCount} 条` : ''}
        </Text>
      )}
      {ctrlCHint !== null && <Text color="gray">{ctrlCHint}</Text>}
      <Box flexDirection="row">
        <Text color="green">&gt; </Text>
        <Box flexDirection="column">{rows.map((rowText, i) => renderRow(rowText, i))}</Box>
      </Box>
      <Text color="gray">Enter 发送 · Shift+Enter 换行（终端不支持时行尾 \ 回车）</Text>
      {candidates.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {candidates.map((c, i) => (
            <Box key={c} minWidth={1}>
              <Text color={i === safeCandidateIndex ? 'cyan' : undefined}>
                {i === safeCandidateIndex ? '› ' : '  '}
                {c}
              </Text>
            </Box>
          ))}
          <Text color="gray">↑↓ 切换 · Tab 补全 · Enter 发送当前内容</Text>
        </Box>
      )}
    </Box>
  );
}
