// scrollback.ts — 转录滚动区纯逻辑库（P2 T2-3，headless 可测，零外部依赖）。
//
// 职责（与既有资产的边界）：
// - 行化：逻辑行 → 物理行。宽度判定复用 renderer/cell-buffer.ts 的 charWidth（内置
//   East Asian Wide 近似区段表）；断行算法移植自 P0 spike
//   `spike/tui-renderer-spike/selfdraw/scrollback.mjs` 的 wrapLine（宽字符放不下时整体
//   移到下一行，绝不切半边），并修正一处：断行点在行首时不产生空前导物理行。
// - 滚动模型：follow（贴底）/ anchor（!follow，scrollTopRow 物理行锚定——append 不推走
//   视口）。pageUp/wheelUp/goToTop 等上滚操作脱开 follow；scrollBy/pageDown/wheelDown
//   到达底部自动恢复 follow；scrollTopRow 全程钳制在 [0, maxScrollRow]。
// - 业务数据投影（transcript item → 文本行）不在本文件：T2-4/T2-5 接线时由调用方把
//   TranscriptItem 渲染成文本行喂给 append/appendLines（复用 transcript.ts 的
//   reducer/viewport 思路，原文件零改动）。行级前景色（P3-A）：append/appendLines/构造
//   接受 {text, fg} 行对象（字符串 = fg 缺省），PhysicalRow 沿所属逻辑行携带 fg，
//   drawScrollback 按行绘制（opts.fg 仅对无行级 fg 的行兜底）。
// - 绘制分两级：drawScrollback（纯 buffer 绘制，接受 CellBuffer，可与其他层在同一次
//   screen.render 回调内组合）与 renderScrollback（薄壳 = screen.render(buf => drawScrollback)，
//   经 diff-presenter 产生差量帧）。整帧装配（chat-screen）应使用 drawScrollback。
//
// 数据结构：每行断行结果按 lineIndex 惰性缓存（Map），prefix[i] = 前 i 个逻辑行的物理
// 行总数（惰性增长，append 增量扩展不重算）——与 spike scrollback 同思路。
import { charWidth } from '../renderer/cell-buffer.js';
import type { CellBuffer } from '../renderer/cell-buffer.js';
import { Screen } from '../renderer/screen.js';

/**
 * 宽字符感知断行：把一行文本按显示宽度断成若干物理行。
 * 来源：移植 P0 spike selfdraw/scrollback.mjs 的 wrapLine；宽度判定用 renderer/cell-buffer.ts
 * 的 charWidth。cols ≤ 0 按 1 列兜底；零宽字符（组合符/VS16/ZWJ）跟随当前行；
 * 宽字符在行尾放不下时提前断行（绝不切半边）；行首放不下不产生空前导行（spike 版会）。
 */
export function wrapLine(text: string, cols: number): string[] {
  const maxCols = Math.max(1, Math.floor(cols));
  if (text.length === 0) return [''];
  const out: string[] = [];
  let cur = '';
  let curW = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (w === 0) {
      cur += ch; // 零宽字符不占列，跟随当前行（近似）
      continue;
    }
    if (curW + w > maxCols) {
      if (w === 2 && curW < maxCols && cur.length > 0) {
        // 宽字符放不下：断行，宽字符整体移到下一行（绝不切半边）
        out.push(cur);
        cur = ch;
        curW = 2;
        continue;
      }
      if (cur.length > 0) out.push(cur); // 行首（cur 为空）不推空行
      cur = ch;
      curW = w;
      continue;
    }
    cur += ch;
    curW += w;
  }
  if (cur.length > 0 || out.length === 0) out.push(cur);
  return out;
}

/** 逻辑行：text 原样（可含宽字符，不裁剪不换行）；fg = 24bit RGB 前景色（undefined = 终端默认色） */
export interface ScrollbackLine {
  text: string;
  fg?: number;
}

/** append/appendLines/构造函数的行输入：字符串（fg 缺省）或行对象 */
export type LineInput = string | ScrollbackLine;

function toLine(l: LineInput): ScrollbackLine {
  return typeof l === 'string' ? { text: l } : l;
}

/** 物理行：text = 物理行文本；lineIndex = 所属逻辑行；segIndex = 逻辑行内第几段；fg 沿所属逻辑行（缺省 = 默认色） */
export interface PhysicalRow {
  text: string;
  lineIndex: number;
  segIndex: number;
  fg?: number;
}

/** visibleWindow 结果：scrollTop 为钳制后的物理行偏移；rows 恒等于 viewportRows 长度（不足补空行） */
export interface VisibleWindow {
  scrollTop: number;
  totalRows: number;
  viewportRows: number;
  rows: PhysicalRow[];
}

