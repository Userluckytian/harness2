// chat-screen.ts — chat 整帧装配（P2 T2-7，headless 可测，零外部依赖）。
//
// 职责：把 scrollback / composer（候选 + 草稿 + 光标 + 底边指示）/ statusline / 快捷键条 /
// 多浮层栈装配进**一次** screen.render 回调，经 diff-presenter 产生单帧差量输出。
// 分层（自下而上，grok 语义）：shortcuts bar（固定 1 行）/ statusline（可选 1 行）/
// composer（自适应 = 草稿物理行 + 候选行 + 1 提示行）/ scrollback（其余全部）。
// P2-C 收敛：高度让位改由 render/regions 的 allocateRegions（G-04 八区域模型）确定性分配，
// 绘制经 RegionLayoutManager 按区域预算驱动本文件的 draw 级复用（drawScrollback /
// drawComposer / writeRowClipped / drawOverlay）；数据面板（queue/todos/tasks）无数据源
// 缺省隐藏。小屏退化语义差异（scrollback 最低保 1 行 vs 旧 composer 先截断）见 layoutChat
// 注释与 P2-C 报告登记。内容宽度判定复用 cell-buffer 的 charWidth。
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
import type { LayerRect } from '../renderer/layout.js';
import type { Screen } from '../renderer/screen.js';
import {
  allocateRegions,
  RegionLayoutManager,
  type RegionId,
  type RegionInput,
  type RegionLayout,
} from '../render/regions.js';
import { candidateRows, drawComposer, measureComposer } from './composer.js';
import { drawOverlay, overlayNaturalHeight, overlayStackLayout, type OverlaySpec } from './overlay.js';
import { drawScrollback, writeRowClipped, type Scrollback } from './scrollback.js';
import { DEFAULT_THEME, type Theme } from './theme.js';
// P3-F（G-39）：快捷键帮助内容的 Agent 级段取自键位归属表（单一事实来源，不抄第二份键位）
import { AGENT_CHORD_TABLE } from '../input/keymaps.js';
// P3-E 接线1（G-31）：命令面板渲染缝——面板行组成/绘制来自 tui/commands（A 棒冻结模块），
// 本文件只负责把 drawPalette 组装进 overlayModal 区域的浮层栈（与 drawOverlay 同帧）。
import { drawPalette, paletteNaturalHeight } from '../commands/palette-view.js';
import type { PaletteRow, PaletteState } from '../commands/palette-model.js';

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
  /**
   * P3-E 接线1（G-31）：命令面板打开时的渲染数据（装配层在 refreshChrome 同步；
   * open 且 rows 就绪才存在）。绘制经 drawPalette 进 overlayModal 区域浮层栈的**栈底**
   * （紧贴 composer，与浮层/审批卡互斥——面板打开即独占浮层栈）。
   */
  palette?: { state: PaletteState; rows: readonly PaletteRow[] } | null;
  /**
   * P3-E 接线4（G-47）：command 型状态行脚本的多行输出（最多 5 行）。存在时 statusLine
   * 区域按行数取高、逐行绘制；undefined/空 = 单行 statusline 字段语义（P3-E chrome）。
   */
  statusLines?: readonly string[];
  /** 环境变量源（OSC8 开关判定单源；缺省 process.env，装配层传 deps.env） */
  env?: NodeJS.ProcessEnv;
  /**
   * P4-2：主题（光标格/active 候选/浮层高亮/子视图提示/滚动区选中高亮从主题取）。
   * 缺省 = dark（= 旧常量值，零变化契约）；由装配层（next-shell）在 /theme 切换时更新。
   */
  theme?: Theme;
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
 * 快捷键条状态（P3-E 四态 + P3-F 两个新浮层态）。
 * 互斥由单一 return 保证（优先级：审批接管 > 子视图/浮层 > busy > 空闲，与 dispatcher
 * 层级一致）；寄放态（approvalParked）不算接管——键盘在 composer，走 idle 组。
 */
