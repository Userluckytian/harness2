// chat-screen.ts — chat 整帧装配（P2 T2-7，headless 可测，零外部依赖）。
//
// 职责：把 scrollback / composer（候选 + 草稿 + 光标 + 底边指示）/ statusline / 快捷键条 /
// 多浮层栈装配进**一次** screen.render 回调，经 diff-presenter 产生单帧差量输出。
// 分层（自下而上，grok 语义）：shortcuts bar（固定 1 行）/ statusline（可选 1 行）/
// composer（自适应 = 草稿物理行 + 候选行 + 1 提示行）/ scrollback（其余全部）。
// 高度让位纯计算复用 renderer/layout.ts 的 columnLayout；浮层定位复用 next/overlay.ts 的
// overlayStackLayout（锚定 composerTop 之上）；内容宽度判定复用 cell-buffer 的 charWidth。
//
// 接口缺口（如实登记，见任务交接）：next/scrollback.ts 的 renderScrollback 与 next/composer.ts
// 的 renderComposer 均内部自带 screen.render（整帧清空 back buffer 后 diff），**没有导出
// 接受 CellBuffer 的 draw 级 API**，无法与同帧其他层组合（串行调用会让后一帧把前一帧擦掉）。
// 因此本文件在单次 screen.render 回调内用两库导出的**纯逻辑 API**（Scrollback.visibleWindow /
// scrollbarInfo / measureComposer / candidateRows / wrapLine）自行绘制 scrollback 与 composer
// 层；绘制语义与 renderScrollback/renderComposer 逐条对齐（写入裁剪、光标续列钳制、候选
// 滚动窗口、指示器超宽左截断 + … 前缀），并由本文件快照钉死。drawOverlay 是例外——它本就
// 接受 CellBuffer，直接复用。建议后续任务给 scrollback.ts / composer.ts 各补一个
// drawXxx(buf, ...) 导出，把本文件的绘制部分替换为对它们的调用以消除重复。
//
// 设计取舍（钉死）：
// - composer 层内部自上而下 = 候选行（顶部）→ 草稿行 → 提示行（底行 1 行，恒保留；
//   indicators 右对齐画在此行，缺省留空）。候选画在层内而非 renderComposer 语义的
//   「区域上方」，为的是候选行计入 composer 高度让位（任务规格：composer 高度 =
//   measureComposer + candidateRows + 1）。
// - statusline 与 shortcuts 均左对齐（测试钉死）；shortcuts 数组以 ' · ' 连接。
// - statusline 为 undefined 或空串视为无该层（height 0）。
// - renderChat 每帧防御性同步 sb.cols = cols - 1（滚动条恒占最右列；与 resizeChat 同一契约）。
// - 极端小屏 composer 层被 columnLayout 截断时：候选优先、草稿以光标行贴底滚动兜底
//   （与 renderComposer 同语义），提示行占层底行（与草稿重叠时后画获胜）。
import { charWidth, displayWidth } from '../renderer/cell-buffer.js';
import type { CellBuffer } from '../renderer/cell-buffer.js';
import { columnLayout, type LayerRect } from '../renderer/layout.js';
import type { Screen } from '../renderer/screen.js';
import { DEFAULT_ACTIVE_FG, DEFAULT_CURSOR_FG, candidateRows, measureComposer } from './composer.js';
import { drawOverlay, overlayNaturalHeight, overlayStackLayout, type OverlaySpec } from './overlay.js';
import { scrollbarInfo, wrapLine, type Scrollback } from './scrollback.js';

/** 候选列表状态（画在 composer 层顶部，activeIndex 高亮 + 滚动窗口） */
export interface ChatCandidates {
  items: readonly string[];
  activeIndex: number;
}