const EMPTY_ROW: PhysicalRow = { text: '', lineIndex: -1, segIndex: 0 };

/**
 * 转录滚动区：物理行级滚动模型（follow / anchor）。
 * cols 与渲染内容区宽度保持一致（滚动条占用的右列由 renderScrollback 扣除，
 * 调用方负责让 sb.cols === contentCols，本类不做自动同步以免反复失效缓存）。
 */
export class Scrollback {
  private lines: ScrollbackLine[];
  private colsValue: number;
  private wrapCache = new Map<number, string[]>();
  private prefix: number[]; // prefix[i] = 前 i 个逻辑行的物理行总数；有效范围 [0, built]
  private built = 0; // prefix 已构建到的逻辑行数
  private followFlag = true;
  private scrollTopValue = 0;
  private viewportRows = 24; // 由 visibleWindow 更新；缺省 24 供滚动操作在首次 visibleWindow 前使用

  constructor(lines: readonly LineInput[] = [], cols = 80) {
    this.lines = lines.map(toLine);
    this.colsValue = Math.max(1, Math.floor(cols));
    this.prefix = [0];
  }

  get cols(): number {
    return this.colsValue;
  }

  get lineCount(): number {
    return this.lines.length;
  }

  /** 总物理行数（惰性触发全量 wrap + 前缀和构建） */
  get totalRows(): number {
    this.ensurePrefix(this.lines.length);
    return this.prefix[this.lines.length] ?? 0;
  }

  get maxScrollRow(): number {
    // 视口行数由最近一次 visibleWindow/pageUp 等操作给出（缺省 24）
    return Math.max(0, this.totalRows - this.viewportRows);
  }

  get follow(): boolean {
    return this.followFlag;
  }

  get scrollTopRow(): number {
    return this.scrollTopValue;
  }

  /** 宽度变化：wrap 缓存与前缀和整体失效（scrollTop 在下次可见时按 maxScroll 钳制） */
  setCols(cols: number): void {
    const c = Math.max(1, Math.floor(cols));
    if (c === this.colsValue) return;
    this.colsValue = c;
    this.wrapCache.clear();
    this.prefix = [0];
    this.built = 0;
  }

  /** 第 i 逻辑行的物理行（缓存） */
  rowOf(lineIndex: number): string[] {
    let rows = this.wrapCache.get(lineIndex);
    if (rows === undefined) {
      rows = wrapLine(this.lines[lineIndex]?.text ?? '', this.colsValue);
      this.wrapCache.set(lineIndex, rows);
    }
    return rows;
  }

  /** 逻辑行 i 的起始物理行号 */
  lineStart(lineIndex: number): number {
    this.ensurePrefix(lineIndex);
    return this.prefix[lineIndex] ?? 0;
  }

  /** 追加一个逻辑行（字符串或 {text, fg} 行对象）：前缀和增量扩展（已构建部分不重算） */
  append(line: LineInput): void {
    this.lines.push(toLine(line));
    if (this.followFlag) this.scrollTopValue = this.maxScrollRow; // 贴底
    // anchor 模式：scrollTopRow 不变（新内容不推走视口）
  }

  /** 批量追加（一次贴底同步，O(新增)）；行对象/字符串可混排 */
  appendLines(lines: readonly LineInput[]): void {
    for (const l of lines) this.lines.push(toLine(l));
    if (this.followFlag) this.scrollTopValue = this.maxScrollRow;
  }

  /**
   * 滚动 n 物理行（正=向下）。上滚脱开 follow；到达底部恢复 follow；
   * 全程钳制在 [0, maxScrollRow]。内容不足一屏（maxScroll=0）时恒保持 follow。
   */
  scrollBy(n: number): void {
    const max = this.maxScrollRow;
    if (max === 0) {
      this.followFlag = true;
      this.scrollTopValue = 0;
      return;
    }
    if (this.followFlag) this.scrollTopValue = max;
    const target = this.scrollTopValue + n;
    if (target <= 0) {
      this.followFlag = false;
      this.scrollTopValue = Math.max(0, target);
      return;
    }
    if (target >= max) {
      this.followFlag = true;
      this.scrollTopValue = max;
      return;
    }
    this.followFlag = false;
    this.scrollTopValue = target;
  }

  pageUp(): void {
    this.scrollBy(-this.viewportRows);
  }

  pageDown(): void {
    this.scrollBy(this.viewportRows);
  }

  halfPageUp(): void {
    this.scrollBy(-Math.max(1, Math.floor(this.viewportRows / 2)));
  }