export interface ShortcutContext {
  /** turn 运行中 */
  busy: boolean;
  /** FIFO 队列条数（只在 busy 态显示队列段——队列只在忙时有意义） */
  queueCount: number;
  /** 审批卡接管键盘（挂起且未寄放） */
  approvalActive: boolean;
  /** 全屏子视图 / 子会话选择浮层打开 */
  subviewOpen: boolean;
  /**
   * P3-F：G-39 快捷键帮助 / G-34 会话选择器接管键盘（缺省 undefined = 未打开）。
   * 可选字段——既有调用方零改动；两浮层各自有一组真实可用的键位（不展示无关提示）。
   */
  modal?: 'help' | 'session-picker';
}

/**
 * 快捷键条上下文 → 键位组（纯函数；busy 组队列段仅 queueCount>0 时出现）。
 * P3-E 接线迁移（登记）：
 *  - 队列段主键按 G-29 面板键位表 = `Ctrl+;`（panel.ts QUEUE_PANEL_OPEN_KEYS）；approval 组
 *    按 G-25 卡内焦点环更新——Tab/Shift+Tab 环走（旧「Ctrl+F 展开」随 B 棒卡片呈现契约移除：
 *    askApproval 契约仅携带文案，卡片无参数全文可展开，P3-B 差异登记延续）。
 * P3-F 冲突修复（登记）：早批「Ctrl+X 作队列面板壳侧附加别名」已**废止**——Ctrl+X 归
 * G-39 快捷键帮助（见 keymaps.ts AGENT_CHORD_TABLE）；队列段因此只剩 Ctrl+; 一族键位。
 * P3-F 新增：帮助 / 会话选择器两组（modal 字段），文案与各自 input layer 的真实键位一致。
 */
export function shortcutsFor(ctx: ShortcutContext): readonly string[] {
  if (ctx.approvalActive) return ['Tab/↑↓ 选择', 'Enter 确认', 'Esc 寄放'];
  if (ctx.modal === 'help') return ['Esc / q 关闭', '↑↓ / j k 滚动'];
  if (ctx.modal === 'session-picker') return ['↑↓ 选择', 'Enter 切换', 'Esc 取消'];
  if (ctx.subviewOpen) return ['q 返回', 'PgUp/PgDn 滚动'];
  if (ctx.busy) {
    const keys = ['Ctrl+C 取消'];
    if (ctx.queueCount > 0) keys.push(`Ctrl+; 队列(${ctx.queueCount})`);
    return keys;
  }
  return ['/ 命令', 'Tab 焦点', 'Ctrl+C 退出'];
}

// ── P3-F（G-39）：快捷键帮助内容（cheatsheet）──────────────────────────────────
//
// 数据驱动、单一事实来源：
//  - 首段直接复用 `shortcutsFor`（快捷键条同一份数据，不抄第二份）；
//  - 其余段是壳内**已接线**的固定键位（每条注明 G 号）；
//  - Agent 级（G-31～G-41）整段取自 `input/keymaps.ts` 的 `AGENT_CHORD_TABLE`，
//    未接线的条目带「（P7 未接入）」后缀如实呈现——帮助面板因此永不出现「按了没反应」
//    的键（既讲清现有键位，也讲清哪些和弦已被登记但尚未接驳）。

/** 快捷键帮助浮层的标题（装配层用它识别/关闭本浮层；唯一字符串常量，前缀匹配） */
export const SHORTCUTS_HELP_TITLE = 'Keyboard shortcuts（快捷键）';

/** 帮助浮层标题尾部操作提示（与标题同源呈现，避免用户找不到关闭键） */
export const SHORTCUTS_HELP_HINT = 'Esc / q 关闭 · ↑↓ / j k 滚动';

export interface ShortcutsHelpSection {
  readonly title: string;
  readonly lines: readonly string[];
}

