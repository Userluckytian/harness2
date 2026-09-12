// overlay.ts — 浮层锚定与渲染纯逻辑库（P2 T2-5，headless 可测，零外部依赖）。
//
// grok 弹层语义：Modal / SelectList / ConfirmDialog / 审批卡片等浮层统一**锚定在输入框
// 上方**（浮层底部贴 composerTop-1，向上生长），空间不足时钳到屏幕顶并截断高度——
// 输入框绝不被顶走（高度让位由装配层把 composerTop 传入本库实现，本库不改布局）。
//
// 职责边界（与既有资产的分工）：
// - 定位纯计算：anchorOverlay（单浮层）/ overlayStackLayout（多浮层栈，自下而上堆叠）。
// - 渲染：drawOverlay 直接写 CellBuffer（纯、headless 可测）；renderOverlay 是经
//   Screen.render 的便利入口（返回差量字节数，语义同 renderScrollback）。
//   注意：整帧装配（T2-6/T2-7）应把 drawOverlay 与 scrollback/composer 的绘制放进
//   **同一次** screen.render 回调（renderOverlay 每次调用都是独立一帧，仅供单测/调试）。
// - 行内容裁剪语义与 cell-buffer 一致：宽字符放不下整字丢弃（绝不切半边）、零宽字符跳过。
//
// 已知近似（登记）：CellBuffer（T2-1）只有前景色通道，无 bg/reverse 属性——「active 反色」
// 在 buffer 层不可表达，本库用 前缀 ❯ + activeFg 高亮前景色替代；如需真反色需扩展
// cell-buffer 的单元格模型（越出本任务边界，留待后续）。
import { charWidth, displayWidth } from '../renderer/cell-buffer.js';
import type { CellBuffer } from '../renderer/cell-buffer.js';
import { Screen } from '../renderer/screen.js';

/** 浮层矩形：距屏幕顶的起始行与高度（行） */
export interface OverlayRect {
  top: number;
  height: number;
}

export interface AnchorOverlayOptions {
  /** 屏幕总行数 */
  screenRows: number;
  /** 输入框（composer）顶行（0-based）；浮层允许占用 [0, composerTop) */
  composerTop: number;
  /** 浮层期望高度（行） */
  overlayHeight: number;
  /** 浮层最大高度（行，如 6 行列表）；缺省不限制 */
  maxHeight?: number;
}

/**
 * 单浮层锚定：底部贴 composerTop-1、向上生长；总高不足时钳到屏幕顶
 * （top=0、height=min(需求高度, composerTop)）；高度 0 → null（不渲染）。
 */
export function anchorOverlay(o: AnchorOverlayOptions): OverlayRect | null {
  const screenRows = Math.max(0, Math.floor(o.screenRows));
  const composerTop = Math.min(Math.max(0, Math.floor(o.composerTop)), screenRows);
  const want = Math.max(0, Math.floor(o.overlayHeight));
  const cap = o.maxHeight === undefined ? want : Math.max(0, Math.floor(o.maxHeight));
  const h = Math.min(want, cap);
  if (h <= 0) return null;
  const avail = composerTop; // 可用行：0..composerTop-1
  if (h <= avail) return { top: composerTop - h, height: h };
  return avail > 0 ? { top: 0, height: avail } : null;
}

export interface OverlayStackOptions {
  /** 屏幕总行数 */
  screenRows: number;
  /** 输入框顶行；栈底浮层允许占用 [0, composerTop) */
  composerTop: number;
  /** 自下而上的浮层高度列表：第 1 个贴 composer，第 2 个贴第 1 个上方…… */
  overlays: ReadonlyArray<{ height: number }>;
}

/**
 * 多浮层栈布局：自下而上堆叠（第 i 层底部 = 第 i-1 层顶部）。
 * 空间不足时上方的浮层被钳到屏幕顶并截断高度；完全无空间 → null（不渲染该层）。
 */