  halfPageDown(): void {
    this.scrollBy(Math.max(1, Math.floor(this.viewportRows / 2)));
  }

  wheelUp(): void {
    this.scrollBy(-3);
  }

  wheelDown(): void {
    this.scrollBy(3);
  }

  goToTop(): void {
    this.followFlag = false;
    this.scrollTopValue = 0;
  }

  goToBottom(): void {
    this.followFlag = true;
    this.scrollTopValue = this.maxScrollRow;
  }

  /**
   * 当前视口的物理行区间：follow 时重新贴底，anchor 时按 scrollTopRow（钳制）切片。
   * rows 恒为 viewportRows 条（内容不足补空行，lineIndex=-1）。
   */
  visibleWindow(viewportRows: number): VisibleWindow {
    const vp = Math.max(1, Math.floor(viewportRows));
    this.viewportRows = vp;
    const total = this.totalRows;
    let scrollTop: number;
    if (this.followFlag || total <= vp) {
      scrollTop = Math.max(0, total - vp);
      this.followFlag = true; // 不足一屏恒贴底
      this.scrollTopValue = scrollTop;
    } else {
      scrollTop = Math.min(Math.max(0, this.scrollTopValue), Math.max(0, total - vp));
      this.scrollTopValue = scrollTop;
    }
    // 二分找起始逻辑行（prefix 单调）
    let lo = 0;
    let hi = this.lines.length - 1;
    let lineIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.prefixAt(mid + 1) ?? 0) <= scrollTop) lo = mid + 1;
      else {
        lineIdx = mid;
        hi = mid - 1;
      }
    }
    let skip = scrollTop - (this.prefixAt(lineIdx) ?? 0);
    const rows: PhysicalRow[] = [];
    let need = vp;
    while (need > 0 && lineIdx < this.lines.length) {
      const segs = this.rowOf(lineIdx);
      const lineFg = this.lines[lineIdx]?.fg;
      for (let s = skip; s < segs.length && need > 0; s += 1) {
        rows.push(
          lineFg === undefined
            ? { text: segs[s] ?? '', lineIndex: lineIdx, segIndex: s }
            : { text: segs[s] ?? '', lineIndex: lineIdx, segIndex: s, fg: lineFg },
        );
        need -= 1;
      }
      skip = 0;
      lineIdx += 1;
    }
    while (need > 0) {
      rows.push(EMPTY_ROW);
      need -= 1;
    }
    return { scrollTop, totalRows: total, viewportRows: vp, rows };
  }

  /** prefix 前缀和构建到第 i 个逻辑行（含） */
  private ensurePrefix(i: number): void {
    const n = Math.min(i, this.lines.length);
    while (this.built < n) {
      this.prefix[this.built + 1] = (this.prefix[this.built] ?? 0) + this.rowOf(this.built).length;
      this.built += 1;
    }
  }

  private prefixAt(i: number): number {
    this.ensurePrefix(i);
    return this.prefix[i] ?? 0;
  }
}

/** 滚动条几何（纯计算，供渲染层画在右列） */
export interface ScrollbarInfo {
  /** totalRows > viewportRows 时可见 */
  visible: boolean;
  /** 轨道长度 = viewportRows */
  track: number;
  /** thumb 行数：max(1, floor(viewport² / total))；不可见时 = track（满轨） */
  thumbHeight: number;
  /** thumb 起始行（0-based，相对轨道顶部）；底部时 thumbTop + thumbHeight = track */
  thumbTop: number;
  /** 滚动比例 ∈ [0,1]；贴底/空内容 = 1 */
  ratio: number;
}

export function scrollbarInfo(totalRows: number, viewportRows: number, scrollTop: number): ScrollbarInfo {
  const track = Math.max(1, Math.floor(viewportRows));
  const maxScroll = Math.max(0, totalRows - track);
  if (totalRows <= track) {
    return { visible: false, track, thumbHeight: track, thumbTop: 0, ratio: 1 };
  }
  const thumbHeight = Math.max(1, Math.floor((track * track) / totalRows));
  const maxThumbTop = track - thumbHeight;
  const top = Math.min(Math.max(0, scrollTop), maxScroll);
  const ratio = maxScroll === 0 ? 1 : Math.min(1, Math.max(0, top / maxScroll));
  const thumbTop = Math.round((top / maxScroll) * maxThumbTop);
  return { visible: true, track, thumbHeight, thumbTop, ratio };
}