/** 壳内固定键位（非 Agent 级、非上下文态）：逐条注明 G 号 */
const FIXED_SHORTCUT_SECTIONS: readonly ShortcutsHelpSection[] = [
  {
    title: '输入',
    lines: [
      'Enter 发送 · Shift+Enter 换行',
      'Ctrl+I / Ctrl+Enter 立即发送（取消当前回合并发出）· G-28',
      'Alt+V 粘贴图片（Windows；真机透传下放 P7）· G-12',
      'Ctrl+S / Alt+S 暂存草稿 ⇄ 恢复 · G-17',
      '! 行首 = shell 模式直接执行 · G-11',
    ],
  },
  {
    title: '焦点与滚动',
    lines: ['Tab 输入框 ⇄ 转录区 · G-08', 'PgUp/PgDn 整页 · Ctrl+U / Ctrl+D 半页 · Ctrl+K / Ctrl+J 单行 · G-10'],
  },
  {
    title: '转录区（Tab 切到转录后）',
    lines: [
      'j / k 上下行 · Shift+J / Shift+K 视口上/下回合 · Shift+H / Shift+L 按回合前后 · G-09',
      'g / Shift+G 顶 / 底 · e 折叠 · r 原始视图 · h / l 开合 · G-05 / G-09',
      'Enter / Ctrl+F 块查看器 · y / Shift+Y 复制块（含元数据）· G-06',
      'v 子会话视图 · q / Esc 返回',
    ],
  },
  {
    title: '其他',
    lines: ['/ 行首 = 斜杠命令（Tab / Enter 接受候选）· ? 空草稿时开命令面板 · G-50～G-53'],
  },
];

/**
 * 快捷键帮助分组内容（G-39）。`ctx` 用于首段「当前上下文」（= 快捷键条数据）。
 * 返回结构而非直接拼行，便于单测断言分组与忠实性（未接线条目必须带 P7 后缀）。
 */
export function shortcutsHelpSections(ctx: ShortcutContext): readonly ShortcutsHelpSection[] {
  const agentLines = AGENT_CHORD_TABLE.map((entry) => {
    const tier = entry.tier === '参考' ? ' · 参考级' : '';
    const state = entry.owner === 'deferred' ? '（P7 未接入）' : '';
    return `${entry.label} — ${entry.summary}${state}${tier}`;
  });
  return [
    { title: '快捷键条（常用入口）', lines: [shortcutsText(shortcutsFor(ctx))] },
    ...FIXED_SHORTCUT_SECTIONS,
    { title: 'Agent 级键位（G-31～G-41）', lines: agentLines },
  ];
}

/** 展示行宽上限（帮助面板每行不超此宽；超长截断加省略号，避免浮层内被硬裁剪丢信息） */
export const SHORTCUTS_HELP_MAX_COLS = 96;

/** 分组内容 → 扁平展示行（段标题行 `── 标题 ──` + 各行；超宽截断加省略号） */
export function shortcutsHelpLines(ctx: ShortcutContext): string[] {
  const out: string[] = [];
  const push = (text: string): void => {
    out.push(text.length <= SHORTCUTS_HELP_MAX_COLS ? text : `${text.slice(0, SHORTCUTS_HELP_MAX_COLS - 1)}…`);
  };
  for (const section of shortcutsHelpSections(ctx)) {
    push(`── ${section.title} ──`);
    for (const line of section.lines) push(line);
  }
  return out;
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
  /**
   * P4-2：busy 且无运行中子代理时的 spinner 帧字符（装配层 150ms 传入当前帧）。
   * 传入 = 替换「⏺ 运行中…」的 ⏺ 前缀；缺省保持 ⏺（既有调用零变化）。
   */
  spinnerFrame?: string;
}

/** 状态行上下文 → 行文本（纯函数；段序固定：cwd · model · ctx · mode · retry · busy） */
export function statusLineFor(ctx: StatusLineContext): string {
  const parts = [shortenCwd(ctx.cwd, ctx.home), ctx.model, `ctx ${formatContextUsage(ctx.usage)}`];
  if (ctx.mode !== undefined && ctx.mode !== 'normal') parts.push(ctx.mode);
  if (ctx.retry !== undefined) parts.push(`重试 ${ctx.retry.used}/${ctx.retry.max}`);
  if (ctx.busy === true) parts.push(`${ctx.spinnerFrame ?? '⏺'} 运行中…`);
  return parts.join(SHORTCUTS_SEPARATOR);
}

