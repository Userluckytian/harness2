// composer.ts — 底部输入框（Composer）纯渲染/测量库（P2 T2-4，headless 可测，零外部依赖）。
//
// 职责边界（与既有资产的分工）：
// - 只做渲染与测量，**不做按键处理**（按键由统一输入层在接线任务处理；组件接口只接受
//   状态、画出结果）。行为参考只读的 Ink 版 `src/tui/Composer.tsx`。
// - 测量 measureComposer：多行草稿（\n 硬换行）+ 各行宽字符断行后的物理行数 + 光标
//   所在物理行/列——layout 层据此给 scrollback 扣高度（高度让位）。
// - 渲染 renderComposer：把草稿物理行画在给定 top/height 区域（草稿超出区域时以光标行
//   贴底滚动兜底，正常情况 layout 会给足 measureComposer().rows）；可选候选列表画在输入
//   区上方（最多 maxCandidates=6 行 + 滚动窗口 + active 高亮）；底边指示画在区域底行
//   右侧（模式 / model / 上下文占用等，右对齐、超宽左截断 + … 前缀）。
// - 宽度判定复用 renderer/cell-buffer.ts 的 charWidth/displayWidth；断行语义与
//   next/scrollback.ts 的 wrapLine 一致（宽字符整体移行绝不切半边、行首放不下不产生
//   空前导行、cols≤0 按 1 列兜底），但额外记录每段的码元偏移用于光标映射，故独立实现。
// - 差量帧：经 Screen.render → diff-presenter 自动产生；同状态重复渲染 0 字节。
//
// 已知取舍 / 近似（如实钉死）：
// - 光标"反色"：diff-presenter 的单元格只有 char+width+fg 三元组，不支持 SGR 7 反色位，
//   光标格以可配置前景色（cursorFg，默认亮绿）高亮近似；待 presenter 扩展 attribute
//   位后可无缝替换，接口不变。
// - cols=1 的极端窄区域下 CJK 字形整字丢弃（与 wrapLine/writeRowClipped 同一已知近似），
//   此时仅光标格可见。
// - 光标落在"行尾且该物理行恰好占满整个区域宽"时，物理上没有空格可反显，钳制高亮该行
//   最后一列的字符格（不新增物理行，避免测量与渲染不一致）。
// - emoji 代理对中间的非法光标偏移钳制到所在码点首列。
// - 指示器与草稿在同一底行重叠时指示器后画获胜（覆盖草稿尾部字符）。
import { charWidth, displayWidth } from '../renderer/cell-buffer.js';
import type { CellBuffer } from '../renderer/cell-buffer.js';
import { Screen } from '../renderer/screen.js';

/** 光标格默认高亮前景色（diff-presenter 无反色位的近似替代，见文件头说明） */
export const DEFAULT_CURSOR_FG = 0x00ff87;
/** active 候选默认高亮前景色 */
export const DEFAULT_ACTIVE_FG = 0x00ff87;
/** 候选窗口默认最大行数 */
export const DEFAULT_MAX_CANDIDATES = 6;

/** measureComposer 结果：草稿所需物理行数 + 光标物理位置（layout 据此做高度让位） */
export interface ComposerMeasure {
  /** 草稿渲染所需物理行数（\n 硬换行分行 + 各行宽字符断行；空草稿 = 1） */
  rows: number;
  /** 光标所在物理行（0-based，相对草稿区顶部） */
  cursorRow: number;
  /** 光标在该物理行内的显示列（0-based；行尾光标可等于行宽） */
  cursorCol: number;
}

/**
 * 测量草稿渲染所需物理行数与光标物理位置。
 * @param draft 草稿文本（'\n' 为硬换行）
 * @param cols 区域宽度（≤0 按 1 列兜底）
 * @param cursor 逻辑光标（UTF-16 码元偏移；缺省 = 草稿末尾；越界钳制）
 */
export function measureComposer(draft: string, cols: number, cursor?: number): ComposerMeasure {
  const layout = layoutDraft(draft, cols);
  const loc = locateCursor(layout, cursor ?? draft.length);
  return { rows: layout.segments.length, cursorRow: loc.segIndex, cursorCol: loc.col };
}

