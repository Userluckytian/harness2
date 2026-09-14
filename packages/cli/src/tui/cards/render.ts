// cards/render.ts — P3-B：四类卡片的最小呈现契约（纯函数，G-21～G-24）。
//
// 规格依据：docs/refs/refs-grok-build.md G-4x。本文件只产出**绘制所需结构**
// （标题/正文/可交互项/提示行），不画假 UI——真实绘制（锚定、折行、反色高亮、
// CellBuffer 落笔）归接线棒：CardView 与 next/overlay.ts 的 OverlaySpec 一一可映射
// （title→title、items[].label→items、焦点环 index→activeIndex），接线层零换算成本。
//
// 可交互项（items）同时是 G-25 卡内焦点环的轨道：items.length = 环长，
// 顺序即环序（Tab 沿数组下标 +1 环走）。项 id 与既有应答通道对齐：
//  - permission 三项 id 直接复用 ApprovalGate.choose 的应答空间 'y' | 'a' | 'n'；
//  - question 选项 id 复用 payload.options[].id，自由文本项 id 固定 'question:free-text'；
//  - cancel-turn / elicitation 为固定动作 id（见各 render 函数）。
import type { BlockCard, CancelTurnCard, ElicitationCard, PermissionCard, QuestionCard } from './types.js';

/** 卡片可交互项（焦点环的最小单元） */
export interface CardItemView {
  /** 稳定 id：接线层按它把「Enter/数字直选」翻译成 CardAnswer（映射表见文件头） */
  readonly id: string;
  readonly label: string;
  /** action=按钮类动作；option=问题选项；text-input=自由文本入口 */
  readonly kind: 'action' | 'option' | 'text-input';
}

/** 卡片绘制所需结构（纯数据；不携带颜色/几何——视觉归接线层） */
export interface CardView {
  readonly cardId: string;
  readonly kind: BlockCard['kind'];
  /** 标题行（惯例：`Kind · 关键标识`，与 next-shell 的 `Approval · ${query}` 同风格） */
  readonly title: string;
  /** 正文行（原样文本，不折行不裁剪——宽度语义归接线层） */
  readonly body: readonly string[];
  /** 可交互项（G-25 焦点环轨道；顺序即环序） */
  readonly items: readonly CardItemView[];
  /** 环境注记行（如「另有 N 张卡排队被遮盖」）；无则为空 */
  readonly notes: readonly string[];
  /** 按键提示行 */
  readonly hints: readonly string[];
}

export interface RenderCardOptions {
  /** 本卡之后按优先级排队的卡数（>0 时产出遮盖注记行；接线层由 queue.pendingCards 取） */
  readonly queuedBehind?: number;
}

/** G-25 按键提示（四类共用；与 P2 Esc 语义 G-20 对齐） */
export const CARD_HINTS: readonly string[] = [
  'Tab/Shift+Tab 卡内环走（G-25，不落全局）',
  'Enter 确认高亮项',
  'Esc 逐级退出，退完 park（G-20）',
];

/** args 呈现：string 原样；undefined 标注无参；对象/其余 JSON 单行化（失败 fail-visible） */
export function permissionArgsText(args: unknown): string {
  if (args === undefined) return '（无参数）';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args) ?? String(args);
  } catch {
    return '[不可序列化参数]';
  }
}

// —— G-21 permission prompt：三项对齐既有审批卡（next-shell APPROVAL_ITEMS 同款应答空间）——

const PERMISSION_ITEMS: readonly CardItemView[] = [
  { id: 'y', label: 'y 允许（本次）', kind: 'action' },
  { id: 'a', label: 'a 总是允许（本会话）', kind: 'action' },
  { id: 'n', label: 'n 拒绝', kind: 'action' },
];