/** 队列面板条目预览列宽（对齐旧壳 queue-panel 的 PREVIEW_MAX=42） */
export const QUEUE_PREVIEW_MAX = 42;

/** 队列条目单行预览：折行合一 + 超长截断加省略号（仅展示用，不改队列原文） */
export function queueEntryPreview(text: string, max: number = QUEUE_PREVIEW_MAX): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/**
 * 纵向分层（P2-C 收敛到 G-04 八区域模型）：布局不再走 renderer/layout.columnLayout，
 * 改由 render/regions 的 allocateRegions 确定性分配——
 * - 固定区簇贴屏幕底部（底→顶）：shortcutsBar(1) → statusLine(可选 1) →
 *   prompt(草稿物理行 + 候选行 + 1 提示行)；scrollback 占顶部剩余全部（最低保 1 行）。
 * - queuePane/todosPane/tasksPane 本阶段无数据源 → 不提供输入 → 自动隐藏（不造假内容）。
 * - overlayModal：有浮层时作为顶层区域参与分配（锚定固定区簇之上、钳到屏幕顶），绘制时
 *   区域内仍用 overlayStackLayout 复刻栈语义（多浮层自下而上堆叠）。
 * 收敛登记（差异取舍）：极端小屏退化序与旧 columnLayout 不同——本模型 scrollback 最低
 * 保 1 行（转录可见优先），prompt 先降到 minHeight(1) 再归零；旧 columnLayout 是 composer
 * 先截断、scrollback 可为 0。按 regions.ts「接线批二选一收敛」裁决取区域模型（G-04 为准），
 * 受影响的旧小屏断言已随收敛更新（P2-C 报告逐条登记）。
 */
export function layoutChat(rows: number, cols: number, state: ChatScreenState): ChatLayout {
  const totalRows = Math.max(0, Math.floor(rows));
  const totalCols = Math.max(1, Math.floor(cols));
  const chat = measureChatLayers(state, totalCols);
  const inputs = buildRegionInputs(state, chat);
  const region = allocateRegions(totalRows, inputs);
  return mapRegionLayout(region, chat);
}

/** 分层中间量（layoutChat 与 renderChat 共用，保证两处输入恒一致） */
interface ChatLayerMeasure {
  /** 草稿物理行数（measureComposer.rows） */
  draftRows: number;
  /** 候选可见行数（candidateRows，0 = 无候选） */
  candidateRows: number;
  /**
   * statusLine 区域行数：command 型多行输出按行数取高（G-47 最多 5 行）；
   * 单行 statusline 有内容 = 1；无 = 0。
   */
  statusRows: number;
}

function measureChatLayers(state: ChatScreenState, cols: number): ChatLayerMeasure {
  // P3-D：视图态 composer 收为 1 行提示行（草稿/候选不参与测量——draftRows 强制 0，
  // 否则 measureComposer 的空草稿仍占 1 行会把提示行顶高）
  const subview = state.subagentView ?? null;
  const draftRows = subview !== null ? 0 : measureComposer(state.draft ?? '', cols, state.cursor).rows;
  const candRows = subview !== null || state.candidates === null ? 0 : candidateRows(state.candidates.items.length);
  // P3-E 接线4：statusLines（command 型多行）优先于单行 statusline 字段
  const statusRows =
    state.statusLines !== undefined && state.statusLines.length > 0
      ? state.statusLines.length
      : typeof state.statusline === 'string' && state.statusline.length > 0
        ? 1
        : 0;
  return { draftRows, candidateRows: candRows, statusRows };
}