export function overlayStackLayout(o: OverlayStackOptions): (OverlayRect | null)[] {
  const screenRows = Math.max(0, Math.floor(o.screenRows));
  let bottom = Math.min(Math.max(0, Math.floor(o.composerTop)), screenRows);
  const out: (OverlayRect | null)[] = [];
  for (const ov of o.overlays) {
    const want = Math.max(0, Math.floor(ov.height));
    const h = Math.min(want, bottom);
    if (h <= 0) {
      out.push(null);
      continue;
    }
    const top = bottom - h;
    out.push({ top, height: h });
    bottom = top;
  }
  return out;
}

/** 条目：字符串或对象形式（对象形式留扩展位，如未来的 hint/description） */
export interface OverlayItem {
  label: string;
}

/** 浮层内容规格（与定位解耦：同一内容可画到任意矩形） */
export interface OverlaySpec {
  /** 标题行（渲染为 ` 标题 `，两侧留空格，与 SelectList 标题样式一致）；缺省无标题行 */
  title?: string;
  /** 条目列表 */
  items: ReadonlyArray<string | OverlayItem>;
  /** 高亮条目下标（越界/缺省 = 无高亮） */
  activeIndex?: number;
}

export interface OverlayDrawOptions {
  /** 渲染宽度（列），默认 buf.cols */
  width?: number;
  /** 条目区最大行数（不含标题/分隔线）；缺省 = 矩形内剩余全部行 */
  maxItemRows?: number;
  /** 非高亮行前景色（24bit RGB，0 = 默认色） */
  fg?: number;
  /** 高亮行前景色（近似反色：CellBuffer 无 bg/reverse 通道） */
  activeFg?: number;
  /** 高亮项前缀（默认 '❯ '；降级可用 '> '），非高亮项以等宽空格对齐 */
  activePrefix?: string;
  /** 分隔线字符（默认 '─'） */
  separatorChar?: string;
  /** 是否显示右侧数字直选序号 1.~9.（只标前 9 项，默认 false） */
  showNumbers?: boolean;
}

/** 滚动窗口：显示 [start, start+count) 的条目 */
export interface ItemWindow {
  start: number;
  count: number;
}

/**
 * 条目滚动窗口（类似 SelectList 的滚动语义）：条目数 ≤ maxRows 全量可见；
 * 超出时窗口跟随 activeIndex（active 始终可见；无有效 active 显示前 maxRows 项）。
 */
export function itemWindow(itemCount: number, maxRows: number, activeIndex?: number): ItemWindow {
  const n = Math.max(0, Math.floor(itemCount));
  const max = Math.max(0, Math.floor(maxRows));
  const count = Math.min(n, max);
  if (count <= 0) return { start: 0, count: 0 };
  const active = activeIndex === undefined ? -1 : Math.floor(activeIndex);
  if (active >= 0 && active < n && active >= max) {
    return { start: active - max + 1, count };
  }
  return { start: 0, count };
}

/** chrome 行数：标题（可选）+ 分隔线（恒 1 行） */
export function overlayChromeRows(spec: OverlaySpec): number {
  return (spec.title !== undefined && spec.title.length > 0 ? 1 : 0) + 1;
}

/**
 * 浮层自然总高度 = chrome + min(条目数, maxItemRows)。
 * 供装配层先算高度再传给 anchorOverlay / overlayStackLayout。
 */
export function overlayNaturalHeight(spec: OverlaySpec, maxItemRows?: number): number {
  const rows = maxItemRows === undefined ? spec.items.length : Math.min(spec.items.length, Math.max(0, maxItemRows));
  return overlayChromeRows(spec) + rows;
}

/** 按显示宽度截断字符串：宽字符放不下整字丢弃（不切半边），零宽字符跟随（与 cell-buffer 一致） */
function clipToWidth(text: string, maxCols: number): string {
  if (maxCols <= 0) return '';
  let w = 0;
  let out = '';
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (cw === 0) {
      out += ch;
      continue;
    }
    if (w + cw > maxCols) break;
    out += ch;
    w += cw;
  }
  return out;
}

/** 写一行并按 maxCols 裁剪（越界行由 setCell 静默忽略；宽字符安全） */
function writeRowClipped(buf: CellBuffer, y: number, text: string, maxCols: number, fg: number): void {
  let x = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (w === 0) continue;
    if (x + w > maxCols) break;
    buf.setCell(x, y, ch, w, fg);
    x += w;
  }
}

