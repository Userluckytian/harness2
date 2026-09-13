// cell-buffer.ts — 字符网格 buffer（方案 B 核心，P2 T2-1；P4-1 扩展 linkId 并行数组）。
//
// 每个单元格存 char + 显示宽度 + 前景色 + 链接 id；宽字符占 2 列，续列格子宽度记 0、char 为空串。
//
// 宽度判定用内置 East Asian Wide/Fullwidth 区段表（近似，零依赖）：
//   * emoji 按 2 列近似处理 —— Unicode emoji-presentation 集合未完整收录，
//     内置表只覆盖常见 emoji 主区段（U+1F300~、U+1F900~、U+1FA70~ 等），
//     未收录的符号型 emoji（如 ☝ U+261D）会按 1 列计算，属已知近似；
//   * 组合字符 / ZWJ / 变体选择符（VS15/VS16）按 0 列（未实现完整 grapheme 分割，已知近似）；
//   * 生产如需 string-width 级精确表可后续替换 charWidth 单点，接口不变。
//
// 零外部依赖（Node 内置 only）。

/** East Asian Wide / Fullwidth 近似区段表（含常见 emoji 主区段，一律按 2 列） */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2329, 0x232a], // 左右尖括号
  [0x2e80, 0x303e], // CJK 部首/符号
  [0x3041, 0x33ff], // 平假名 ~ CJK 符号
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意
  [0xfe30, 0xfe4f], // CJK 兼容形式
  [0xff00, 0xff60], // 全角 ASCII
  [0xffe0, 0xffe6], // 全角符号
  [0x1f300, 0x1f64f], // emoji 主区段（近似：全部按 2 列）
  [0x1f680, 0x1f6ff], // 交通/地图 emoji
  [0x1f900, 0x1f9ff], // 补充符号与象形文字扩展
  [0x1fa70, 0x1faff], // 符号与象形文字扩展 A
  [0x20000, 0x2fffd], // CJK 扩展 B~
  [0x30000, 0x3fffd], // CJK 扩展 G~
];

/** 单码点显示宽度：0=零宽（组合/ZWJ/变体选择符），1=半宽，2=宽字符 */
export function charWidth(cp: number): 0 | 1 | 2 {
  // 组合区 / 变体选择 / 零宽：近似按 0 列
  if ((cp >= 0x0300 && cp <= 0x036f) || cp === 0xfe0f || cp === 0xfe0e || cp === 0x200d) return 0;
  if (cp < 0x1100) return 1; // ASCII 与拉丁
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2;
  }
  return 1;
}

/** 字符串显示宽度（按码点累加） */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/** ANSI SGR 24bit 前景色编码：'#rrggbb' → int；null/undefined/非法值 = 默认色(0) */
export function fgToCode(hex: string | null | undefined): number {
  if (hex === null || hex === undefined) return 0;
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (m === null) return 0;
  return parseInt(m[1] ?? '', 16);
}

/** 24bit int → SGR truecolor 前景序列；0 → 空串（默认色不发射） */
export function codeToFgSgr(code: number): string {
  if (code === 0) return '';
  return `\x1b[38;2;${(code >> 16) & 255};${(code >> 8) & 255};${code & 255}m`;
}

/**
 * 字符网格 buffer：chars/widths/fg/linkIds 四个平行数组按行优先存储（P4-1 扩展 linkId）。
 * 空白单元格：char=' '，width=0，fg=0，linkId=0。
 *
 * linkId 方案取舍（P4-1，钉死）：**并行 typed array**（Uint16Array，0=无链接）而非
 * 单元格对象——保持 chars/widths/fg 既有平坦结构，diff 逐格比较仍为 typed array 下标
 * 访问（cache 友好、零逐格对象分配）；id→URL 表由 registerLink 每帧分配（clear() 重置，
 * 与 back buffer 每帧清空重绘的生命周期一致）。选择高亮用 fg 换色（scrollback.SELECTION_FG），
 * **不引入 bg 属性位**——presenter 只发射前景 SGR，bg 方案会动 presenter 属性模型且
 * 既有 67 例 renderer 测试需全改，收益不成比例。
 */