/** Chat 整帧状态（renderChat 只接受状态、画出结果；按键处理不在本库） */
export interface ChatScreenState {
  /** 转录滚动区（cols 契约：内容区宽 = 屏宽 - 1 滚动条列，renderChat 每帧防御性同步） */
  scrollback: Scrollback;
  /** 草稿文本（'\n' 为硬换行） */
  draft: string;
  /** 逻辑光标（UTF-16 码元偏移；越界钳制） */
  cursor: number;
  /** 候选列表（null = 无） */
  candidates: ChatCandidates | null;
  /** 浮层栈，自下而上（栈底贴 composerTop-1） */
  overlays: readonly OverlaySpec[];
  /** 状态行文本（undefined / 空串 = 无该层） */
  statusline?: string;
  /** 快捷键条（数组以 ' · ' 连接；或直接给字符串） */
  shortcuts: readonly string[] | string;
  /** 底边指示（画在 composer 层底行右侧，' · ' 连接右对齐） */
  indicators?: readonly string[];
}

/** 各层矩形 + 分层中间量（导出供测试断言） */
export interface ChatLayout {
  scrollback: LayerRect;
  composer: LayerRect;
  statusline: LayerRect;
  shortcuts: LayerRect;
  /** 草稿物理行数（measureComposer.rows） */
  draftRows: number;
  /** 候选可见行数（candidateRows，0 = 无候选） */
  candidateRows: number;
}

/** 快捷键条连接符 */
export const SHORTCUTS_SEPARATOR = ' · ';

/** shortcuts 状态 → 行文本（数组 ' · ' 连接；字符串原样） */
export function shortcutsText(shortcuts: readonly string[] | string): string {
  return typeof shortcuts === 'string' ? shortcuts : shortcuts.join(SHORTCUTS_SEPARATOR);
}

/**
 * 纵向分层（纯计算）：composer 高度 = 草稿物理行 + 候选行 + 1 提示行；
 * statusline 有则 1 行；shortcuts 固定 1 行；其余全给 scrollback（flex）。
 * 极端小屏按 columnLayout 确定性退化：composer（先）→ statusline → shortcuts 依次截断。
 */
export function layoutChat(rows: number, cols: number, state: ChatScreenState): ChatLayout {
  const totalRows = Math.max(0, Math.floor(rows));
  const totalCols = Math.max(1, Math.floor(cols));
  const draft = state.draft ?? '';
  const draftRows = measureComposer(draft, totalCols, state.cursor).rows;
  const candRows = state.candidates === null ? 0 : candidateRows(state.candidates.items.length);
  const hasStatusline = typeof state.statusline === 'string' && state.statusline.length > 0;
  const rects = columnLayout({
    total: totalRows,
    layers: [
      { flex: 1 }, // scrollback：剩余全给
      { size: draftRows + candRows + 1 }, // composer（含提示行）
      ...(hasStatusline ? [{ size: 1 }] : []),
      { size: 1 }, // shortcuts bar
    ],
  });
  const composer = rects[1] ?? { top: 0, height: 0 };
  const statusline: LayerRect = hasStatusline
    ? (rects[2] ?? { top: 0, height: 0 })
    : { top: composer.top + composer.height, height: 0 };
  const shortcuts = hasStatusline ? (rects[3] ?? { top: 0, height: 0 }) : (rects[2] ?? { top: 0, height: 0 });
  return {
    scrollback: rects[0] ?? { top: 0, height: 0 },
    composer,
    statusline,
    shortcuts,
    draftRows,
    candidateRows: candRows,
  };
}

// --- 绘制基元（与 scrollback.ts / composer.ts 内部同语义；见文件头接口缺口说明） ---

/** 从 x=0 写一行并按 maxCols 裁剪（宽字符放不下整字丢弃、零宽跳过） */
function writeRowClipped(buf: CellBuffer, y: number, text: string, maxCols: number, fg: number): void {
  if (y < 0 || y >= buf.rows) return;
  let x = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (w === 0) continue;
    if (x + w > maxCols) break;
    buf.setCell(x, y, ch, w, fg);
    x += w;
  }
}