function normalizeItems(items: ReadonlyArray<string | OverlayItem>): OverlayItem[] {
  return items.map((it) => (typeof it === 'string' ? { label: it } : it));
}

/**
 * 把浮层内容画进 cell buffer 的 [layout.top, layout.top+layout.height) 行：
 * 标题行（` 标题 `，两侧留空格）→ 分隔线行（铺满 width）→ 条目行（滚动窗口 +
 * active 高亮前缀 + 可选右侧数字直选序号）。超宽整字丢弃截断。
 * 只触碰矩形内的行（矩形外不动，保证与同帧其他绘制的差量兼容）。
 */
export function drawOverlay(
  buf: CellBuffer,
  spec: OverlaySpec,
  layout: OverlayRect,
  opts: OverlayDrawOptions = {},
): void {
  const width = Math.max(1, Math.min(Math.floor(opts.width ?? buf.cols), buf.cols));
  const height = Math.floor(layout.height);
  if (!Number.isFinite(height) || height <= 0) return;
  const top = Math.floor(layout.top);
  let y = top;

  const fg = opts.fg ?? 0;
  const activeFg = opts.activeFg ?? fg;

  // 1) 标题行：` 标题 ` 两侧留空格（与 SelectList 样式一致）
  const hasTitle = spec.title !== undefined && spec.title.length > 0;
  if (hasTitle) {
    if (y >= top + height) return;
    writeRowClipped(buf, y, ` ${spec.title} `, width, fg);
    y += 1;
  }

  // 2) 分隔线行
  if (y >= top + height) return;
  const sep = opts.separatorChar ?? '─';
  writeRowClipped(buf, y, sep.repeat(width), width, fg);
  y += 1;

  // 3) 条目行：矩形内剩余行数与本选项 maxItemRows 取小
  const itemCapacity = Math.max(0, top + height - y);
  const maxItemRows =
    opts.maxItemRows === undefined ? itemCapacity : Math.min(Math.max(0, Math.floor(opts.maxItemRows)), itemCapacity);

  const items = normalizeItems(spec.items);
  const n = items.length;
  const active =
    spec.activeIndex !== undefined &&
    Number.isInteger(spec.activeIndex) &&
    spec.activeIndex >= 0 &&
    spec.activeIndex < n
      ? spec.activeIndex
      : -1;
  const win = itemWindow(n, maxItemRows, active === -1 ? undefined : active);

  const prefix = opts.activePrefix ?? '❯ ';
  // 前缀按显示宽度计量（CJK 前缀也对齐）；序号 ` n.` 恒 3 列
  const prefixWidth = displayWidth(clipToWidth(prefix, width));
  const prefixPad = ' '.repeat(prefixWidth);

  for (let i = 0; i < win.count; i += 1) {
    const gi = win.start + i;
    const item = items[gi];
    if (item === undefined) continue;
    const isActive = gi === active;
    const rowFg = isActive ? activeFg : fg;
    let row: string;
    if (opts.showNumbers === true && gi < 9) {
      // 右侧数字直选序号：` n.` 预留 3 列贴内容区右缘；标签给序号让位
      const marker = ` ${gi + 1}.`;
      const markerWidth = displayWidth(marker);
      const labelCols = Math.max(0, width - prefixWidth - markerWidth);
      const label = clipToWidth(item.label, labelCols);
      const pad = Math.max(0, width - prefixWidth - displayWidth(label) - markerWidth);
      row = (isActive ? prefix : prefixPad) + label + ' '.repeat(pad) + marker;
    } else {
      row = (isActive ? prefix : prefixPad) + clipToWidth(item.label, Math.max(0, width - prefixWidth));
    }
    writeRowClipped(buf, y, row, width, rowFg);
    y += 1;
  }
}

/**
 * 便利入口：经 Screen.render 把浮层画为一帧并差量输出，返回写入字节数（无差异 0），
 * 语义同 renderScrollback。整帧装配时应改用同帧回调内调 drawOverlay（见文件头注释）。
 */
export function renderOverlay(screen: Screen, spec: OverlaySpec, layout: OverlayRect, opts: OverlayDrawOptions = {}) {
  return screen.render((buf) => {
    drawOverlay(buf, spec, layout, opts);
  });
}
