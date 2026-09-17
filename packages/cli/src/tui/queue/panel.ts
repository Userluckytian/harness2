// panel.ts — G-29 队列面板纯逻辑（headless 可测，零旧壳 / 零渲染器依赖）。
//
// 规格依据：refs-grok-build.md G-29 与上游 03-keyboard-shortcuts.md：
//  - `Ctrl+;` 打开队列面板（备用 `Ctrl+'`——部分 Windows 控制台在标点键上丢 Ctrl 修饰）；
//    本地 macOS VS Code 族主键 `Ctrl+4`（`;` / `'` 仍作备用）。上游原文：「Toggle the prompt
//    queue pane (when non-empty)」——**队列非空才可打开**（空队列无面板可看，不做假入口）。
//  - `↑`（prompt 聚焦 + 空草稿 + normal 输入模式）：有排队条目 → 焦点转入队列面板且**末行
//    高亮**；无排队条目 → 打开历史面板（refs G-29：「↑ 在队列/历史间转焦点」——队列侧归本
//    模块，历史面板归装配层既有能力，这里只给出焦点裁决结果）。
//  - 面板内行键位（上游）：↑/↓ 走行、`e` 编辑高亮行、`Enter` 立即发送高亮行（send now）。
//
// 和弦编码口径与 input/keymaps.ts 一致（字母小写 + 修饰位；ctrl/alt 精确相等）：
//  - Ctrl+; / Ctrl+' / Ctrl+4 没有 C0 控制字节编码，legacy 终端不可达，仅 kitty keyboard
//    protocol（或等价扩展）可收——与上游 WezTerm 需 enable_kitty_keyboard 的登记同源；
//  - 判定复用 input/keymaps.ts 的 chordMatches（单一实现，不在本模块复刻匹配语义）。
import { chordMatches, type Chord } from '../input/keymaps.js';
import type { KeyEvent } from '../../input/types.js';
import type { QueuedFollowUp } from './queue.js';

/** 面板条目单行预览列宽（与旧壳 queue-panel / next chat-screen 的 42 列约定同源） */
export const QUEUE_PREVIEW_MAX = 42;

/** 队列面板条目单行预览：折行合一 + 超长截断加省略号（仅展示用，绝不改队列原文） */
export function queueEntryPreview(text: string, max: number = QUEUE_PREVIEW_MAX): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

// —— G-29 打开键位（三变体数据化；表即文档）────────────────────────────────────

/** 打开键位变体 id：primary = `Ctrl+;`；alt = `Ctrl+'`；mac-vscode = macOS VS Code 族 `Ctrl+4` */
export type QueuePanelOpenKeyVariant = 'primary' | 'alt' | 'mac-vscode';

export interface QueuePanelOpenKey {
  readonly variant: QueuePanelOpenKeyVariant;
  readonly label: string;
  readonly chords: readonly Chord[];
  /** 差异备注（cheatsheet / 报告复用） */
  readonly note: string;
}

/**
 * G-29 打开键位三变体（refs-grok-build.md G-29；上游 03-keyboard-shortcuts.md L229 + L248）：
 * primary `Ctrl+;`（default 主键）；alt `Ctrl+'`（Windows 标点丢 Ctrl 的备用）；
 * mac-vscode `Ctrl+4`（本地 macOS VS Code 族主键，`;` / `'` 仍作备用——三行全匹配即语义正确）。
 */
export const QUEUE_PANEL_OPEN_KEYS: readonly QueuePanelOpenKey[] = [
  {
    variant: 'primary',
    label: 'Ctrl+;',
    chords: [{ key: ';', ctrl: true }],
    note: 'G-29 主键（非 macOS-VS Code 环境与 macOS VS Code 族备用）',
  },
  {
    variant: 'alt',
    label: "Ctrl+'",
    chords: [{ key: "'", ctrl: true }],
    note: 'G-29 备用：部分 Windows 控制台在标点键上丢 Ctrl 修饰',
  },
  {
    variant: 'mac-vscode',
    label: 'Ctrl+4',
    chords: [{ key: '4', ctrl: true }],
    note: "G-29：本地 macOS VS Code 族主键（; / ' 仍备用）",
  },
];

/** 键事件是否命中队列面板打开键（三变体任一命中即可——环境差异在键位表数据里，不在逻辑里） */
export function matchesQueuePanelOpenKey(ev: KeyEvent): QueuePanelOpenKeyVariant | null {
  for (const binding of QUEUE_PANEL_OPEN_KEYS) {
    if (binding.chords.some((chord) => chordMatches(chord, ev))) return binding.variant;
  }
  return null;
}

// —— 面板状态机（纯 reducer）────────────────────────────────────────────────────

/** 焦点目标（G-29：队列 / 历史之间转焦点） */
export type QueuePanelFocus = 'queue' | 'history';

export interface QueuePanelState {
  readonly open: boolean;
  readonly focus: QueuePanelFocus;
  /** 高亮行下标（队列侧；0 起，恒被钳到 [0, queueCount-1]） */
  readonly activeIndex: number;
}