/** 从 x0 起写一行文本（右边界 maxX） */
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

/** 指示器右对齐适配：超宽时从左丢弃码点 + '…' 前缀（与 composer.ts fitIndicator 同语义） */
function fitRight(text: string, cols: number): string {
  if (cols <= 0) return '';
  if (displayWidth(text) <= cols) return text;
  const chars = [...text];
  const reserve = cols >= 2 ? 1 : 0;
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

/** 候选滚动窗口起始下标：窗口贴住 active（与 composer.ts candidateWindowStart 同语义） */
function candidateWindowStart(itemCount: number, windowRows: number, activeIndex: number): number {
  if (itemCount <= windowRows) return 0;
  return Math.min(Math.max(0, activeIndex - (windowRows - 1)), itemCount - windowRows);
}

/** 草稿 '\n' 分逻辑行（与 composer.ts splitLogicalLines 同语义：'ab\n' → ['ab', '']） */
function splitDraftLines(draft: string): string[] {
  const lines: string[] = [];
  let s = 0;
  for (;;) {
    const nl = draft.indexOf('\n', s);
    if (nl === -1) {
      lines.push(draft.slice(s));
      return lines;
    }
    lines.push(draft.slice(s, nl));
    s = nl + 1;
  }
}

// --- 各层绘制（均在单次 screen.render 回调内调用） ---

function drawScrollbackLayer(buf: CellBuffer, state: ChatScreenState, layer: LayerRect, contentCols: number): void {
  const { top, height } = layer;
  if (height <= 0 || top >= buf.rows) return; // 镜像 renderScrollback：越界/零高度不渲染、不污染 viewportRows
  const sb = state.scrollback;
  const win = sb.visibleWindow(height);
  for (let i = 0; i < win.rows.length; i += 1) {
    const row = win.rows[i];
    if (row === undefined) continue;
    writeRowClipped(buf, top + i, row.text, contentCols, 0);
  }
  const bar = scrollbarInfo(win.totalRows, win.viewportRows, win.scrollTop);
  const x = buf.cols - 1;
  for (let y = 0; y < win.viewportRows; y += 1) {
    const isThumb = bar.visible && y >= bar.thumbTop && y < bar.thumbTop + bar.thumbHeight;
    buf.setCell(x, top + y, isThumb ? '█' : '│', 1, 0);
  }
}

function drawComposerLayer(buf: CellBuffer, state: ChatScreenState, layout: ChatLayout, cols: number): void {
  const { top, height } = layout.composer;
  if (height <= 0 || top >= buf.rows) return;
  const layerBottom = Math.min(top + height, buf.rows); // 排他
  let y = top;

  // 1) 候选列表：层顶部，active 高亮 + 滚动窗口
  const cand = state.candidates;
  if (cand !== null && layout.candidateRows > 0) {
    const start = candidateWindowStart(cand.items.length, layout.candidateRows, cand.activeIndex);
    for (let k = 0; k < layout.candidateRows && y < layerBottom; k += 1, y += 1) {
      const item = cand.items[start + k] ?? '';
      const isActive = start + k === cand.activeIndex;
      writeRowClipped(buf, y, item, cols, isActive ? DEFAULT_ACTIVE_FG : 0);
    }
  }

  // 2) 草稿物理行（wrapLine 与 composer 断行同语义；截断时以光标行贴底滚动兜底）
  const draftCap = Math.max(0, layerBottom - y - 1); // 预留层底提示行
  const segments: string[] = [];
  for (const line of splitDraftLines(state.draft ?? '')) {
    for (const seg of wrapLine(line, cols)) segments.push(seg);
  }
  const m = measureComposer(state.draft ?? '', cols, state.cursor);
  const offset = Math.min(Math.max(0, m.cursorRow - draftCap + 1), Math.max(0, segments.length - draftCap));
  const draftTop = y;
  for (let i = 0; i < draftCap && i < segments.length; i += 1) {
    writeRowClipped(buf, draftTop + i, segments[offset + i] ?? '', cols, 0);
  }

  // 3) 光标高亮格（与 composer.ts 同逻辑：续列钳回首列；无反色位，fg 高亮近似）
  const cy = draftTop + m.cursorRow - offset;
  if (cy >= draftTop && cy < draftTop + draftCap && cy < buf.rows) {
    let x = Math.min(m.cursorCol, cols - 1);
    const idx = cy * buf.cols + x;
    if ((buf.widths[idx] ?? 0) === 0 && (buf.chars[idx] ?? '') === '') x = Math.max(0, x - 1);
    const idx2 = cy * buf.cols + x;
    const ch = buf.chars[idx2] ?? ' ';
    const w = (buf.widths[idx2] ?? 0) === 2 ? 2 : 1;
    buf.setCell(x, cy, ch === '' ? ' ' : ch, w, DEFAULT_CURSOR_FG);
  }

  // 4) 提示行：层底行，indicators ' · ' 连接右对齐（无指示器留空；与草稿重叠时后画获胜）
  const hintY = top + height - 1;
  const indicators = state.indicators ?? [];
  if (indicators.length > 0 && hintY < buf.rows) {
    const fitted = fitRight(indicators.join(SHORTCUTS_SEPARATOR), cols);
    if (fitted.length > 0) writeRowAt(buf, hintY, cols - displayWidth(fitted), fitted, cols, 0);
  }
}

function drawOverlays(buf: CellBuffer, state: ChatScreenState, layout: ChatLayout, cols: number): void {
  if (state.overlays.length === 0) return;
  const rects = overlayStackLayout({
    screenRows: buf.rows,
    composerTop: layout.composer.top,
    overlays: state.overlays.map((spec) => ({ height: overlayNaturalHeight(spec) })),
  });
  for (let i = 0; i < rects.length; i += 1) {
    const rect = rects[i];
    const spec = state.overlays[i];
    if (rect == null || spec === undefined) continue;
    drawOverlay(buf, spec, rect, { width: cols, activeFg: DEFAULT_ACTIVE_FG });
  }
}

/**
 * 整帧呈现：一次 screen.render 回调内画完全部层（scrollback 含滚动条 → composer 层
 * （候选/草稿/光标/提示行）→ statusline → shortcuts → 多浮层栈），diff-presenter 差量输出。
 * 返回本次写入字节数（无差异为 0；未 start 返回 0）。
 */
export function renderChat(screen: Screen, state: ChatScreenState): number {
  const cols = screen.cols;
  // scrollback cols 契约：内容区宽 = 屏宽 - 1 滚动条列（与 resizeChat 同一契约，防御性同步）
  const contentCols = Math.max(1, cols - 1);
  if (state.scrollback.cols !== contentCols) state.scrollback.setCols(contentCols);
  return screen.render((buf) => {
    const layout = layoutChat(screen.rows, cols, state);
    drawScrollbackLayer(buf, state, layout.scrollback, contentCols);
    drawComposerLayer(buf, state, layout, cols);
    if (layout.statusline.height > 0) {
      writeRowClipped(buf, layout.statusline.top, state.statusline ?? '', cols, 0);
    }
    if (layout.shortcuts.height > 0) {
      writeRowClipped(buf, layout.shortcuts.top, shortcutsText(state.shortcuts), cols, 0);
    }
    drawOverlays(buf, state, layout, cols);
  });
}

/**
 * 尺寸变化：screen.resize + sb.cols 契约同步（内容区宽 = cols - 1 滚动条列）。
 * wrap 缓存由 Scrollback.setCols 自行失效；下一帧 diff 自动全量重绘。
 */
export function resizeChat(screen: Screen, state: ChatScreenState, cols: number, rows: number): void {
  screen.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
  const contentCols = Math.max(1, screen.cols - 1);
  if (state.scrollback.cols !== contentCols) state.scrollback.setCols(contentCols);
}
