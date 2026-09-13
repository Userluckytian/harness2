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
import { FG } from './projection.js';

/** 候选列表状态（画在 composer 层顶部，activeIndex 高亮 + 滚动窗口） */
export interface ChatCandidates {
  items: readonly string[];
  activeIndex: number;
}

/**
 * P3-D：全屏子代理视图态（非 null = 视图接管整帧）。子会话转录由接线层（next-shell）
 * 用独立 Scrollback 承载（磁盘重放 + onChildEvent 实时追加），本层只负责画：
 * scrollback 区画子会话内容、composer 层只画一行提示（草稿/候选/指示不画）。
 */
export interface SubagentViewState {
  /** 子会话转录滚动区（cols 契约与主 scrollback 一致：内容区宽 = 屏宽 - 1） */
  scrollback: Scrollback;
  /** composer 层提示行（q/Esc 返回 + 滚动键位 + 子会话标识） */
  hint: string;
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
  /**
   * P3-D：全屏子代理视图（非 null = 视图态）。布局上 composer 层收为 1 行提示行
   * （草稿/候选不画），scrollback 区改画子会话内容；statusline/shortcuts 保持。
   */
  subagentView?: SubagentViewState | null;
  /** 环境变量源（OSC8 开关判定单源；缺省 process.env，装配层传 deps.env） */
  env?: NodeJS.ProcessEnv;
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

// —— P3-E 上下文化 chrome（纯函数，next-shell 装配层数据驱动调用）——

/**
 * 快捷键条四态（P3-E，对齐 grok shortcuts bar 随上下文变化的行为）。
 * 互斥由单一 return 保证（优先级：审批接管 > 子视图 > busy > 空闲，与 dispatcher
 * 层级一致）；寄放态（approvalParked）不算接管——键盘在 composer，走 idle 组。
 */
export interface ShortcutContext {
  /** turn 运行中 */
  busy: boolean;
  /** FIFO 队列条数（只在 busy 态显示 Ctrl+X 段——队列只在忙时有意义） */
  queueCount: number;
  /** 审批卡接管键盘（挂起且未寄放） */
  approvalActive: boolean;
  /** 全屏子视图 / 子会话选择浮层打开 */
  subviewOpen: boolean;
}

/** 快捷键条上下文 → 键位组（纯函数；busy 组队列段仅 queueCount>0 时出现） */
export function shortcutsFor(ctx: ShortcutContext): readonly string[] {
  if (ctx.approvalActive) return ['↑↓ 选择', 'Enter 确认', 'Ctrl+F 展开', 'Esc 寄放'];
  if (ctx.subviewOpen) return ['q 返回', 'PgUp/PgDn 滚动'];
  if (ctx.busy) {
    const keys = ['Ctrl+C 取消'];
    if (ctx.queueCount > 0) keys.push(`Ctrl+X 队列(${ctx.queueCount})`);
    return keys;
  }
  return ['/ 命令', 'Tab 焦点', 'Ctrl+C 退出'];
}

/** cwd 短化：home 前缀替换为 ~（/home/me/proj → ~/proj；win 反斜杠同义）；非前缀原样 */
export function shortenCwd(cwd: string, home: string): string {
  if (home.length === 0 || cwd.length < home.length) return cwd;
  const sep = cwd.includes('\\') || home.includes('\\') ? '\\' : '/';
  const prefix = home.endsWith(sep) || home.endsWith('/') ? home : home + sep;
  if (cwd === home) return '~';
  if (cwd.startsWith(prefix)) return `~${sep}${cwd.slice(prefix.length)}`;
  return cwd;
}

/** 上下文占用格式化：undefined = 未知（无活动会话/读取失败），显示 — 不伪造数值 */
export function formatContextUsage(usage: number | undefined): string {
  return usage === undefined ? '—' : `${Math.round(usage * 100)}%`;
}

/** 状态行上下文（P3-E：cwd · model · ctx% · 模式(非 normal) · 重试标记 · 运行中标记） */
export interface StatusLineContext {
  /** 装配期工作目录（原始路径，本函数内做 ~ 短化） */
  cwd: string;
  /** 用户主目录（~ 短化基准） */
  home: string;
  /** 模型名（= runtime.provider.name，写入 assistant/message.model 的同一标识） */
  model: string;
  /** 上下文占用 0..1（core getContextUsage；undefined = 未知 → ctx —） */
  usage?: number;
  /** UI 模式（四态；normal/缺省省略） */
  mode?: string;
  /** 上一 turn 的重试预算标记（used/max；无重试史省略） */
  retry?: { used: number; max: number };
  /** turn 运行中 */
  busy?: boolean;
}

/** 状态行上下文 → 行文本（纯函数；段序固定：cwd · model · ctx · mode · retry · busy） */
export function statusLineFor(ctx: StatusLineContext): string {
  const parts = [shortenCwd(ctx.cwd, ctx.home), ctx.model, `ctx ${formatContextUsage(ctx.usage)}`];
  if (ctx.mode !== undefined && ctx.mode !== 'normal') parts.push(ctx.mode);
  if (ctx.retry !== undefined) parts.push(`重试 ${ctx.retry.used}/${ctx.retry.max}`);
  if (ctx.busy === true) parts.push('⏺ 运行中…');
  return parts.join(SHORTCUTS_SEPARATOR);
}

/** 队列面板条目预览列宽（对齐 ink queue-panel 的 PREVIEW_MAX=42） */
export const QUEUE_PREVIEW_MAX = 42;

/** 队列条目单行预览：折行合一 + 超长截断加省略号（仅展示用，不改队列原文） */
export function queueEntryPreview(text: string, max: number = QUEUE_PREVIEW_MAX): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/**
 * 纵向分层（纯计算）：composer 高度 = 草稿物理行 + 候选行 + 1 提示行；
 * statusline 有则 1 行；shortcuts 固定 1 行；其余全给 scrollback（flex）。
 * 极端小屏按 columnLayout 确定性退化：composer（先）→ statusline → shortcuts 依次截断。
 */
export function layoutChat(rows: number, cols: number, state: ChatScreenState): ChatLayout {
  const totalRows = Math.max(0, Math.floor(rows));
  const totalCols = Math.max(1, Math.floor(cols));
  // P3-D：视图态 composer 收为 1 行提示行（草稿/候选不参与测量——draftRows 强制 0，
  // 否则 measureComposer 的空草稿仍占 1 行会把提示行顶高）
  const subview = state.subagentView ?? null;
  const draftRows = subview !== null ? 0 : measureComposer(state.draft ?? '', totalCols, state.cursor).rows;
  const candRows = subview !== null || state.candidates === null ? 0 : candidateRows(state.candidates.items.length);
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
  // P3-D：视图态改画子会话 scrollback（独立实例，主转录不动）；其余同主转录（滚动条/宽/fg 缺省）
  const sb = state.subagentView?.scrollback ?? state.scrollback;
  drawScrollback(buf, sb, {
    top: layer.top,
    height: layer.height,
    ...(state.env !== undefined ? { env: state.env } : {}), // OSC8 开关单源（审查 P2-3）
  });
}

function drawComposerLayer(buf: CellBuffer, state: ChatScreenState, layout: ChatLayout): void {
  const { top, height } = layout.composer;
  if (height <= 0 || top >= buf.rows) return; // 镜像 renderComposer：越界/零高度不渲染
  // P3-D：视图态 composer 层只画一行提示（灰；草稿/候选/指示不画——子会话视图无输入）
  const subview = state.subagentView;
  if (subview) {
    writeRowClipped(buf, top, subview.hint, buf.cols, FG.gray);
    return;
  }
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
    drawOverlay(buf, spec, rect, { width: cols, activeFg: DEFAULT_ACTIVE_FG, showNumbers: spec.showNumbers === true });
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