export function createQueuePanelState(): QueuePanelState {
  return { open: false, focus: 'queue', activeIndex: 0 };
}

/** 队列条目数（装配层每次状态变化传入；本模块不持有队列本体） */
export interface QueuePanelEnv {
  readonly queueCount: number;
}

/**
 * `↑` 的焦点裁决（G-29；上游 L236 全语义）：
 *  - prompt 聚焦 + 空草稿 + normal 输入模式（调用方保证，本函数只认参数）；
 *  - 有排队条目 → 'queue'（面板打开、**末行**高亮）；
 *  - 无排队条目 → 'history'（历史面板归装配层；这里只给裁决，不开假面板）。
 *  返回 null = 条件不满足（草稿非空 / 已在面板内——本函数不重复吃焦点键）。
 */
export function focusTargetForUp(
  params: { draftEmpty: boolean; panelOpen: boolean } & QueuePanelEnv,
): QueuePanelFocus | null {
  if (!params.draftEmpty || params.panelOpen) return null;
  return params.queueCount > 0 ? 'queue' : 'history';
}

/**
 * 切换面板开合（G-29「when non-empty」）：队列非空才允许打开；空队列尝试打开 = 无操作
 * （不开假入口）。打开时焦点落队列、高亮**末行**（上游：「with the last row highlighted」）。
 * 关闭无条件可做（运行中面板是 busy 态伴生浮层，队列清空时装配层也应调此函数收起）。
 */
export function toggleQueuePanel(state: QueuePanelState, env: QueuePanelEnv): QueuePanelState {
  if (state.open) return { ...state, open: false };
  if (env.queueCount === 0) return state; // 空队列不开假面板
  return { open: true, focus: 'queue', activeIndex: Math.max(0, env.queueCount - 1) };
}

/** 编程开合（装配层在队列清空/turn 收尾时收起伴生浮层用）；语义与 toggle 显式分支一致 */
export function setQueuePanelOpen(state: QueuePanelState, open: boolean, env: QueuePanelEnv): QueuePanelState {
  if (!open) return { ...state, open: false };
  if (env.queueCount === 0) return state;
  return { open: true, focus: 'queue', activeIndex: Math.min(Math.max(0, state.activeIndex), env.queueCount - 1) };
}

/** ↑ 在队列/历史间转焦点（G-29；面板打开时↑ 不再是入口，而是转移焦点） */
export function transferQueuePanelFocus(state: QueuePanelState, env: QueuePanelEnv): QueuePanelState {
  if (!state.open) return state;
  const next: QueuePanelFocus = state.focus === 'queue' ? 'history' : 'queue';
  // 焦点离开队列后高亮行保留原位；回队列时重新钳制（行数可能已变）
  return {
    ...state,
    focus: next,
    activeIndex: Math.min(Math.max(0, state.activeIndex), Math.max(0, env.queueCount - 1)),
  };
}

/** 面板内 ↑/↓ 走行（队列侧；钳到 [0, queueCount-1]，历史侧归装配层） */
export function moveQueuePanelSelection(state: QueuePanelState, dir: -1 | 1, env: QueuePanelEnv): QueuePanelState {
  if (!state.open || state.focus !== 'queue' || env.queueCount === 0) return state;
  const max = env.queueCount - 1;
  const next = Math.min(Math.max(state.activeIndex + dir, 0), max);
  return next === state.activeIndex ? state : { ...state, activeIndex: next };
}

/** 高亮行越界自愈（队列在面板打开期间被 send-now/取消改动后调用；不越界返回原引用） */
export function clampQueuePanelSelection(state: QueuePanelState, env: QueuePanelEnv): QueuePanelState {
  const max = Math.max(0, env.queueCount - 1);
  const next = Math.min(Math.max(state.activeIndex, 0), max);
  return next === state.activeIndex ? state : { ...state, activeIndex: next };
}

// —— 条目渲染结构（纯数据；真笔触归渲染层/装配层）──────────────────────────────

/** 队列面板单行渲染结构（装配层据此画：高亮行/普通行/计数头） */
export interface QueuePanelRow {
  readonly id: string;
  readonly seq: number;
  /** 单行预览（折行合一 + 42 列截断；不改原文） */
  readonly preview: string;
  readonly active: boolean;
}

/** 面板头部结构（计数 + 焦点提示；G-29 面板与历史共占一槽时供装配层区分焦点落点） */
export interface QueuePanelHeader {
  readonly title: string;
  readonly focus: QueuePanelFocus;
}

/** 队列条目 → 面板渲染结构（activeIndex 越界时无行高亮——不猜一行来高亮） */
export function renderQueuePanelRows(
  entries: readonly QueuedFollowUp[],
  state: QueuePanelState,
): { header: QueuePanelHeader; rows: readonly QueuePanelRow[] } {
  const rows = entries.map((entry, i) => ({
    id: entry.id,
    seq: entry.seq,
    preview: queueEntryPreview(entry.text),
    active: state.open && state.focus === 'queue' && i === state.activeIndex,
  }));
  return {
    header: { title: `Queue · ${entries.length}`, focus: state.focus },
    rows,
  };
}
