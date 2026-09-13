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
//
// P4-1 选择与超链接（2026-09-12）：
// - 超链接（OSC8）：drawScrollback 绘制每物理行时检测 `https?://` 连续非空白区段
//   （detectUrlSegments），按显示列把区段各格标记 linkId（URL 注册进 CellBuffer 的
//   linkId→URL 表，presenter 每帧按 run 包裹 OSC8）。检测按物理行独立进行——软折行把
//   URL 切断时尾部区段不匹配 `https?://` 前缀、不标链接（不给错误 href，如实近似）。
//   开关 HARNESS2_OSC8=0 时检测整体旁路（本层 env 判定，presenter 侧同样有开关兜底）。
// - 文本选择：几何状态（anchor/head 物理行坐标）挂在 Scrollback 实例上；渲染为
//   **fg 换色**（SELECTION_FG 亮青，深底终端下的选中近似反色）——不引入 bg 属性位，
//   presenter/既有 renderer 测试零改动。宽字符选中判定按首列（首列命中则整字 +
//   续列同色，不切半边）。开关 HARNESS2_SELECT=0 时由装配层（next-shell）旁路：
//   鼠标/键盘路径不产生选择态，本层纯库不读该开关（选择态只能经装配层写入）。
// - getSelectedText 取舍（钉死）：物理行文本 + 行间分隔；**同逻辑行的软折行段直接
//   拼接（不加 \n）**，仅不同逻辑行间加 \n——既避免物理行重组的换行噪音，又不做
//   完整逻辑行重组（部分列选择的中间段无从对齐）。零宽字符不进复制文本（近似）。
import { charWidth, displayWidth } from '../renderer/cell-buffer.js';
import type { CellBuffer } from '../renderer/cell-buffer.js';
import { Screen } from '../renderer/screen.js';

/** 选择坐标点：row = 绝对物理行号，col = 显示列（0 基） */
export interface SelectionPoint {
  row: number;
  col: number;
}

/** 归一化选择区间：start ≤ end（物理行坐标） */
export interface SelectionRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** 选中高亮前景色（P4-1 fg 换色方案：亮青，深底终端下的选中近似反色） */
export const SELECTION_FG = 0x22d3ee;

/** URL 区段：[startCol, endCol) 显示列区间 + 区段原文（即 href） */
export interface LinkSegment {
  startCol: number;
  endCol: number;
  url: string;
}

const URL_RE = /https?:\/\/[^\s]+/g;

/**
 * 行内 URL 区段检测（P4-1）：`https?://` 开头的连续非空白区段 → 显示列区间。
 * 按 UTF-16 匹配索引换算显示列（宽字符 2 列、零宽 0 列）；一行多 URL 各自成段。
 * 注意：按物理行独立检测——软折行切断 URL 时尾部区段无 `https?://` 前缀、不产出
 * （不给错误 href；已知近似，见文件头）。
 */
export function detectUrlSegments(text: string): LinkSegment[] {
  const out: LinkSegment[] = [];
  if (text.length === 0) return out;
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m[0].length === 0) {
      URL_RE.lastIndex += 1; // 防御：空匹配死循环
      continue;
    }
    // 尾部标点不入 href（审查 P2-1）：中英文句读/括号引号贴在 URL 尾上时视为句子标点
    let url = m[0];
    let end = m.index + m[0].length;
    while (url.length > 0 && TRAILING_PUNCT.has(url.charAt(url.length - 1))) {
      url = url.slice(0, -1);
      end -= 1;
    }
    if (url.length === 0) continue;
    out.push({ startCol: colAt(text, m.index), endCol: colAt(text, end), url });
  }
  return out;
}

/** URL 尾部剥离的标点（中英文句读与成对符号闭口侧） */
const TRAILING_PUNCT = new Set([
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  '。',
  '，',
  '；',
  '：',
  '！',
  '？',
  '）',
  '】',
  '』',
  '」',
  ')',
  ']',
  '}',
  '>',
  '\"',
  "'",
  '`',
]);

/** UTF-16 索引 → 该处字符的起始显示列（索引落在行尾/零宽字符上时取已累计列数） */
function colAt(text: string, utf16Index: number): number {
  let col = 0;
  let idx = 0;
  for (const ch of text) {
    if (idx >= utf16Index) break;
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (idx + ch.length > utf16Index) break; // 索引落在多码点字符中间：取当前列
    if (w > 0) col += w;
    idx += ch.length;
  }
  return col;
}

