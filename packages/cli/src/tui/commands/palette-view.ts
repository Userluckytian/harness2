// palette-view.ts — 命令面板纯绘制（P3-A，G-31/G-50：headless 可测，写 CellBuffer）。
//
// 职责边界：只做行组成与绘制，不做定位/按键——锚定复用 next/overlay.ts 的
// anchorOverlay / overlayStackLayout（浮层底部贴 composerTop-1、向上生长），按键归
// palette-model.ts 与接线层。行组成对齐上游 palette：标题「命令面板」（上游
// ActiveModal::CommandPalette message = "Commands"）+ 分隔线 + 组头行（不可选）+
// 命令行（active 前缀 ❯、label + 摘要、来源/模式 badge 右对齐）。
//
// 滚动窗口复用 overlay.ts 的 itemWindow（条目数 ≤ 容量全量可见；超出时窗口跟随
// active）。宽字符裁剪语义与 cell-buffer/overlay 一致：放不下整字丢弃、零宽字符跳过。
//
// 颜色近似（登记）：CellBuffer 只有前景色通道（无 bg/反色位），active 高亮用前景色
// （默认 0x00ff87，与 composer/overlay 的 active 色同源），组头/badge 用暗灰。
import { charWidth, displayWidth } from '../renderer/cell-buffer.js';
import type { CellBuffer } from '../renderer/cell-buffer.js';
import { itemWindow } from '../next/overlay.js';
import { paletteBadge, type PaletteRow, type PaletteState } from './palette-model.js';

/** 面板标题（上游 "Commands" 的中文呈现） */
export const PALETTE_TITLE = '命令面板';

/** active 行前缀（与 overlay.ts 默认前缀同形；非 active 用等宽空格对齐） */
export const PALETTE_ACTIVE_PREFIX = '❯ ';

/** active 行默认高亮前景色（与 composer.DEFAULT_ACTIVE_FG / theme dark.active 同源） */
export const PALETTE_ACTIVE_FG = 0x00ff87;

/** 组头/badge 默认前景色（暗灰，theme dark.system 同源） */
export const PALETTE_HEADER_FG = 0x8b949e;

export interface PaletteDrawOptions {
  /** 标题（默认 PALETTE_TITLE；空串 = 无标题行） */
  title?: string;
  /** 正文前景色（24bit RGB，0 = 默认色） */
  fg?: number;
  /** active 行前景色（默认 PALETTE_ACTIVE_FG） */
  activeFg?: number;
  /** 组头/badge 前景色（默认 PALETTE_HEADER_FG） */
  headerFg?: number;
  /** 条目区最大可见行数（缺省 = 矩形内剩余全部行） */
  maxRows?: number;
}

/** 面板自然高度 = 标题（可选 1 行）+ 分隔线 1 行 + min(行数, maxRows) */
export function paletteNaturalHeight(rowCount: number, opts: { title?: string; maxRows?: number } = {}): number {
  const title = opts.title ?? PALETTE_TITLE;
  const chrome = (title.length > 0 ? 1 : 0) + 1;
  const cap = opts.maxRows === undefined ? Math.max(0, Math.floor(rowCount)) : Math.max(0, Math.floor(opts.maxRows));
  return chrome + Math.min(Math.max(0, Math.floor(rowCount)), cap);
}

/** 从 x0 起写一行，右边界 maxX（宽字符放不下整字丢弃，与 overlay 的 writeRowClipped 同语义） */
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

/** 按显示宽度截断（宽字符放不下整字丢弃、零宽字符跳过） */
function clipToWidth(text: string, maxCols: number): string {
  let w = 0;
  let out = '';
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (cw === 0) continue;
    if (w + cw > maxCols) break;
    out += ch;
    w += cw;
  }
  return out;
}

/**
 * 把面板画进 cell buffer 的 [rect.top, rect.top+rect.height) 行：
 * 标题行（` 标题 `）→ 分隔线 → 条目行（滚动窗口 + active 前缀 + badge 右对齐）。
 * 只触碰矩形内的行；宽度不足时 badge 先让位、摘要后让位（label 保底）。
 * 越界（top ≥ buf.rows 或高度不足）直接返回、不绘制。
 */
export function drawPalette(
  buf: CellBuffer,
  state: PaletteState,
  rows: ReadonlyArray<PaletteRow>,
  rect: { readonly top: number; readonly height: number },
  opts: PaletteDrawOptions = {},
): void {
  const width = Math.max(1, buf.cols);
  const height = Math.floor(rect.height);
  if (!Number.isFinite(height) || height <= 0) return;
  const top = Math.max(0, Math.floor(rect.top));
  if (top >= buf.rows) return;

  const title = opts.title ?? PALETTE_TITLE;
  const fg = opts.fg ?? 0;
  const activeFg = opts.activeFg ?? PALETTE_ACTIVE_FG;
  const headerFg = opts.headerFg ?? PALETTE_HEADER_FG;

  let y = top;
  const bottom = Math.min(top + height, buf.rows);

  // 1) 标题行（` 标题 ` 两侧留空格，与 overlay.ts 标题样式一致）
  if (title.length > 0) {
    if (y >= bottom) return;
    writeRowAt(buf, y, 0, ` ${title} `, width, fg);
    y += 1;
  }
  // 2) 分隔线
  if (y >= bottom) return;
  writeRowAt(buf, y, 0, '─'.repeat(width), width, fg);
  y += 1;

  // 3) 条目行：矩形内剩余容量与 maxRows 取小 → 滚动窗口
  const capacity = Math.max(0, bottom - y);
  const maxRows = opts.maxRows === undefined ? capacity : Math.min(Math.max(0, Math.floor(opts.maxRows)), capacity);
  const win = itemWindow(rows.length, maxRows, state.active >= 0 ? state.active : undefined);
  const prefixWidth = displayWidth(PALETTE_ACTIVE_PREFIX);

  for (let i = 0; i < win.count; i += 1) {
    if (y >= bottom) break;
    const row = rows[win.start + i];
    if (row === undefined) continue;
    if (row.kind === 'header') {
      // 组头行：── 组名（不可选，暗灰）
      writeRowAt(buf, y, 0, `── ${row.label}`, width, headerFg);
    } else {
      // 命令行：前缀（2 列）+ label（含 argsSpec）+ 摘要 + badge 右对齐
      const active = win.start + i === state.active;
      const badge = `[${paletteBadge(row.entry)}]`;
      const badgeWidth = displayWidth(badge);
      const contentCols = Math.max(0, width - prefixWidth);
      // badge 让位：内容区（除前缀与 badge 外）至少还能放下 4 列 label 才画 badge
      const badgeCols = contentCols - badgeWidth - 1 >= 4 ? badgeWidth + 1 : 0; // 1 列间隔
      const bodyCols = contentCols - badgeCols;
      const label = `/${row.entry.name}`;
      // 摘要拼在 label 后（argsSpec 不进面板行——summary 文案已内嵌用法，如 /undo [n]）
      let body = `${label}  ${row.entry.summary}`;
      if (displayWidth(body) > bodyCols) body = `${label}`; // 摘要让位（label 保底）
      const clipped = clipToWidth(body, bodyCols);
      const pad = Math.max(0, bodyCols - displayWidth(clipped));
      const line = (active ? PALETTE_ACTIVE_PREFIX : ' '.repeat(prefixWidth)) + clipped + ' '.repeat(pad);
      writeRowAt(buf, y, 0, badgeCols > 0 ? `${line}${badge}` : line, width, active ? activeFg : fg);
    }
    y += 1;
  }
}