export interface ScrollbackRenderOptions {
  /** 屏幕起始行（相对 buffer 顶部），默认 0 */
  top?: number;
  /** 视口行数，默认 screen.rows - top */
  height?: number;
  /** 渲染总宽度，默认 screen.cols（滚动条画在最后一列） */
  width?: number;
  /** 正文兜底前景色（24bit RGB，0 = 默认色）：仅对无行级 fg 的物理行生效（行对象 fg 优先） */
  fg?: number;
  /** 是否画滚动条（默认 true） */
  scrollbar?: boolean;
  /** 轨道字符（默认 '│'） */
  trackChar?: string;
  /** thumb 字符（默认 '█'） */
  thumbChar?: string;
  /** 滚动条前景色（默认 0） */
  scrollbarFg?: number;
}

/**
 * 从 x=0 写一行并按 maxCols 裁剪：宽字符放不下整字丢弃、零宽字符跳过
 * （与 CellBuffer.writeText 同语义，但以 maxCols 为右边界——宽字符不会溢出进滚动条列）。
 * 导出供整帧装配层（chat-screen 的 statusline/shortcuts 等层）复用同一裁剪语义。
 */
export function writeRowClipped(buf: CellBuffer, y: number, text: string, maxCols: number, fg: number): void {
  if (y < 0 || y >= buf.rows) return; // 越界守卫（导出给装配层用，防御性）
  let x = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (w === 0) continue;
    if (x + w > maxCols) break;
    buf.setCell(x, y, ch, w, fg);
    x += w;
  }
}

/**
 * 纯 buffer 绘制：把 scrollback 可见窗口写入给定 cell buffer（右侧滚动条轨道列）。
 * renderScrollback 的绘制体（不做 screen.render，可与同帧其他层组合绘制）。
 * opts 尺寸缺省相对 buf：top=0、height=buf.rows-top、width=buf.cols。
 * 越界（top ≥ buf.rows）直接返回，不调用 visibleWindow（不把 viewportRows 状态污染成 1）。
 * 注意调用方保持 sb.cols === 内容区宽度（width - (scrollbar ? 1 : 0)）。
 * 已知近似：cols=1 的极端窄内容区下，宽字符物理行显示宽 2 超出 cols，writeRowClipped
 * 会整字丢弃 → 1 列宽度下 CJK 不可见（wrapLine 不做宽度 1 降级）。实际终端内容宽远大于 1。
 */
export function drawScrollback(buf: CellBuffer, sb: Scrollback, opts: ScrollbackRenderOptions = {}): void {
  const top = Math.max(0, Math.floor(opts.top ?? 0));
  if (top >= buf.rows) return; // 越界锚位：不渲染，也不把 viewportRows 状态污染成 1
  const height = Math.max(1, Math.min(Math.floor(opts.height ?? buf.rows - top), buf.rows - top));
  const width = Math.max(1, Math.min(Math.floor(opts.width ?? buf.cols), buf.cols));
  const useScrollbar = opts.scrollbar ?? true;
  const trackChar = opts.trackChar ?? '│';
  const thumbChar = opts.thumbChar ?? '█';
  const fg = opts.fg ?? 0;
  const sbFg = opts.scrollbarFg ?? 0;
  const contentCols = useScrollbar ? width - 1 : width;

  const win = sb.visibleWindow(height);
  for (let i = 0; i < win.rows.length; i += 1) {
    const row = win.rows[i];
    if (row === undefined) continue;
    // 逐行前景色（P3-A 配色落地）：行对象 fg 优先，缺省回退 opts.fg（0 = 终端默认色）
    writeRowClipped(buf, top + i, row.text, contentCols, row.fg ?? fg);
  }
  if (useScrollbar) {
    const bar = scrollbarInfo(win.totalRows, win.viewportRows, win.scrollTop);
    const x = width - 1;
    for (let y = 0; y < win.viewportRows; y += 1) {
      const isThumb = bar.visible && y >= bar.thumbTop && y < bar.thumbTop + bar.thumbHeight;
      buf.setCell(x, top + y, isThumb ? thumbChar : trackChar, 1, sbFg);
    }
  }
}

/**
 * 组合渲染：drawScrollback 的 Screen 便利入口——screen.render(buf => drawScrollback(...))，
 * 经 diff-presenter 产生差量帧。返回本次写入字节数（无差异为 0）。
 * 越界（top ≥ screen.rows）在 screen.render 之外早退返回 0（不清 back buffer、零输出）。
 * 整帧装配应改用 drawScrollback（同一次 render 回调内与其他层组合）。
 */
export function renderScrollback(screen: Screen, sb: Scrollback, opts: ScrollbackRenderOptions = {}): number {
  const top = Math.max(0, Math.floor(opts.top ?? 0));
  if (top >= screen.rows) return 0;
  return screen.render((buf) => drawScrollback(buf, sb, opts));
}