/** 按显示列切片：首列落在 [colStart, colEnd) 的字符整字入选（宽字符首列判定） */
function sliceByCols(text: string, colStart: number, colEnd: number, rowWidth: number): string {
  const start = Math.min(Math.max(0, colStart), rowWidth);
  const end = Math.min(Math.max(0, colEnd), rowWidth);
  if (start >= end) return '';
  let col = 0;
  let out = '';
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (w === 0) continue; // 零宽字符不进复制文本（近似，见文件头）
    if (col >= start && col < end) out += ch;
    col += w;
  }
  return out;
}

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
  // —— P4-1 选择几何（物理行坐标；anchor = 拖选起点，head = 当前拖动点）——
  private selAnchor: SelectionPoint | null = null;
  private selHead: SelectionPoint | null = null;

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

  // —— P4-1 选择几何（物理行坐标；装配层 next-shell 的鼠标/键盘路径调用）——

  /** 开始选择（鼠标按下）：anchor = head = p（行/列钳制到非负） */
  beginSelection(p: SelectionPoint): void {
    const point = { row: Math.max(0, Math.floor(p.row)), col: Math.max(0, Math.floor(p.col)) };
    this.selAnchor = point;
    this.selHead = point;
  }

  /** 扩展选择（拖动 move）：只移动 head，方向无关（selectionRange 归一化） */
  extendSelection(p: SelectionPoint): void {
    if (this.selAnchor === null) {
      this.beginSelection(p);
      return;
    }
    this.selHead = { row: Math.max(0, Math.floor(p.row)), col: Math.max(0, Math.floor(p.col)) };
  }

  /** 清除选择（单击无移动 / Esc / 复制完成） */
  clearSelection(): void {
    this.selAnchor = null;
    this.selHead = null;
  }

  /** 是否存在非零宽选择（begin 未拖动 = 零宽 = 无选择，Ctrl+C 不劫持） */
  get hasSelection(): boolean {
    const r = this.selectionRange();
    return r !== null && !(r.startRow === r.endRow && r.startCol === r.endCol);
  }

  /** 归一化选择区间（start ≤ end；无选择 = null） */
  selectionRange(): SelectionRange | null {
    if (this.selAnchor === null || this.selHead === null) return null;
    const a = this.selAnchor;
    const h = this.selHead;
    const aFirst = a.row < h.row || (a.row === h.row && a.col <= h.col);
    const [s, e] = aFirst ? [a, h] : [h, a];
    return { startRow: s.row, startCol: s.col, endRow: e.row, endCol: e.col };
  }

  /** 绝对物理行 → 行信息（text 为该物理行原文；越界 = null） */
  physicalRowAt(absRow: number): PhysicalRow | null {
    const total = this.totalRows;
    if (absRow < 0 || absRow >= total) return null;
    // 二分找 lineIdx：prefix[lineIdx] ≤ absRow < prefix[lineIdx+1]
    let lo = 0;
    let hi = this.lines.length - 1;
    let lineIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.prefixAt(mid + 1) ?? 0) <= absRow) lo = mid + 1;
      else {
        lineIdx = mid;
        hi = mid - 1;
      }
    }
    const segIndex = absRow - (this.prefixAt(lineIdx) ?? 0);
    return { text: this.rowOf(lineIdx)[segIndex] ?? '', lineIndex: lineIdx, segIndex };
  }

  /**
   * 选中文本（P4-1 取舍见文件头）：首/尾行按列切片、中间行整行；同逻辑行软折行段
   * 直接拼接（不加 \n），不同逻辑行间以 \n 连接。宽字符按首列整字判定；零宽字符不进文本。
   */
  getSelectedText(): string {
    const r = this.selectionRange();
    if (r === null) return '';
    const parts: string[] = [];
    let prevLineIndex = -1;
    let prevSegContiguous = false;
    for (let row = r.startRow; row <= r.endRow; row += 1) {
      const info = this.physicalRowAt(row);
      if (info === null) {
        prevSegContiguous = false; // 行缺失（选择越出内容区）：打断软折行拼接
        continue;
      }
      const rowWidth = displayWidth(info.text);
      let colStart: number;
      let colEnd: number;
      if (r.startRow === r.endRow) {
        colStart = r.startCol;
        colEnd = r.endCol;
      } else if (row === r.startRow) {
        colStart = r.startCol;
        colEnd = Number.MAX_SAFE_INTEGER;
      } else if (row === r.endRow) {
        colStart = 0;
        colEnd = r.endCol;
      } else {
        colStart = 0;
        colEnd = Number.MAX_SAFE_INTEGER;
      }
      const piece = sliceByCols(info.text, colStart, colEnd, rowWidth);
      const sameLogicalLine = info.lineIndex === prevLineIndex && prevSegContiguous;
      if (sameLogicalLine && parts.length > 0) {
        parts[parts.length - 1] = (parts[parts.length - 1] ?? '') + piece; // 软折行段拼接（去换行噪音）
      } else {
        parts.push(piece);
      }
      prevLineIndex = info.lineIndex;
      prevSegContiguous = true;
    }
    return parts.join('\n');
  } /** prefix 前缀和构建到第 i 个逻辑行（含） */
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
  /** 环境变量源（OSC8 开关判定；缺省 process.env——装配层传 deps.env 以单源） */
  env?: NodeJS.ProcessEnv;
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
  // P4-1 开关（=0 完全旁路 URL 检测/标记）：优先用调用方注入的 env（与 presenter 单源，审查 P2-3）
  const linksOn = (opts.env ?? process.env).HARNESS2_OSC8 !== '0';
  const sel = sb.selectionRange(); // P4-1 选择高亮（fg 换色；无选择 = null 零影响）

  const win = sb.visibleWindow(height);
  for (let i = 0; i < win.rows.length; i += 1) {
    const row = win.rows[i];
    if (row === undefined) continue;
    // 逐行前景色（P3-A 配色落地）：行对象 fg 优先，缺省回退 opts.fg（0 = 终端默认色）
    writeRowClipped(buf, top + i, row.text, contentCols, row.fg ?? fg);
    const absRow = win.scrollTop + i;
    if (linksOn && row.lineIndex >= 0) markLinkSegments(buf, top + i, row.text, contentCols);
    if (sel !== null) applySelectionHighlight(buf, top + i, absRow, sel, contentCols);
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

/** 把一行的 URL 区段标进 buffer（linkId + 注册表）；空白截断区（未被写入的格子）跳过 */
function markLinkSegments(buf: CellBuffer, y: number, text: string, maxCols: number): void {
  for (const seg of detectUrlSegments(text)) {
    if (seg.startCol >= maxCols) continue;
    const id = buf.registerLink(seg.url);
    const end = Math.min(seg.endCol, maxCols);
    for (let x = seg.startCol; x < end; x += 1) {
      const idx = y * buf.cols + x;
      const ch = buf.chars[idx] ?? ' ';
      const w = buf.widths[idx] ?? 0;
      if (ch === ' ' && w === 0) continue; // 空白截断区未写入（宽字符放不下整字丢弃）：不标
      buf.setLinkId(x, y, id);
    }
  }
}

/** 选择高亮（fg 换色）：选中格置 SELECTION_FG；纯空白格写为半宽空格高亮（避免 w0 空格差量畸变） */
function applySelectionHighlight(
  buf: CellBuffer,
  y: number,
  absRow: number,
  sel: SelectionRange,
  maxCols: number,
): void {
  if (absRow < sel.startRow || absRow > sel.endRow) return;
  let colStart: number;
  let colEnd: number;
  if (sel.startRow === sel.endRow) {
    colStart = sel.startCol;
    colEnd = sel.endCol;
  } else if (absRow === sel.startRow) {
    colStart = sel.startCol;
    colEnd = Number.MAX_SAFE_INTEGER;
  } else if (absRow === sel.endRow) {
    colStart = 0;
    colEnd = sel.endCol;
  } else {
    colStart = 0;
    colEnd = Number.MAX_SAFE_INTEGER;
  }
  const from = Math.max(0, colStart);
  const to = Math.min(colEnd, maxCols);
  for (let x = from; x < to; x += 1) {
    const idx = y * buf.cols + x;
    const ch = buf.chars[idx] ?? ' ';
    const w = buf.widths[idx] ?? 0;
    if (ch === ' ' && w === 0) buf.setCell(x, y, ' ', 1, SELECTION_FG);
    else buf.setCell(x, y, ch, w as 0 | 1 | 2, SELECTION_FG); // 保 char/width/linkId，仅换 fg
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