/** ChatScreenState → 八区域布局输入（五个接线区域；数据面板缺省隐藏，不造假内容） */
function buildRegionInputs(state: ChatScreenState, chat: ChatLayerMeasure): ReadonlyMap<RegionId, RegionInput> {
  const inputs = new Map<RegionId, RegionInput>();
  inputs.set('scrollback', {}); // 主区：显式输入即恒可见，拿剩余高度
  inputs.set('prompt', { naturalHeight: chat.draftRows + chat.candidateRows + 1 }); // 含提示行
  inputs.set('statusLine', { naturalHeight: chat.statusRows, visible: chat.statusRows > 0 });
  inputs.set('shortcutsBar', { naturalHeight: 1 });
  if (state.overlays.length > 0 || state.palette?.state.open === true) {
    const paletteH = state.palette?.state.open === true ? paletteNaturalHeight(state.palette.rows.length) : 0;
    const natural = paletteH + state.overlays.reduce((sum, spec) => sum + overlayNaturalHeight(spec), 0);
    inputs.set('overlayModal', { naturalHeight: natural });
  }
  return inputs;
}

/** 区域分配结果 → ChatLayout 各层矩形（id 一一对应；statusLine 缺省位次映射保持旧契约） */
function mapRegionLayout(region: RegionLayout, chat: ChatLayerMeasure): ChatLayout {
  const allocOf = (id: RegionId): { top: number; height: number } => {
    const a = region.regions.find((r) => r.id === id);
    return { top: a?.top ?? 0, height: a?.height ?? 0 };
  };
  const composer = allocOf('prompt');
  const statusline = chat.statusRows > 0 ? allocOf('statusLine') : { top: composer.top + composer.height, height: 0 };
  const shortcuts = allocOf('shortcutsBar');
  return {
    scrollback: allocOf('scrollback'),
    composer,
    statusline,
    shortcuts,
    draftRows: chat.draftRows,
    candidateRows: chat.candidateRows,
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
    // P4-2：主题进滚动区（选中高亮 fg.selection；缺省 dark = 旧 SELECTION_FG，零变化）
    theme: state.theme,
    ...(state.env !== undefined ? { env: state.env } : {}), // OSC8 开关单源（审查 P2-3）
  });
}

function drawComposerLayer(buf: CellBuffer, state: ChatScreenState, layout: ChatLayout): void {
  const { top, height } = layout.composer;
  if (height <= 0 || top >= buf.rows) return; // 镜像 renderComposer：越界/零高度不渲染
  // P4-2：主题（缺省 dark = 旧常量值，零变化契约）
  const theme = state.theme ?? DEFAULT_THEME;
  // P3-D：视图态 composer 层只画一行提示（灰；草稿/候选/指示不画——子会话视图无输入）
  const subview = state.subagentView;
  if (subview) {
    writeRowClipped(buf, top, subview.hint, buf.cols, theme.fg.system);
    return;
  }
  // composer 层内自上而下 = 候选行（层顶）→ 草稿行 → 提示行（层底，恒保留）。
  // drawComposer 语义：候选画在草稿区上方（底部锚定）、指示画在草稿区底行。
  // 映射：草稿区 top = 层顶 + 候选行数，height = 草稿可用行（draftCap）+ 提示行，
  // 候选/指示即分别落进层顶候选行与层底提示行；光标/active 候选色从主题取
  // （P4-2；dark = 原 chat-screen 复刻常量 DEFAULT_*_FG，其余 0）。
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
      cursorFg: theme.fg.cursor,
      candidateActiveFg: theme.fg.active,
    },
  );
}

