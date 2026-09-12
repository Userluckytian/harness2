// scrollback.mjs — 10k 行转录的滚动模型（方案B）：
// - 行 → 物理行：宽字符感知软断行（宽度达 cols 前断行；宽字符放不下时提前断，绝不切半边）。
//   每行断行结果按 lineIndex 缓存（Map），cols 变化时整体失效。
// - 滚动：物理行级 scrollTop + follow 贴尾；wheel/PgUp/PgDn 离开 follow，回底自动恢复 follow。
// - 视图：view() 返回当前 viewport 的物理行内容（含逻辑行号），供 CellBuffer 填充。
// - 追加行：append() 增量更新（新行单独断行，前缀和不重算全部）。
// - 零外部依赖。

import { charWidth } from './cell-buffer.mjs';

/** 宽字符感知断行：把一行文本按显示宽度断成若干物理行（不切半边宽字符） */
export function wrapLine(text, cols) {
  if (text.length === 0) return [''];
  const out = [];
  let cur = '';
  let curW = 0;
  let pendingWide = null; // 放不下的宽字符，带到下一行
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0));
    if (w === 0) {
      cur += ch; // 零宽字符跟随当前行（近似）
      continue;
    }
    if (curW + w > cols) {
      if (w === 2 && curW < cols) {
        // 宽字符放不下：断行，宽字符移到下一行（绝不切半边）
        out.push(cur);
        cur = ch;
        curW = 2;
        continue;
      }
      out.push(cur);
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

export class Scrollback {
  /**
   * @param lines 逻辑行文本数组
   * @param cols  渲染宽度（列数）
   */
  constructor(lines, cols) {
    this.lines = lines;
    this.cols = cols;
    this.wrapCache = new Map(); // lineIndex -> string[]（物理行）
    this.prefix = [0]; // prefix[i] = 前 i 个逻辑行的物理行总数（惰性增长）
    this.built = 0; // prefix 已构建到的逻辑行数
    this.follow = true;
    this.scrollTopRow = 0; // 物理行偏移（非 follow 时有效）
    this.viewportRows = 24; // 由 view() 更新；构造期默认值供 maxScrollRow 使用
  }

  setCols(cols) {
    if (cols === this.cols) return;
    this.cols = cols;
    this.wrapCache.clear();
    this.prefix = [0];
    this.built = 0;
  }

  /** 第 i 逻辑行的物理行（缓存） */
  rowOf(i) {
    let rows = this.wrapCache.get(i);
    if (rows === undefined) {
      rows = wrapLine(this.lines[i], this.cols);
      this.wrapCache.set(i, rows);
    }
    return rows;
  }

  /** 前缀和构建到第 i 行（含），返回累计物理行数数组访问器 */
  _ensurePrefix(i) {
    while (this.built <= i) {
      this.prefix[this.built + 1] = this.prefix[this.built] + this.rowOf(this.built).length;
      this.built += 1;
    }
  }

  /** 逻辑行 i 的起始物理行号 */
  lineStart(i) {
    this._ensurePrefix(i);
    return this.prefix[i];
  }

  get totalRows() {
    this._ensurePrefix(this.lines.length - 1);
    return this.prefix[this.lines.length];
  }

  get maxScrollRow() {
    return Math.max(0, this.totalRows - this.viewportRows);
  }

  /** 滚动 n 物理行（负=上）；到达底部时恢复 follow */
  scroll(n) {
    if (this.follow) this.scrollTopRow = this.maxScrollRow;
    this.scrollTopRow = Math.max(0, Math.min(this.maxScrollRow, this.scrollTopRow + n));
    if (this.scrollTopRow >= this.maxScrollRow) {
      this.follow = true;
      this.scrollTopRow = this.maxScrollRow;
    }
  }

  wheelUp() { this.follow = false; this.scroll(-3); }
  wheelDown() { this.scroll(3); }
  pageUp() { this.follow = false; this.scroll(-this.viewportRows); }
  pageDown() { this.scroll(this.viewportRows); }
  goToTop() { this.follow = false; this.scrollTopRow = 0; }
  goToBottom() { this.follow = true; this.scrollTopRow = this.maxScrollRow; }

  append(text) {
    this.lines.push(text);
    // 前缀和：新行追加（保持已构建前缀有效）
    const last = this.prefix[this.built] ?? 0;
    const rows = this.rowOf(this.lines.length - 1).length;
    // built 可能小于 lines.length-1（旧行前缀未构建）；确保前面先补齐
    if (this.built < this.lines.length - 1) {
      this._ensurePrefix(this.lines.length - 2);
    }
    this.prefix[this.lines.length] = (this.prefix[this.lines.length - 1] ?? 0) + rows;
    this.built = this.lines.length;
  }

  /** 返回当前 viewport 物理行内容：[{text, lineIndex}]；viewportRows 由渲染层设置 */
  view(viewportRows) {
    this.viewportRows = viewportRows;
    if (this.follow) this.scrollTopRow = this.maxScrollRow;
    const start = this.scrollTopRow;
    const out = [];
    // 二分找起始逻辑行
    let lo = 0;
    let hi = this.lines.length - 1;
    let lineIdx = 0;
    this._ensurePrefix(hi);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      this._ensurePrefix(mid + 1);
      if (this.prefix[mid + 1] <= start) lo = mid + 1;
      else { lineIdx = mid; hi = mid - 1; }
    }
    let skip = start - this.prefix[lineIdx];
    let need = viewportRows;
    while (need > 0 && lineIdx < this.lines.length) {
      const rows = this.rowOf(lineIdx);
      for (let r = skip; r < rows.length && need > 0; r += 1) {
        out.push({ text: rows[r], lineIndex: lineIdx });
        need -= 1;
      }
      skip = 0;
      lineIdx += 1;
    }
    while (need > 0) { out.push({ text: '', lineIndex: -1 }); need -= 1; }
    return out;
  }
}
