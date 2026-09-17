// minimal-view.ts — G-01 minimal 渲染基座（追加式转录 + 底部 prompt 行）。
//
// 与 P2-C 否决结论（「旧壳内联不可行」）的差异说明（钉死）：
// - P2-C 的评估对象是「复用整帧 renderChat 呈现 minimal」——renderChat 每帧把转录整体
//   画进 alt-screen 差量帧，若去掉 alt-screen 直写 stdout，转录会逐帧重复进原生
//   scrollback，不可行。该结论只否决「整帧复用」一条路。
// - 本模块走另一条管线（任务规格推荐路线，旧壳 `<Static>` 的非 React 等价）：
//   ▸ 转录 = 追加式（append-only）：已落定（settled）的块一次性写进终端原生滚动区
//     （每行 `text\n`，不重绘不擦除），live 尾部（流式 step / pending 工具）暂扣，
//     落定后才写——写入序即转录序，绝不重复；
//   ▸ 底部 = 重绘区：statusline（可选）/ 浮层（审批卡等阻塞卡）/ 候选 / 草稿 构成
//     一个「prompt 块」，每次重绘先整块擦除（`\r\x1b[2K` × n 行 + 光标上移）再重画，
//     与 readline 的行编辑同协议；不进 alt-screen、不接管屏幕（MINIMAL_CONTRACT）。
// - 由此 /fullscreen（alt-screen 八区域）↔ /minimal（原生滚动）成为真·进程内切换：
//   全屏基座 = Screen（一次性实例，stop 后弃用，回切时新建）；minimal 基座 = 本模块
//   直写 deps.out。两基座共享同一份 transcript / 草稿 / 会话运行时（next-shell 装配）。
//
// 边界（如实登记）：
// - 颜色：minimal 直写不携带 SGR（终端默认色）——原生滚动区无法做差量着色，取舍登记；
// - 已写出的行不可撤回：折叠/主题等「改变已渲染内容」的操作在 minimal 下只影响后续
//   输出（next-shell 侧给如实提示）；rewind/会话切换后完整重放（旧内容仍留在终端
//   scrollback 历史，这是 write-through 的固有语义）；
// - prompt 块重绘依赖「两次写之间光标停在 prompt 块内」：本模块是唯一的底部写入者
//   （next-shell 装配保证），外部进程不并发写同一终端。
import { CellBuffer, charWidth, type CellBuffer as CellBufferT } from '../renderer/cell-buffer.js';
import { candidateRows, drawComposer, fitIndicator, measureComposer, type ComposerCandidates } from './composer.js';
import { drawOverlay, overlayNaturalHeight, overlayStackLayout, type OverlaySpec } from './overlay.js';
// P3-E 接线1（G-31）：命令面板进 minimal prompt 块（与 fullscreen 同一 drawPalette 绘制体）
import { drawPalette, paletteNaturalHeight } from '../commands/palette-view.js';
import type { PaletteRow, PaletteState } from '../commands/palette-model.js';

// ansi.ts 无以下现成常量（该文件只读），与 next-shell 同口径在本层自定义：
/** 消除行内残字 + 光标回行首 */
const CLEAR_LINE = '\x1b[2K';
const CR = '\r';
const LF = '\n';
/** 光标上移 n 行（CUU） */
const CUU = (n: number): string => `\x1b[${n}A`;
/** 光标右移 n 列（CUF；0 不发射） */
const CUF = (n: number): string => (n > 0 ? `\x1b[${n}C` : '');

/**
 * minimal 底部重绘块的行序（自上而下）：statusline（可选 1 行）→ 浮层栈（审批卡等
 * 阻塞卡——minimal 下浮层仍必须可见，画在 prompt 上方）→ 候选行 → 草稿行（底行携带
 * 右对齐指示）。浮层行数不设上限（如实占满；extreme 长内容按 overlay 栈语义钳制在
 * 可用行数内——见 composeMinimalPromptBlocks）。
 */
export interface MinimalPromptInput {
  /** 草稿文本（'\n' 硬换行） */
  draft: string;
  /** 逻辑光标（UTF-16 码元偏移） */
  cursor: number;
  /** 候选列表（null/undefined = 无；可选成员显式含 undefined，兼容装配层条件展开） */
  candidates?: ComposerCandidates | null | undefined;
  /** 底边指示（右对齐画在草稿底行；缺省无） */
  indicators?: readonly string[] | undefined;
  /** 状态行（空/undefined = 不占行；装配层按 MINIMAL_STATUS_LINE_DEFAULT 决定是否传入） */
  statusline?: string | undefined;
  /** 浮层栈（自下而上；审批卡/查看器等阻塞卡在 minimal 的呈现位） */
  overlays?: readonly OverlaySpec[] | undefined;
  /**
   * P3-E 接线1（G-31）：命令面板（open 才传；与 overlays 同栈，palette 贴 composer 底位）。
   * 绘制与 fullscreen 同一 drawPalette——两基座面板 chrome 一致。
   */
  palette?: { state: PaletteState; rows: readonly PaletteRow[] } | undefined;
  /** 宽度（终端列数；minimal 无滚动条列 = 全宽） */
  cols: number;
}