/** 候选窗口所需行数（itemCount 与 max 取小；接线任务算高度让位时加上它） */
export function candidateRows(itemCount: number, max: number = DEFAULT_MAX_CANDIDATES): number {
  return Math.max(0, Math.min(Math.floor(max), Math.floor(itemCount)));
}

/** 候选列表状态（画在输入区上方，activeIndex 高亮 + 滚动窗口） */
export interface ComposerCandidates {
  items: readonly string[];
  activeIndex: number;
}

/** Composer 渲染状态：只接受状态、画出结果（按键处理不在本库） */
export interface ComposerState {
  /** 草稿文本（'\n' 为硬换行） */
  draft: string;
  /** 逻辑光标（UTF-16 码元偏移；越界钳制） */
  cursor: number;
}

export interface ComposerRenderOptions {
  /** 输入区起始行（默认 = screen.rows - height，即贴底） */
  top?: number;
  /** 输入区行数（默认 = screen.rows - top；两者都缺省 = 1） */
  height?: number;
  /** 渲染宽度（默认 screen.cols；钳制到 screen.cols） */
  width?: number;
  /** 正文前景色（24bit RGB，0 = 默认色） */
  fg?: number;
  /** 是否画光标高亮格（默认 true；浮层打开时可 false） */
  cursorVisible?: boolean;
  /** 光标格前景色（默认 DEFAULT_CURSOR_FG；diff-presenter 无反色位的近似，见文件头） */
  cursorFg?: number;
  /** 候选列表（缺省/空数组不渲染） */
  candidates?: ComposerCandidates | null;
  /** 候选窗口最大行数（默认 6） */
  maxCandidates?: number;
  /** 非激活候选前景色（默认 0） */
  candidateFg?: number;
  /** 激活候选前景色（默认 DEFAULT_ACTIVE_FG） */
  candidateActiveFg?: number;
  /** 底边指示字符串数组（如 ['plan', 'claude-x', '42%']；缺省/空数组不渲染） */
  indicators?: readonly string[];
  /** 指示器前景色（默认 0） */
  indicatorFg?: number;
}

// --- 草稿排版（带码元偏移的断行，供光标映射） ---

interface Segment {
  /** 物理行文本 */
  text: string;
  /** 段首在 draft 中的 UTF-16 码元偏移 */
  start: number;
}

interface DraftLayout {
  /** 全部物理段（按行优先顺序） */
  segments: Segment[];
  /** 第 i 个逻辑行首个段在 segments 中的下标（长度 = 逻辑行数） */
  lineFirstSeg: number[];
  /** 第 i 个逻辑行内容区间 [start, end)（end = '\n' 位置或 draft.length） */
  lineRanges: { start: number; end: number }[];
}

/** 按 '\n' 分逻辑行（记录码元区间；'ab\n' → [0,2)+[3,3) 空行） */
function splitLogicalLines(draft: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let s = 0;
  for (;;) {
    const nl = draft.indexOf('\n', s);
    if (nl === -1) {
      ranges.push({ start: s, end: draft.length });
      return ranges;
    }
    ranges.push({ start: s, end: nl });
    s = nl + 1;
  }
}

/**
 * 宽字符感知断行（带码元偏移）。语义与 next/scrollback.ts 的 wrapLine 一致：
 * 宽字符行尾放不下整体移行（绝不切半边）；行首放不下不产生空前导行；cols≤0 按 1 列；
 * 零宽字符跟随当前行。
 */
function wrapSegments(text: string, base: number, cols: number): Segment[] {
  const maxCols = Math.max(1, Math.floor(cols));
  if (text.length === 0) return [{ text: '', start: base }];
  const out: Segment[] = [];
  let cur = '';
  let curStart = base;
  let curW = 0;
  let idx = base;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (w === 0) {
      cur += ch; // 零宽字符不占列，跟随当前行（近似）
      idx += ch.length;
      continue;
    }
    if (curW + w > maxCols) {
      if (w === 2 && curW < maxCols && cur.length > 0) {
        out.push({ text: cur, start: curStart });
        cur = ch;
        curStart = idx;
        curW = 2;
        idx += ch.length;
        continue;
      }
      if (cur.length > 0) out.push({ text: cur, start: curStart }); // 行首不推空段
      cur = ch;
      curStart = idx;
      curW = w;
      idx += ch.length;
      continue;
    }
    cur += ch;
    curW += w;
    idx += ch.length;
  }
  out.push({ text: cur, start: curStart });
  return out;
}

