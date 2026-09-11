// input.ts — 终端多行输入内核（纯函数，零 ink/react 依赖，可单测）。
//
// 契约见 docs/issue-log/2026-09-11-T.md §7。要点：
//  - grapheme：用 Node 22 内建 Intl.Segmenter 分段，光标恒落在 grapheme 边界；
//    backspace/delete 一次删除整个 grapheme（ZWJ emoji、组合字符、区域指示符国旗）。
//  - 显示宽度：用已依赖的 string-width 计算，CJK 宽字符按 2 列；软折行与光标列均按显示宽度。
//  - 软折行：layoutInput(state,width) 以显示宽度折行，'\n' 为硬换行。
//  - 词移动：Unicode 字母/数字/下划线（\p{L}\p{N}_）连成词；标点/空白分隔。
//    CJK 表意文字属 \p{L}，故连续汉字算一个词单位。
//  - 历史：historyPrev/historyNext 走到头必须恢复进入历史前的原始 draft（含 cursor 与 selection）。
//
// IME 诚实说明：ink 7 的 useInput 无法观测真实 OS 的 IME composition 事件（没有 compositionstart/
// update/end 通道），因此本内核提供 InputState.composing 与 {type:'compose'} action 仅作为
// 「可被真实 IME 桥接层填充」的纯逻辑挂点；Composer 当前不会伪造 composition 行为。
// canSubmit() 用于 Enter 优先级判断：composing 非空时不得提交。
import stringWidth from 'string-width';

export interface InputState {
  value: string;
  /** UTF-16 索引，恒在 grapheme 边界 */
  cursor: number;
  /** null=无选区；否则与 cursor 构成 [min,max) */
  selectionAnchor: number | null;
  /** IME 组合中文本（未提交）；ink 当前无真实来源，见文件头说明 */
  composing: string;
}

export type MoveDir = 'left' | 'right' | 'lineStart' | 'lineEnd' | 'wordLeft' | 'wordRight' | 'up' | 'down';
export type SelectDir = 'left' | 'right' | 'wordLeft' | 'wordRight';

export type InputAction =
  | { type: 'insert'; text: string }
  | { type: 'paste'; text: string }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'move'; dir: MoveDir }
  | { type: 'select'; dir: SelectDir }
  | { type: 'selectAll' }
  | { type: 'setValue'; value: string; cursor?: number }
  | { type: 'clear' }
  // 契约外的最小扩展：仅纯 reducer 层可用的 IME 组合挂点（见文件头「IME 诚实说明」），
  // 不改变上面契约里列出的任何 action 语义。
  | { type: 'compose'; text: string };

export interface LayoutResult {
  rows: string[];
  cursorRow: number;
  cursorCol: number;
  /** 每视觉行的源区间起点（UTF-16），供渲染层做选区/光标定位（契约外的只读补充） */
  rowStarts: number[];
  rowEnds: number[];
  /** 每视觉行是否以硬换行结束（渲染行尾标记；软折行 false） */
  rowHard: boolean[];
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });

/** 返回 s 的所有 grapheme 起始 UTF-16 索引（含 0 与 s.length）。 */
export function graphemeBoundaries(s: string): number[] {
  if (s.length === 0) return [0];
  const out: number[] = [0];
  for (const seg of segmenter.segment(s)) {
    if (seg.index > 0 && out[out.length - 1] !== seg.index) out.push(seg.index);
  }
  if (out[out.length - 1] !== s.length) out.push(s.length);
  return out;
}

/** 显示宽度（CJK 宽字符 2 列）。 */
export function displayWidth(s: string): number {
  return stringWidth(s);
}

/** 取不大于 pos 的最近 grapheme 边界（clamp 到 [0, s.length]）。 */
function snapToBoundary(boundaries: number[], pos: number): number {
  let best = 0;
  for (const b of boundaries) {
    if (b <= pos) best = b;
    else break;
  }
  return best;
}

/** 严格小于 pos 的最大边界。 */
function prevBoundary(boundaries: number[], pos: number): number {
  let best = 0;
  for (const b of boundaries) {
    if (b < pos) best = b;
    else break;
  }
  return best;
}

