// chat-screen.ts — chat 整帧装配（P2 T2-7，headless 可测，零外部依赖）。
//
// 职责：把 scrollback / composer（候选 + 草稿 + 光标 + 底边指示）/ statusline / 快捷键条 /
// 多浮层栈装配进**一次** screen.render 回调，经 diff-presenter 产生单帧差量输出。
// 分层（自下而上，grok 语义）：shortcuts bar（固定 1 行）/ statusline（可选 1 行）/
// composer（自适应 = 草稿物理行 + 候选行 + 1 提示行）/ scrollback（其余全部）。
// 高度让位纯计算复用 renderer/layout.ts 的 columnLayout；浮层定位复用 next/overlay.ts 的
// overlayStackLayout（锚定 composerTop 之上）；内容宽度判定复用 cell-buffer 的 charWidth。
//
// 接口缺口（已收敛，见任务交接）：next/scrollback.ts 与 next/composer.ts 现已导出接受
// CellBuffer 的 draw 级 API（drawScrollback / drawComposer，纯 buffer 绘制、无 screen.render），
// 本文件在单次 screen.render 回调内直接调用它们装配整帧，不再复刻两库的绘制逻辑。
// composer 层映射：drawComposer 的候选画在草稿区上方、指示画在草稿区底行——把草稿区
// top 设为「层顶 + 候选行数」、height 设为「草稿可用行 + 提示行」，候选与指示恰好分别
// 落进层顶候选行与层底提示行。drawOverlay 本就接受 CellBuffer，直接复用。
//
// 设计取舍（钉死）：
// - composer 层内部自上而下 = 候选行（顶部）→ 草稿行 → 提示行（底行 1 行，恒保留；
//   indicators 右对齐画在此行，缺省留空）。候选画在层内而非 renderComposer 语义的
//   「区域上方」，为的是候选行计入 composer 高度让位（任务规格：composer 高度 =
//   measureComposer + candidateRows + 1）。
// - statusline 与 shortcuts 均左对齐（测试钉死）；shortcuts 数组以 ' · ' 连接。
// - statusline 为 undefined 或空串视为无该层（height 0）。
// - renderChat 每帧防御性同步 sb.cols = cols - 1（滚动条恒占最右列；与 resizeChat 同一契约）。
// - 极端小屏 composer 层被 columnLayout 截断时：候选优先、草稿按 drawComposer 的
//   贴底滚动兜底（offset = clamp(cursorRow - height + 1)，与 renderComposer 同语义），
//   提示行占层底行（与草稿重叠时后画获胜）。
import type { CellBuffer } from '../renderer/cell-buffer.js';
import { columnLayout, type LayerRect } from '../renderer/layout.js';
import type { Screen } from '../renderer/screen.js';
import { DEFAULT_ACTIVE_FG, candidateRows, drawComposer, measureComposer } from './composer.js';
import { drawOverlay, overlayNaturalHeight, overlayStackLayout, type OverlaySpec } from './overlay.js';
import { drawScrollback, writeRowClipped, type Scrollback } from './scrollback.js';

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

// --- 各层绘制（均在单次 screen.render 回调内调用；绘制体复用两库的 draw 级 API） ---

function drawScrollbackLayer(buf: CellBuffer, state: ChatScreenState, layer: LayerRect): void {
  if (layer.height <= 0) return; // 镜像 renderScrollback：零高度不渲染、不污染 viewportRows
  // width/fg/滚动条字符均用 drawScrollback 缺省值（= 原 chat-screen 复刻的常量：
  // width=buf.cols、内容区 = width-1、轨道 '│' / thumb '█'、fg 0）
  drawScrollback(buf, state.scrollback, { top: layer.top, height: layer.height });
}

function drawComposerLayer(buf: CellBuffer, state: ChatScreenState, layout: ChatLayout): void {
  const { top, height } = layout.composer;
  if (height <= 0 || top >= buf.rows) return; // 镜像 renderComposer：越界/零高度不渲染
  // composer 层内自上而下 = 候选行（层顶）→ 草稿行 → 提示行（层底，恒保留）。
  // drawComposer 语义：候选画在草稿区上方（底部锚定）、指示画在草稿区底行。
  // 映射：草稿区 top = 层顶 + 候选行数，height = 草稿可用行（draftCap）+ 提示行，
  // 候选/指示即分别落进层顶候选行与层底提示行；颜色等取 drawComposer 缺省值
  // （= 原 chat-screen 复刻常量：光标/active 候选 DEFAULT_*_FG，其余 0）。
  const draftTop = top + layout.candidateRows;
  const draftCap = Math.max(0, Math.min(top + height, buf.rows) - draftTop - 1); // 预留层底提示行
  drawComposer(
    buf,
    { draft: state.draft ?? '', cursor: state.cursor },
    {
      top: draftTop,
      height: draftCap + 1,
      candidates: state.candidates,
      indicators: state.indicators,
    },
  );
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
    drawScrollbackLayer(buf, state, layout.scrollback);
    drawComposerLayer(buf, state, layout);
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