/** prompt 块规格：物理行文本 + 光标物理位置（供 ANSI 层定位） */
export interface MinimalPromptBlock {
  rows: string[];
  /** 光标所在物理行（相对块顶，0 基） */
  cursorRow: number;
  /** 光标显示列（0 基；行满行尾钳制到 cols-1，与 drawComposer 高亮钳制同规则） */
  cursorCol: number;
}

/** 从 CellBuffer 提取文本行：跳过 width=0 的空白/续列格（写入的空格 width=1 会保留） */
export function extractRows(buf: CellBufferT): string[] {
  const rows: string[] = [];
  for (let y = 0; y < buf.rows; y += 1) {
    let line = '';
    for (let x = 0; x < buf.cols; x += 1) {
      const idx = y * buf.cols + x;
      if ((buf.widths[idx] ?? 0) > 0) line += buf.chars[idx] ?? '';
    }
    rows.push(line);
  }
  return rows;
}

/**
 * 组装 minimal 底部重绘块（纯函数，headless 可测）。
 * 浮层行经 drawOverlay（与 fullscreen 同一绘制体，保证 chrome 一致）；草稿/候选/指示
 * 经 drawComposer；状态行 writeRow 語義（左对齐、按宽裁剪）。
 * 高度预算：状态行 1 + 浮层栈（overlayStackLayout 钳制在「屏高 - 草稿候选」内）+
 * 候选行 + 草稿物理行。溢出保护：总行数钳制在 maxRows（缺省 1000，防异常状态刷屏）。
 */
export function composeMinimalPrompt(input: MinimalPromptInput, maxRows = 1000): MinimalPromptBlock {
  const cols = Math.max(1, Math.floor(input.cols));
  const draftRows = measureComposer(input.draft, cols, input.cursor).rows;
  const candRows = input.candidates == null ? 0 : candidateRows(input.candidates.items.length);
  const hasStatus = typeof input.statusline === 'string' && input.statusline.length > 0;
  const statusRows = hasStatus ? 1 : 0;
  const overlays = input.overlays ?? [];
  // P3-E 接线1：palette 与浮层同栈（palette 栈底 = 贴 composer；面板打开即独占由装配层保证）
  const palette = input.palette?.state.open === true ? input.palette : undefined;
  const paletteHeight = palette !== undefined ? paletteNaturalHeight(palette.rows.length) : 0;
  // 浮层栈预算：与 fullscreen 同一 overlayStackLayout——composerTop 之上有多少给多少，
  // 空间不足钳到顶并截断（不顶走输入框，语义一致）
  const overlayBudget = Math.max(0, maxRows - statusRows - candRows - draftRows);
  const overlayHeights = [
    ...(paletteHeight > 0 ? [{ height: Math.min(paletteHeight, overlayBudget) }] : []),
    ...overlays.map((spec) => ({ height: Math.min(overlayNaturalHeight(spec), overlayBudget) })),
  ];
  const overlayTotal = overlayHeights.reduce((sum, h) => sum + h.height, 0);
  const rows = Math.min(maxRows, statusRows + overlayTotal + candRows + draftRows);

  const buf = new CellBuffer(cols, Math.max(1, rows));
  const draftTop = statusRows + overlayTotal + candRows;
  // 草稿区（候选画在其上方、指示画在其底行——drawComposer 语义与 fullscreen 完全一致）。
  // cursorVisible=false：minimal 的光标由 ANSI 定位（renderPromptBlock 的 CUF）呈现，
  // 不画高亮格——否则空格光标格会以 width=1 进提取行，污染文本。
  drawComposer(
    buf,
    { draft: input.draft, cursor: input.cursor },
    {
      top: draftTop,
      height: draftRows,
      cursorVisible: false,
      ...(input.candidates != null ? { candidates: input.candidates } : {}),
      ...(input.indicators !== undefined && input.indicators.length > 0 ? { indicators: input.indicators } : {}),
    },
  );
  // 浮层栈 + palette：底部贴草稿区顶（draftTop），向上生长；与 fullscreen 的 overlayStackLayout 同参
  if (overlayHeights.length > 0) {
    const rects = overlayStackLayout({
      screenRows: draftTop,
      composerTop: draftTop,
      overlays: overlayHeights,
    });
    if (palette !== undefined) {
      const rect = rects[0];
      if (rect != null) drawPalette(buf, palette.state, palette.rows, rect); // 画满 buf 宽（A 棒契约）
    }
    for (let i = 0; i < overlays.length; i += 1) {
      const rect = rects[i + (palette !== undefined ? 1 : 0)];
      const spec = overlays[i];
      if (rect == null || spec === undefined) continue;
      drawOverlay(buf, spec, rect, { width: cols });
    }
  }
  // 状态行（minimal 可选层，画在块顶）
  if (hasStatus) writeStatusRow(buf, input.statusline ?? '', cols);

  const measure = measureComposer(input.draft, cols, input.cursor);
  return {
    rows: extractRows(buf),
    cursorRow: Math.min(statusRows + overlayTotal + candRows + measure.cursorRow, Math.max(0, rows - 1)),
    cursorCol: Math.min(measure.cursorCol, cols - 1), // 行满行尾钳制（与 drawComposer 同规则）
  };
}