/** 严格大于 pos 的最小边界；无则返回 value.length。 */
function nextBoundary(boundaries: number[], pos: number, length: number): number {
  for (const b of boundaries) {
    if (b > pos) return b;
  }
  return length;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(g: string): boolean {
  return g.length > 0 && WORD_CHAR.test(g);
}

function graphemeBefore(value: string, boundaries: number[], pos: number): string {
  return value.slice(prevBoundary(boundaries, pos), pos);
}

function graphemeAt(value: string, boundaries: number[], pos: number): string {
  return value.slice(pos, nextBoundary(boundaries, pos, value.length));
}

/** 向左的词首：先跳过非词字符，再跳过词字符。 */
function prevWordStart(value: string, boundaries: number[], pos: number): number {
  let i = pos;
  while (i > 0 && !isWordChar(graphemeBefore(value, boundaries, i))) i = prevBoundary(boundaries, i);
  while (i > 0 && isWordChar(graphemeBefore(value, boundaries, i))) i = prevBoundary(boundaries, i);
  return i;
}

/** 向右的词尾：先跳过非词字符，再跳过词字符。 */
function nextWordEnd(value: string, boundaries: number[], pos: number): number {
  let i = pos;
  while (i < value.length && !isWordChar(graphemeAt(value, boundaries, i)))
    i = nextBoundary(boundaries, i, value.length);
  while (i < value.length && isWordChar(graphemeAt(value, boundaries, i)))
    i = nextBoundary(boundaries, i, value.length);
  return i;
}

/** 当前逻辑行行首（上一个 '\n' 之后）。 */
function lineStartOf(value: string, pos: number): number {
  return value.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
}

/** 当前逻辑行行尾（下一个 '\n' 之前，或文末）。 */
function lineEndOf(value: string, pos: number): number {
  const idx = value.indexOf('\n', pos);
  return idx === -1 ? value.length : idx;
}

export function selectionRange(state: InputState): { start: number; end: number } | null {
  if (state.selectionAnchor === null) return null;
  const a = state.selectionAnchor;
  const b = state.cursor;
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

export function createInputState(value = ''): InputState {
  return { value, cursor: value.length, selectionAnchor: null, composing: '' };
}

/** composing 非空（IME 组合中）时不得提交。 */
export function canSubmit(state: InputState): boolean {
  return state.composing.length === 0;
}

function deleteSelection(state: InputState): { value: string; cursor: number } | null {
  const sel = selectionRange(state);
  if (sel === null || sel.start === sel.end) return null;
  return {
    value: state.value.slice(0, sel.start) + state.value.slice(sel.end),
    cursor: sel.start,
  };
}

function applyInsert(state: InputState, text: string): InputState {
  const base = deleteSelection(state) ?? { value: state.value, cursor: state.cursor };
  const boundaries = graphemeBoundaries(base.value);
  const cursor = snapToBoundary(boundaries, base.cursor);
  const value = base.value.slice(0, cursor) + text + base.value.slice(cursor);
  return { value, cursor: cursor + text.length, selectionAnchor: null, composing: '' };
}

function moveCursor(value: string, cursor: number, dir: SelectDir): number {
  const boundaries = graphemeBoundaries(value);
  const pos = snapToBoundary(boundaries, cursor);
  switch (dir) {
    case 'left':
      return prevBoundary(boundaries, pos);
    case 'right':
      return nextBoundary(boundaries, pos, value.length);
    case 'wordLeft':
      return prevWordStart(value, boundaries, pos);
    case 'wordRight':
      return nextWordEnd(value, boundaries, pos);
  }
}

export interface RichRow {
  text: string;
  start: number;
  end: number;
  /** 该行以硬换行结束（value[end] === '\n'） */
  hard: boolean;
}

/** 将逻辑行按显示宽度折成视觉行；保留源区间 [start,end)。 */
function wrapLine(text: string, offset: number, hard: boolean, width: number, rows: RichRow[]): void {
  if (text.length === 0) {
    rows.push({ text: '', start: offset, end: offset, hard });
    return;
  }
  const boundaries = graphemeBoundaries(text);
  let rowStart = 0;
  let rowWidth = 0;
  for (let i = 1; i < boundaries.length; i += 1) {
    const start = boundaries[i - 1] ?? 0;
    const end = boundaries[i] ?? text.length;
    const gw = displayWidth(text.slice(start, end));
    if (rowWidth > 0 && rowWidth + gw > width) {
      rows.push({ text: text.slice(rowStart, start), start: offset + rowStart, end: offset + start, hard: false });
      rowStart = start;
      rowWidth = 0;
    }
    rowWidth += gw;
  }
  rows.push({ text: text.slice(rowStart), start: offset + rowStart, end: offset + text.length, hard });
}

/** 按显示宽度把整个 value 折成视觉行（硬换行 + 软折行）。 */
function computeRows(value: string, width: number): RichRow[] {
  const w = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : Number.POSITIVE_INFINITY;
  const rows: RichRow[] = [];
  let lineStart = 0;
  for (let i = 0; i <= value.length; i += 1) {
    if (i === value.length || value[i] === '\n') {
      wrapLine(value.slice(lineStart, i), lineStart, i < value.length, w, rows);
      lineStart = i + 1;
      if (i === value.length) break;
    }
  }
  return rows;
}

/** 光标所在视觉行与其显示列。软折行边界优先落在下一行行首；硬换行行尾落在上一行末尾。 */
function locateCursor(rows: RichRow[], value: string, cursor: number): { row: number; col: number } {
  let row = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (r !== undefined && r.start <= cursor && cursor <= r.end) row = i;
  }
  const target = rows[row] ?? { start: 0, end: 0, text: '', hard: false };
  const local = Math.max(0, Math.min(cursor, target.end));
  return { row, col: displayWidth(value.slice(target.start, local)) };
}

/** 在 text 内找到显示列为 targetCol 的最近 grapheme 边界（UTF-16 偏移）。 */
function sourceIndexForCol(text: string, targetCol: number): number {
  if (targetCol <= 0) return 0;
  const boundaries = graphemeBoundaries(text);
  let width = 0;
  for (let i = 1; i < boundaries.length; i += 1) {
    const start = boundaries[i - 1] ?? 0;
    const end = boundaries[i] ?? text.length;
    width += displayWidth(text.slice(start, end));
    if (width >= targetCol) return end;
  }
  return text.length;
}

/** 上下移动：width 为 Infinity 时退化为逻辑行移动；否则跨软折行视觉行移动。 */
export function moveVertical(state: InputState, width: number, dir: 'up' | 'down'): InputState {
  const rows = computeRows(state.value, width);
  const { row, col } = locateCursor(rows, state.value, snapToBoundary(graphemeBoundaries(state.value), state.cursor));
  const target = dir === 'up' ? row - 1 : row + 1;
  if (target < 0 || target >= rows.length) return { ...state, selectionAnchor: null };
  const targetRow = rows[target];
  if (targetRow === undefined) return { ...state, selectionAnchor: null };
  const col2 = Math.min(col, displayWidth(targetRow.text));
  const cursor = targetRow.start + sourceIndexForCol(targetRow.text, col2);
  return { ...state, cursor: Math.max(targetRow.start, Math.min(cursor, targetRow.end)), selectionAnchor: null };
}

export function layoutInput(state: InputState, width: number): LayoutResult {
  const rows = computeRows(state.value, width);
  const { row, col } = locateCursor(rows, state.value, state.cursor);
  return {
    rows: rows.map((r) => r.text),
    cursorRow: row,
    cursorCol: col,
    rowStarts: rows.map((r) => r.start),
    rowEnds: rows.map((r) => r.end),
    rowHard: rows.map((r) => r.hard),
  };
}

export function reduceInput(state: InputState, action: InputAction): InputState {
  switch (action.type) {
    case 'insert':
    case 'paste':
      if (action.text.length === 0) return state;
      return applyInsert(state, action.text);

    case 'compose':
      return { ...state, composing: action.text };

    case 'backspace': {
      const del = deleteSelection(state);
      if (del !== null) return { ...state, ...del, selectionAnchor: null, composing: '' };
      const boundaries = graphemeBoundaries(state.value);
      const cursor = snapToBoundary(boundaries, state.cursor);
      if (cursor === 0) return state;
      const prev = prevBoundary(boundaries, cursor);
      return {
        value: state.value.slice(0, prev) + state.value.slice(cursor),
        cursor: prev,
        selectionAnchor: null,
        composing: '',
      };
    }

    case 'delete': {
      const del = deleteSelection(state);
      if (del !== null) return { ...state, ...del, selectionAnchor: null, composing: '' };
      const boundaries = graphemeBoundaries(state.value);
      const cursor = snapToBoundary(boundaries, state.cursor);
      if (cursor >= state.value.length) return state;
      const next = nextBoundary(boundaries, cursor, state.value.length);
      return {
        value: state.value.slice(0, cursor) + state.value.slice(next),
        cursor,
        selectionAnchor: null,
        composing: '',
      };
    }

    case 'move': {
      const dir = action.dir;
      const sel = selectionRange(state);
      if (sel !== null) {
        if (dir === 'up' || dir === 'down') {
          return moveVertical(
            { ...state, cursor: dir === 'up' ? sel.start : sel.end, selectionAnchor: null },
            Number.POSITIVE_INFINITY,
            dir,
          );
        }
        if (dir === 'lineStart' || dir === 'lineEnd') {
          const base = dir === 'lineStart' ? sel.start : sel.end;
          const target = dir === 'lineStart' ? lineStartOf(state.value, base) : lineEndOf(state.value, base);
          return { ...state, cursor: target, selectionAnchor: null };
        }
        const startSide = dir === 'left' || dir === 'wordLeft';
        return { ...state, cursor: startSide ? sel.start : sel.end, selectionAnchor: null };
      }
      if (dir === 'up' || dir === 'down') return moveVertical(state, Number.POSITIVE_INFINITY, dir);
      if (dir === 'lineStart')
        return { ...state, cursor: lineStartOf(state.value, state.cursor), selectionAnchor: null };
      if (dir === 'lineEnd') return { ...state, cursor: lineEndOf(state.value, state.cursor), selectionAnchor: null };
      return { ...state, cursor: moveCursor(state.value, state.cursor, dir), selectionAnchor: null };
    }

    case 'select': {
      const anchor = state.selectionAnchor ?? snapToBoundary(graphemeBoundaries(state.value), state.cursor);
      const cursor = moveCursor(state.value, state.cursor, action.dir);
      return { ...state, selectionAnchor: anchor, cursor };
    }

    case 'selectAll':
      return { ...state, selectionAnchor: 0, cursor: state.value.length };

    case 'setValue': {
      const value = action.value;
      const boundaries = graphemeBoundaries(value);
      const cursor = action.cursor === undefined ? value.length : snapToBoundary(boundaries, action.cursor);
      return { value, cursor, selectionAnchor: null, composing: '' };
    }

    case 'clear':
      return createInputState('');

    default:
      return state;
  }
}

// —— 历史 ——
// 浏览历史时把「进入历史前的实时草稿」（含 cursor 与 selection）整体暂存，向下翻过最新条目后
// 原样恢复，满足验收项「历史往返恢复原 draft 与 selection」。

export interface HistoryState {
  entries: string[];
  /** -1 = 处于实时草稿（未浏览历史） */
  index: number;
  /** 进入历史时的草稿快照 */
  draft: InputState | null;
}

export interface HistoryResult {
  history: HistoryState;
  /** 本次移动后编辑器应采用的状态；null = 保持当前 */
  next: InputState | null;
}

export function createHistoryState(entries: readonly string[] = []): HistoryState {
  return { entries: [...entries], index: -1, draft: null };
}

/** §7 契约别名。 */
export const createHistory = createHistoryState;

export function historyPush(history: HistoryState, text: string): HistoryState {
  if (text.length === 0) return { ...history, index: -1, draft: null };
  return { entries: [...history.entries, text], index: -1, draft: null };
}

function entryState(entry: string): InputState {
  return createInputState(entry);
}

export function historyPrev(history: HistoryState, current: InputState): HistoryResult {
  if (history.entries.length === 0) return { history, next: null };
  if (history.index === -1) {
    const index = history.entries.length - 1;
    const entry = history.entries[index];
    if (entry === undefined) return { history, next: null };
    return { history: { ...history, index, draft: { ...current } }, next: entryState(entry) };
  }
  if (history.index === 0) return { history, next: null };
  const index = history.index - 1;
  const entry = history.entries[index];
  if (entry === undefined) return { history, next: null };
  return { history: { ...history, index }, next: entryState(entry) };
}

export function historyNext(history: HistoryState, _current: InputState): HistoryResult {
  if (history.index === -1) return { history, next: null };
  if (history.index < history.entries.length - 1) {
    const index = history.index + 1;
    const entry = history.entries[index];
    if (entry === undefined) return { history, next: null };
    return { history: { ...history, index }, next: entryState(entry) };
  }
  // 翻过最新条目：恢复原始 draft（含 selection），并回到实时态
  const restored = history.draft === null ? createInputState('') : { ...history.draft };
  return { history: { ...history, index: -1, draft: null }, next: restored };
}