function layoutDraft(draft: string, cols: number): DraftLayout {
  const lineRanges = splitLogicalLines(draft);
  const segments: Segment[] = [];
  const lineFirstSeg: number[] = [];
  for (const r of lineRanges) {
    lineFirstSeg.push(segments.length);
    for (const seg of wrapSegments(draft.slice(r.start, r.end), r.start, cols)) {
      segments.push(seg);
    }
  }
  return { segments, lineFirstSeg, lineRanges };
}

interface CursorLocation {
  /** 物理段下标（= 光标所在物理行） */
  segIndex: number;
  /** 段内显示列（0-based；行尾光标可等于段显示宽） */
  col: number;
}

/** 光标（UTF-16 码元偏移）→ 物理段 + 段内显示列 */
function locateCursor(layout: DraftLayout, rawCursor: number): CursorLocation {
  const { segments, lineFirstSeg, lineRanges } = layout;
  // 钳制到草稿长度（末逻辑行的 end）
  const draftLen = lineRanges.length > 0 ? (lineRanges[lineRanges.length - 1]?.end ?? 0) : 0;
  const pos = Math.min(Math.max(0, Math.floor(rawCursor)), draftLen);
  // 光标所属逻辑行：最后一个 start <= pos 的行
  let lineIdx = 0;
  for (let i = 0; i < lineRanges.length; i += 1) {
    if ((lineRanges[i]?.start ?? 0) <= pos) lineIdx = i;
    else break;
  }
  const first = lineFirstSeg[lineIdx] ?? 0;
  const last =
    lineIdx + 1 < lineFirstSeg.length ? (lineFirstSeg[lineIdx + 1] ?? segments.length) - 1 : segments.length - 1;
  // 行内段：最后一个 start <= pos 的段
  let segIdx = first;
  for (let j = first; j <= last; j += 1) {
    if ((segments[j]?.start ?? 0) <= pos) segIdx = j;
    else break;
  }
  // 段内显示列：累加 pos 之前码点的宽度（代理对中间的非法偏移钳制到码点首列）
  const seg = segments[segIdx] ?? { text: '', start: 0 };
  let col = 0;
  let off = seg.start;
  for (const ch of seg.text) {
    if (off + ch.length > pos) break;
    col += charWidth(ch.codePointAt(0) ?? 0);
    off += ch.length;
  }
  return { segIndex: segIdx, col };
}

// --- 渲染 ---

/** 从 x0 起写一行文本，右边界 maxX（宽字符放不下整字丢弃，与 writeRowClipped 同语义） */
function writeRowAt(buf: CellBuffer, y: number, x0: number, text: string, maxX: number, fg: number): void {
  if (y < 0 || y >= buf.rows) return;
  let x = Math.max(0, Math.floor(x0));
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (w === 0) continue;
    if (x + w > maxX) break;
    buf.setCell(x, y, ch, w, fg);
    x += w;
  }
}

/** 候选滚动窗口起始下标：窗口贴住 active，钳制在 [0, items.length - n] */
function candidateWindowStart(itemCount: number, activeIndex: number, n: number): number {
  if (itemCount <= n) return 0;
  return Math.min(Math.max(0, activeIndex - (n - 1)), itemCount - n);
}

/** 指示器右对齐适配：超宽时从左丢弃码点 + '…' 前缀，保证显示宽 ≤ cols */
function fitIndicator(text: string, cols: number): string {
  if (cols <= 0) return '';
  if (displayWidth(text) <= cols) return text;
  const chars = [...text];
  const reserve = cols >= 2 ? 1 : 0; // '…' 占 1 列
  const target = cols - reserve;
  let out = '';
  let w = 0;
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const ch = chars[i] ?? '';
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > target) break;
    out = ch + out;
    w += cw;
  }
  return reserve ? `…${out}` : out;
}

/**
 * 组合渲染：把 Composer（草稿 + 光标 + 可选候选 + 底边指示）写入 screen 的 cell buffer，
 * 经 Screen.render 走 diff-presenter 产生差量帧。返回本次写入字节数（无差异为 0）。
 * 草稿物理行超出 height 时以光标行贴底滚动（兜底；正常情况 layout 给足 measure 行数）。
 * 越界（top ≥ screen.rows 或高度不足 1）返回 0。
 */