export function renderPermissionCard(card: PermissionCard, opts?: RenderCardOptions): CardView {
  const body = [permissionArgsText(card.payload.args)];
  if (card.payload.cwd !== undefined) body.push(`cwd: ${card.payload.cwd}`);
  if (card.payload.taskId !== undefined) body.push(`task: ${card.payload.taskId}`);
  return {
    cardId: card.id,
    kind: 'permission',
    title: `Approval · ${card.payload.tool}`,
    body,
    items: PERMISSION_ITEMS,
    notes: queuedNotes(opts),
    hints: CARD_HINTS,
  };
}

// —— G-22 cancel-turn panel：确认取消 vs 继续运行 ——

const CANCEL_TURN_ITEMS: readonly CardItemView[] = [
  { id: 'cancel-turn:confirm', label: '取消当前回合', kind: 'action' },
  { id: 'cancel-turn:resume', label: '继续运行', kind: 'action' },
];

export function renderCancelTurnCard(card: CancelTurnCard, opts?: RenderCardOptions): CardView {
  return {
    cardId: card.id,
    kind: 'cancel-turn',
    title: 'Cancel turn',
    body: [card.payload.reason ?? '确认取消当前运行中的回合？'],
    items: CANCEL_TURN_ITEMS,
    notes: queuedNotes(opts),
    hints: CARD_HINTS,
  };
}

// —— G-23 question card：选项 + 自由文本 ——

export const QUESTION_FREE_TEXT_ID = 'question:free-text';

export function renderQuestionCard(card: QuestionCard, opts?: RenderCardOptions): CardView {
  const optionItems: readonly CardItemView[] = card.payload.options.map((o) => ({
    id: o.id,
    label: o.description === undefined ? o.label : `${o.label} —— ${o.description}`,
    kind: 'option',
  }));
  // 自由文本项恒在列表末尾（G-23「选项 + 自由文本」；payload.allowFreeText=false 时不给）
  const items =
    card.payload.allowFreeText === true
      ? [...optionItems, { id: QUESTION_FREE_TEXT_ID, label: '自由文本…（选中后输入）', kind: 'text-input' as const }]
      : optionItems;
  return {
    cardId: card.id,
    kind: 'question',
    title: 'Question',
    body: [card.payload.question],
    items,
    notes: queuedNotes(opts),
    hints: CARD_HINTS,
  };
}

// —— G-24 MCP elicitation（x.ai/mcp/elicit）：accept/decline/cancel ——

const ELICITATION_ITEMS: readonly CardItemView[] = [
  { id: 'elicit:accept', label: '提交（accept）', kind: 'action' },
  { id: 'elicit:decline', label: '拒绝（decline）', kind: 'action' },
  { id: 'elicit:cancel', label: '取消（cancel）', kind: 'action' },
];

export function renderElicitationCard(card: ElicitationCard, opts?: RenderCardOptions): CardView {
  const body = [card.payload.message];
  if (card.payload.requestedSchema !== undefined) {
    body.push(`schema: ${permissionArgsText(card.payload.requestedSchema)}`);
  }
  return {
    cardId: card.id,
    kind: 'elicitation',
    title: `MCP Elicitation · ${card.payload.server}`,
    body,
    items: ELICITATION_ITEMS,
    notes: queuedNotes(opts),
    hints: CARD_HINTS,
  };
}

/** 遮盖注记（G-21「遮盖其他卡片」的可见性：被遮不是消失，给出 N 的诚实提示） */
function queuedNotes(opts?: RenderCardOptions): readonly string[] {
  const n = opts?.queuedBehind ?? 0;
  return n > 0 ? [`另有 ${n} 张卡排队（被本卡遮盖）`] : [];
}

/** 四类分发：任意 BlockCard → 绘制结构（未知 kind 不可表达——联合类型已穷尽） */
export function renderCard(card: BlockCard, opts?: RenderCardOptions): CardView {
  switch (card.kind) {
    case 'permission':
      return renderPermissionCard(card, opts);
    case 'cancel-turn':
      return renderCancelTurnCard(card, opts);
    case 'question':
      return renderQuestionCard(card, opts);
    case 'elicitation':
      return renderElicitationCard(card, opts);
  }
}