/** 状态行写入（左对齐、按宽裁剪；宽度判定复用 cell-buffer 的 charWidth，与全屏一致） */
function writeStatusRow(buf: CellBufferT, text: string, cols: number): void {
  let x = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (w === 0) continue;
    if (x + w > cols) break;
    buf.setCell(x, 0, ch, w, 0);
    x += w;
  }
}

/**
 * 擦除 prevRows 行的 prompt 块：光标上移 prevRows-1 → 逐行 `\r\x1b[2K` + 下移。
 * 结束时光标停在原块首行行首（列 1）。prevRows ≤ 0 返回空串。
 */
export function erasePromptBlock(prevRows: number): string {
  if (prevRows <= 0) return '';
  let s = '';
  if (prevRows > 1) s += CUU(prevRows - 1);
  for (let i = 0; i < prevRows; i += 1) {
    s += CR + CLEAR_LINE;
    if (i < prevRows - 1) s += LF;
  }
  return s;
}

/**
 * 重绘 prompt 块（先擦旧块再画新块；同一协议下的 readline 行编辑）。
 * 画完光标定位到 (cursorRow, cursorCol)。纯函数（返回要写的字节串）。
 */
export function renderPromptBlock(prevRows: number, block: MinimalPromptBlock): string {
  let s = erasePromptBlock(prevRows);
  for (let i = 0; i < block.rows.length; i += 1) {
    s += block.rows[i];
    if (i < block.rows.length - 1) s += LF;
  }
  // 光标从块底行（画完停的位置）定位到目标物理行，再右移到目标列
  const up = block.rows.length - 1 - Math.min(block.cursorRow, Math.max(0, block.rows.length - 1));
  if (up > 0) s += CUU(up);
  s += CR + CUF(Math.max(0, block.cursorCol));
  return s;
}

/** 转录行输入（text 原样；fg 在 minimal 直写中不携带——无 SGR，取舍见文件头） */
export interface MinimalTranscriptLine {
  text: string;
}

/**
 * minimal 基座实例：持有「当前 prompt 块行数」状态，向外写 stdout。
 * 三类写操作：printLines（擦 prompt → 追加转录行）、renderPrompt（擦旧画新）、
 * erase（擦 prompt 不画）。全部幂等安全（prevRows 归零后不重复擦）。
 */
export class MinimalView {
  private prevRows = 0;
  constructor(
    private readonly out: { write(s: string): unknown },
    /** 宽度来源（终端列数可变——resize 后调用方下次 compose 传新宽即可，本类不持有） */
    private readonly cols: () => number,
  ) {}

  /** 追加转录行（已落定块）：先擦 prompt 块，逐行写出（每行以 \n 结束——原生滚动） */
  printLines(lines: readonly MinimalTranscriptLine[]): void {
    if (lines.length === 0) return;
    let s = erasePromptBlock(this.prevRows);
    this.prevRows = 0;
    for (const line of lines) {
      s += line.text.replaceAll('\r', '') + LF;
    }
    this.out.write(s);
  }

  /** 重绘 prompt 块（擦旧画新；块内含 statusline/浮层/候选/草稿，见 composeMinimalPrompt） */
  renderPrompt(block: MinimalPromptBlock): void {
    this.out.write(renderPromptBlock(this.prevRows, block));
    this.prevRows = block.rows.length;
  }

  /** 只擦不画（退出 minimal / 切回全屏前清理底部残留） */
  erase(): void {
    if (this.prevRows <= 0) return;
    this.out.write(erasePromptBlock(this.prevRows));
    this.prevRows = 0;
  }

  /** 重置行数记账（转录整体重放前调用：擦旧块 + 从零开始） */
  reset(): void {
    this.erase();
  }

  /** fitIndicator 复用出口（指示行右对齐截断与 fullscreen 同语义；测试断言用） */
  indicatorOf(text: string): string {
    return fitIndicator(text, this.cols());
  }
}
