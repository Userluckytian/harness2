// cell-buffer.mjs — 字符网格 buffer（方案B 核心）：
// - 每个单元格存 char + 显示宽度 + 前景色；宽字符占 2 列，续列格子宽度记 0。
// - 宽度判定用内置 East Asian Wide/Fullwidth 区段表（近似）：
//     * emoji 一律按 2 列处理（unicode emoji-presentation 集合未完整收录，已知近似）；
//     * 组合字符/零宽字符按 0 列（未实现完整 grapheme 分割，已知近似）；
//     * VS16 变体选择符不单独处理（跟随 base 字符，可能多算 0 列差异）。
//   生产实现建议换 string-width 级别的精确表；spike 内置表覆盖 CJK 主区段已足够基准可比。
// - 零外部依赖（Node 内置 only）。

/** East Asian Wide / Fullwidth 近似区段表（含常见 emoji 段，一律按 2 列） */
const WIDE_RANGES = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2329, 0x232a],
  [0x2e80, 0x303e], // CJK 部首/符号
  [0x3041, 0x33ff], // 平假名~CJK 符号
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意
  [0xfe30, 0xfe4f], // CJK 兼容形式
  [0xff00, 0xff60], // 全角 ASCII
  [0xffe0, 0xffe6], // 全角符号
  [0x1f300, 0x1f64f], // emoji（近似：全部按 2 列）
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], // CJK 扩展 B~
  [0x30000, 0x3fffd],
];

export function charWidth(cp) {
  // 组合区/变体选择/零宽：近似按 0 列
  if ((cp >= 0x0300 && cp <= 0x036f) || cp === 0xfe0f || cp === 0x200d || cp === 0xfe0e) return 0;
  if (cp < 0x1100) return 1; // ASCII 与拉丁（含代理项区不直达）
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2;
  }
  return 1;
}

/** 字符串显示宽度（按码点累加） */
export function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
}

/** ANSI SGR 24bit 前景色编码：'#rrggbb' → codePoint int；null=默认色 */
export function fgToCode(hex) {
  if (hex === null || hex === undefined) return 0;
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (m === null) return 0;
  return parseInt(m[1], 16);
}

export function codeToFgSgr(code) {
  if (code === 0) return '';
  return `\x1b[38;2;${(code >> 16) & 255};${(code >> 8) & 255};${code & 255}m`;
}

export class CellBuffer {
  constructor(cols, rows) {
    this.resize(cols, rows);
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.chars = new Array(cols * rows).fill(' ');
    this.widths = new Uint8Array(cols * rows); // 0=空/续列, 1=半宽, 2=宽字符首列
    this.fg = new Uint32Array(cols * rows); // 0=默认色，否则 24bit
  }

  clear() {
    this.chars.fill(' ');
    this.widths.fill(0);
    this.fg.fill(0);
  }

  /** 在 (x,y) 写一个字符（含宽字符首列+续列）；越界与续列起始截断由调用方（writeText）处理 */
  setCell(x, y, ch, w, fg) {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return;
    const i = y * this.cols + x;
    this.chars[i] = ch;
    this.widths[i] = w;
    this.fg[i] = fg;
    if (w === 2 && x + 1 < this.cols) {
      const j = i + 1;
      this.chars[j] = '';
      this.widths[j] = 0; // 续列
      this.fg[j] = fg;
    }
  }

  /** 把一行文本写入 buffer 第 y 行（宽字符感知，超宽截断不切半边） */
  writeText(y, text, fg = 0) {
    let x = 0;
    for (const ch of text) {
      const w = charWidth(ch.codePointAt(0));
      if (w === 0) continue; // 近似：跳过零宽
      if (x + w > this.cols) break; // 截断：宽字符放不下则整字丢弃（不切半边）
      this.setCell(x, y, ch, w, fg);
      x += w;
    }
  }

  /** 读取第 y 行的渲染文本（续列跳过；宽字符只出一列字符即可，终端自动占两列） */
  rowText(y) {
    let out = '';
    for (let x = 0; x < this.cols; x += 1) {
      const i = y * this.cols + x;
      if (this.widths[i] === 0 && this.chars[i] === '') continue; // 续列
      out += this.chars[i];
    }
    return out;
  }
}