function drawOverlaysInRegion(buf: CellBuffer, state: ChatScreenState, cols: number, layout: ChatLayout): void {
  const theme = state.theme ?? DEFAULT_THEME; // P4-2：浮层高亮从主题取（缺省 dark 零变化）
  // P3-E 接线1（G-31）：palette 进浮层栈**栈底**（紧贴 composer；面板打开即独占浮层栈，
  // 与审批/队列等互斥由装配层保证）。绘制经 A 棒 drawPalette（组头/badge/active 前缀），
  // 高亮与注释色取主题（与 drawOverlay 同源）。
  const palette = state.palette?.state.open === true ? state.palette : undefined;
  const paletteHeight = palette !== undefined ? paletteNaturalHeight(palette.rows.length) : 0;
  if (state.overlays.length === 0 && paletteHeight === 0) return;
  // 区域模型下 overlayModal 的可用空间 = 固定区簇之上（clusterTop），即 prompt 顶行
  // （本阶段数据面板隐藏，簇顶 == composer.top）；栈布局在区域内复刻（多浮层自下而上）。
  const composerTop = layout.composer.top;
  const rects = overlayStackLayout({
    screenRows: composerTop,
    composerTop,
    overlays: [
      ...(paletteHeight > 0 ? [{ height: paletteHeight }] : []),
      ...state.overlays.map((spec) => ({ height: overlayNaturalHeight(spec) })),
    ],
  });
  let offset = 0;
  if (palette !== undefined) {
    const rect = rects[0];
    if (rect != null) {
      // drawPalette 画满 buf 宽（PaletteDrawOptions 无 width 缝——A 棒契约：面板恒全宽）
      drawPalette(buf, palette.state, palette.rows, rect, {
        activeFg: theme.fg.active,
        headerFg: theme.fg.system,
      });
    }
    offset = 1;
  }
  for (let i = 0; i < state.overlays.length; i += 1) {
    const rect = rects[offset + i];
    const spec = state.overlays[i];
    if (rect == null || spec === undefined) continue;
    drawOverlay(buf, spec, rect, { width: cols, activeFg: theme.fg.active, showNumbers: spec.showNumbers === true });
  }
}

/**
 * 整帧呈现（P2-C 区域接线）：布局由 allocateRegions 确定性给出（与 layoutChat 同一输入
 * → 同一分配），绘制经 RegionLayoutManager 按区域预算驱动现有 draw 级 API
 * （drawScrollback / drawComposer / writeRowClipped / drawOverlay）——八区域中
 * scrollback/prompt/statusLine/shortcutsBar/overlayModal 已接线，
 * queuePane/todosPane/tasksPane 无数据源缺省隐藏（不造假内容）。
 * 一次 screen.render 回调内画完全部区域，diff-presenter 差量输出。
 * 返回本次写入字节数（无差异为 0；未 start 返回 0）。
 */
export function renderChat(screen: Screen, state: ChatScreenState): number {
  const cols = screen.cols;
  // scrollback cols 契约：内容区宽 = 屏宽 - 1 滚动条列（与 resizeChat 同一契约，防御性同步）
  const contentCols = Math.max(1, cols - 1);
  if (state.scrollback.cols !== contentCols) state.scrollback.setCols(contentCols);
  const chat = measureChatLayers(state, cols);
  const region = allocateRegions(screen.rows, buildRegionInputs(state, chat));
  const layout = mapRegionLayout(region, chat);

  const manager = new RegionLayoutManager();
  manager.setInput('scrollback', {
    render: ({ buf }) => {
      drawScrollbackLayer(buf, state, layout.scrollback);
    },
  });
  manager.setInput('prompt', {
    render: ({ buf }) => {
      drawComposerLayer(buf, state, layout);
    },
  });
  manager.setInput('statusLine', {
    render: ({ buf, top }) => {
      // P3-E 接线4（G-47）：command 型多行输出逐行绘制（每行 ≤1024 字符由 shapeCommandOutput
      // 钳制）；无 statusLines 时维持单行 statusline 语义（writeRowClipped 越界行静默忽略）
      const lines = state.statusLines ?? [state.statusline ?? ''];
      for (let i = 0; i < lines.length; i += 1) {
        writeRowClipped(buf, top + i, lines[i] ?? '', cols, 0);
      }
    },
  });
  manager.setInput('shortcutsBar', {
    render: ({ buf, top }) => {
      writeRowClipped(buf, top, shortcutsText(state.shortcuts), cols, 0);
    },
  });
  if (state.overlays.length > 0 || state.palette?.state.open === true) {
    manager.setInput('overlayModal', {
      render: ({ buf }) => {
        drawOverlaysInRegion(buf, state, cols, layout);
      },
    });
  }
  return screen.render((buf) => {
    manager.render(buf, region);
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