export class CellBuffer {
  cols: number;
  rows: number;
  chars: string[];
  widths: Uint8Array; // 0=空白/续列，1=半宽，2=宽字符首列
  fg: Uint32Array; // 0=默认色，否则 24bit RGB
  linkIds: Uint16Array; // 0=无链接，1..65535 = linkUrl 表下标（P4-1 OSC8）

  private linkUrls: string[] = []; // linkId → URL（下标 0 恒空置；clear() 重置）

  constructor(cols: number, rows: number) {
    this.cols = 0;
    this.rows = 0;
    this.chars = [];
    this.widths = new Uint8Array(0);
    this.fg = new Uint32Array(0);
    this.linkIds = new Uint16Array(0);
    this.resize(cols, rows);
  }

  /** 调整尺寸：内容保留左上重叠区域，新增区域空白 */
  resize(cols: number, rows: number): void {
    const oldCols = this.cols;
    const oldRows = this.rows;
    const oldChars = this.chars;
    const oldWidths = this.widths;
    const oldFg = this.fg;
    const oldLinkIds = this.linkIds;
    this.cols = cols;
    this.rows = rows;
    this.chars = new Array<string>(cols * rows).fill(' ');
    this.widths = new Uint8Array(cols * rows);
    this.fg = new Uint32Array(cols * rows);
    this.linkIds = new Uint16Array(cols * rows);
    if (oldCols === 0 || oldRows === 0) return;
    const copyCols = Math.min(cols, oldCols);
    const copyRows = Math.min(rows, oldRows);
    for (let y = 0; y < copyRows; y += 1) {
      for (let x = 0; x < copyCols; x += 1) {
        const dst = y * cols + x;
        const src = y * oldCols + x;
        this.chars[dst] = oldChars[src] ?? ' ';
        this.widths[dst] = oldWidths[src] ?? 0;
        this.fg[dst] = oldFg[src] ?? 0;
        this.linkIds[dst] = oldLinkIds[src] ?? 0;
      }
    }
  }

  /** 全部重置为空白默认色（含 linkId 与 URL 注册表——每帧清空重绘的生命周期一致） */
  clear(): void {
    this.chars.fill(' ');
    this.widths.fill(0);
    this.fg.fill(0);
    this.linkIds.fill(0);
    this.linkUrls.length = 0;
  }

  /** 注册一个 URL，返回其 linkId（1 起递增；调用方每帧对可见 URL 区段调用） */
  registerLink(url: string): number {
    this.linkUrls.push(url);
    return this.linkUrls.length;
  }

  /** linkId → URL 反查（0 / 越界 / 未注册 = undefined） */
  linkUrl(id: number): string | undefined {
    return this.linkUrls[id - 1];
  }

  /** 在 (x,y) 标记链接 id（0=清除）；越界静默忽略。宽字符首列/续列由调用方按列分别标记 */
  setLinkId(x: number, y: number, id: number): void {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return;
    this.linkIds[y * this.cols + x] = id;
  }

  /** 读取 (x,y) 的链接 id（0=无链接） */
  linkIdAt(x: number, y: number): number {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return 0;
    return this.linkIds[y * this.cols + x] ?? 0;
  }

  /** 在 (x,y) 写一个单元格（宽字符由调用方负责成对写首列+续列）；越界静默忽略 */
  setCell(x: number, y: number, ch: string, w: 0 | 1 | 2, fg: number): void {
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

  /** 把一行文本写入第 y 行（宽字符感知；超宽整字丢弃不切半边；零宽字符跳过） */
  writeText(y: number, text: string, fg = 0): void {
    if (y < 0 || y >= this.rows) return;
    let x = 0;
    for (const ch of text) {
      const w = charWidth(ch.codePointAt(0) ?? 0);
      if (w === 0) continue; // 近似：零宽字符不占格
      if (x + w > this.cols) break; // 截断：放不下则整字丢弃（不切半边）
      this.setCell(x, y, ch, w, fg);
      x += w;
    }
  }

  /** 读取第 y 行渲染文本（长度恒等于 cols；续列跳过，终端遇宽字符自动占两列） */
  rowText(y: number): string {
    let out = '';
    for (let x = 0; x < this.cols; x += 1) {
      const i = y * this.cols + x;
      const ch = this.chars[i] ?? ' ';
      if ((this.widths[i] ?? 0) === 0 && ch === '') continue; // 续列
      out += ch;
    }
    return out;
  }
}