export function renderComposer(screen: Screen, state: ComposerState, opts: ComposerRenderOptions = {}): number {
  if (opts.top !== undefined && Math.floor(opts.top) >= screen.rows) return 0;
  const width = Math.max(1, Math.min(Math.floor(opts.width ?? screen.cols), screen.cols));
  const draft = state.draft ?? '';
  const layout = layoutDraft(draft, width);
  const cursor = Math.min(Math.max(0, Math.floor(state.cursor ?? draft.length)), draft.length);
  const loc = locateCursor(layout, cursor);
  const totalRows = layout.segments.length;

  // 区域解析：top 缺省贴底；height 缺省占满到屏底；两者都缺省 = 1 行
  let top: number;
  let height: number;
  if (opts.top === undefined && opts.height === undefined) {
    height = 1;
    top = screen.rows - 1;
  } else if (opts.top === undefined) {
    height = Math.max(1, Math.min(Math.floor(opts.height ?? 1), screen.rows));
    top = screen.rows - height;
  } else {
    top = Math.max(0, Math.floor(opts.top));
    if (top >= screen.rows) return 0;
    height = Math.max(1, Math.min(Math.floor(opts.height ?? screen.rows - top), screen.rows - top));
  }
  if (height < 1) return 0;

  // 滚动兜底：草稿超区域时以光标行贴底（offset = clamp(cursorRow - height + 1)）
  const offset = Math.min(Math.max(0, loc.segIndex - height + 1), Math.max(0, totalRows - height));

  const fg = opts.fg ?? 0;
  const cursorFg = opts.cursorFg ?? DEFAULT_CURSOR_FG;
  const candFg = opts.candidateFg ?? 0;
  const candActiveFg = opts.candidateActiveFg ?? DEFAULT_ACTIVE_FG;
  const indFg = opts.indicatorFg ?? 0;
  const drawCursor = opts.cursorVisible ?? true;
  const items = opts.candidates?.items ?? [];
  const activeIndex = Math.floor(opts.candidates?.activeIndex ?? 0);
  const maxCand = Math.max(1, Math.floor(opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES));
  const candCount = candidateRows(items.length, maxCand);
  const indicators = opts.indicators ?? [];

  return screen.render((buf) => {
    // 草稿物理行
    for (let i = 0; i < height; i += 1) {
      const seg = layout.segments[offset + i];
      if (seg === undefined) break;
      writeRowAt(buf, top + i, 0, seg.text, width, fg);
    }
    // 候选列表：输入区上方，底部锚定（最后一行 = top-1），越出屏顶裁剪
    if (candCount > 0) {
      const startIdx = candidateWindowStart(items.length, activeIndex, candCount);
      for (let k = 0; k < candCount; k += 1) {
        const y = top - candCount + k;
        if (y < 0) continue;
        const item = items[startIdx + k] ?? '';
        const isActive = startIdx + k === activeIndex;
        writeRowAt(buf, y, 0, item, width, isActive ? candActiveFg : candFg);
      }
    }
    // 底边指示：区域底行右侧右对齐；与草稿重叠时后画获胜
    if (indicators.length > 0) {
      const fitted = fitIndicator(indicators.join(' · '), width);
      if (fitted.length > 0) {
        const y = top + height - 1;
        writeRowAt(buf, y, width - displayWidth(fitted), fitted, width, indFg);
      }
    }
    // 光标高亮格：逻辑光标经断行映射后的物理位置
    if (drawCursor && loc.segIndex >= offset && loc.segIndex < offset + height) {
      const y = top + loc.segIndex - offset;
      let x = Math.min(loc.col, width - 1); // 行满且光标在行尾：钳制高亮最后一列
      const idx = y * buf.cols + x;
      if (buf.widths[idx] === 0 && (buf.chars[idx] ?? '') === '') {
        // 钳制列恰为宽字符续列：改高亮其首列，避免半宽空格破坏首列/续列配对
        x = Math.max(0, x - 1);
      }
      const idx2 = y * buf.cols + x;
      const ch = buf.chars[idx2] ?? ' ';
      const w = buf.widths[idx2] === 2 ? 2 : 1;
      buf.setCell(x, y, ch === '' ? ' ' : ch, w, cursorFg);
    }
  });
}
