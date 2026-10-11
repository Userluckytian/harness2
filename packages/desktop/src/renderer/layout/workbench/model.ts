// 分屏工作台（Z2-06 / Z-19）的**纯模型**：二叉分割树 + 落点几何 + 比例钳制。
//
// 本文件零依赖（不 import React / store / DOM），所有函数同入参同出参，可直接单测。
// 依据 docs/refs/refs-zcode-layout.md Z-19：宿主 primary pane、**上限 4 pane**、二叉分割树、
// 边缘投放 32% 带（侧栏 workbenchDragDrop.ts:81-107）。比例与落点常量与 Z-19 对齐。
//
// 与 ZCode 的差异（本仓约束）：
//   * ZCode 把布局持久化到 `zcode-v4-pane-layout:v2`；本仓 `test/layout/no-persistence.test.ts`（D-14）
//     禁止渲染端任何浏览器存储与旧分屏持久化通道 → **本期分屏布局只存内存**（不落盘）。

/** 分割方向：`row` = 子节点横向排布（左右分）；`column` = 子节点纵向排布（上下分） */
export type SplitDirection = 'row' | 'column';

/** 投放边：`left`/`right` 生成 row 分割；`up`/`down` 生成 column 分割 */
export type SplitSide = 'left' | 'right' | 'up' | 'down';

/** 分割树节点：叶（一格会话）或分割（两个子节点 + 方向 + 比例） */
export type WorkbenchNode =
  | { readonly t: 'leaf'; readonly id: string }
  | {
      readonly t: 'split';
      readonly id: string;
      readonly dir: SplitDirection;
      readonly ratio: number;
      readonly a: WorkbenchNode;
      readonly b: WorkbenchNode;
    };

/** 工作台快照（React 经 useSyncExternalStore 订阅；每次变更换新引用） */
export interface WorkbenchSnapshot {
  readonly root: WorkbenchNode;
  /** 叶 id → 绑定的会话 id（未绑定的叶不在表中） */
  readonly bindings: Readonly<Record<string, string>>;
  /** 当前焦点叶 id（视觉焦点；与「主格」不一定是同一格） */
  readonly focusedId: string;
}

/** 分屏上限（Z-19：paneLayoutTree.ts 上限 4 pane） */
export const MAX_PANES = 4;
/** 分割比例下/上限（Z-19；钳制到 [0.25, 0.75]） */
export const SPLIT_MIN = 0.25;
export const SPLIT_MAX = 0.75;
/** 投放边缘带宽度（归一化；Z-19 侧栏 workbenchDragDrop.ts:81-107 的 32% 带） */
export const DROP_EDGE = 0.32;
/** 键盘调比例步长 */
export const SPLIT_STEP = 0.02;

/** 矩形的几何子集（DOMRect 兼容，便于纯函数单测） */
export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** 初始快照：单叶、未绑定（绑定由壳在拿到 selectedId 后经 syncSelection 写入） */
export function createInitialSnapshot(leafId = 'pane-0'): WorkbenchSnapshot {
  return { root: { t: 'leaf', id: leafId }, bindings: {}, focusedId: leafId };
}

/** 比例钳制（NaN 一律回落中值 0.5，避免把 NaN 写进 CSS 变量） */
export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio));
}

/** 叶数量（分屏格数） */
export function countPanes(node: WorkbenchNode): number {
  return node.t === 'leaf' ? 1 : countPanes(node.a) + countPanes(node.b);
}

/** 全部叶 id（深度优先、左到右） */
export function leafIds(node: WorkbenchNode): string[] {
  return node.t === 'leaf' ? [node.id] : [...leafIds(node.a), ...leafIds(node.b)];
}

/** 第一个叶 id（焦点回落用） */
export function firstLeafId(node: WorkbenchNode): string {
  let cur: WorkbenchNode = node;
  while (cur.t === 'split') cur = cur.a;
  return cur.id;
}

/** 按叶 id 找叶节点（找不到返回 undefined） */
export function findLeaf(node: WorkbenchNode, leafId: string): WorkbenchNode | undefined {
  if (node.t === 'leaf') return node.id === leafId ? node : undefined;
  return findLeaf(node.a, leafId) ?? findLeaf(node.b, leafId);
}

/** 按会话 id 找承载它的叶 id（去重判据；同一会话只应出现在一格） */
export function findLeafBySession(
  bindings: Readonly<Record<string, string>>,
  sessionId: string | null,
): string | undefined {
  if (sessionId === null) return undefined;
  for (const [leafId, bound] of Object.entries(bindings)) if (bound === sessionId) return leafId;
  return undefined;
}

/** 叶绑定的会话 id（未绑定返回 undefined） */
export function sessionOfLeaf(bindings: Readonly<Record<string, string>>, leafId: string): string | undefined {
  return bindings[leafId];
}

/** 用 next 替换 id 命中的节点（叶/分割通用；命中不到原样返回，保持引用） */
export function replaceNode(node: WorkbenchNode, targetId: string, next: WorkbenchNode): WorkbenchNode {
  if (node.id === targetId) return next;
  if (node.t === 'leaf') return node;
  const a = replaceNode(node.a, targetId, next);
  const b = replaceNode(node.b, targetId, next);
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

/** 用 next 替换叶（语义化别名；叶不存在时原样返回） */
export function replaceLeaf(node: WorkbenchNode, leafId: string, next: WorkbenchNode): WorkbenchNode {
  return replaceNode(node, leafId, next);
}

/**
 * 移除叶并让父分割塌缩：父节点由「另一侧子节点」顶替（分割 id 随父消失）。
 * 移除根叶（树只剩它）返回 null；叶不存在时原样返回（引用不变）。
 */
export function removeLeaf(node: WorkbenchNode, leafId: string): WorkbenchNode | null {
  if (node.t === 'leaf') return node.id === leafId ? null : node;
  const a = removeLeaf(node.a, leafId);
  const b = removeLeaf(node.b, leafId);
  if (a === null) return b;
  if (b === null) return a;
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

/**
 * 在叶处按边分裂出新叶：
 *   `left`/`up` 把新叶插在**前**（a），`right`/`down` 插在**后**（b）；
 *   `left`/`right` → `dir:'row'`，`up`/`down` → `dir:'column'`；`ratio:0.5`。
 * 分割 id 由新叶 id 派生（`split:<newLeafId>`），保证确定性且唯一。
 * 目标叶不存在返回 null。
 */
export function splitLeafAt(
  node: WorkbenchNode,
  leafId: string,
  side: SplitSide,
  newLeafId: string,
): WorkbenchNode | null {
  if (findLeaf(node, leafId) === undefined) return null;
  const dir: SplitDirection = side === 'left' || side === 'right' ? 'row' : 'column';
  const newFirst = side === 'left' || side === 'up';
  const target: WorkbenchNode = { t: 'leaf', id: leafId };
  const added: WorkbenchNode = { t: 'leaf', id: newLeafId };
  const split: WorkbenchNode = {
    t: 'split',
    id: `split:${newLeafId}`,
    dir,
    ratio: 0.5,
    a: newFirst ? added : target,
    b: newFirst ? target : added,
  };
  return replaceLeaf(node, leafId, split);
}

/** 改某分割的比例（钳制；命中不到或值未变时返回原引用） */
export function setSplitRatio(node: WorkbenchNode, splitId: string, ratio: number): WorkbenchNode {
  const next = clampRatio(ratio);
  if (node.t === 'leaf') return node;
  if (node.id === splitId) {
    if (node.ratio === next) return node;
    return { ...node, ratio: next };
  }
  const a = setSplitRatio(node.a, splitId, next);
  const b = setSplitRatio(node.b, splitId, next);
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

/**
 * 落点判定（纯几何）：把目标格视为归一化坐标，取到四边的最小距离；
 * 最小距离 ≤ DROP_EDGE(0.32) 返回该 side，否则返回 null（中间区域不分屏，避免误触）。
 * 宽/高为 0（未测量）时一律返回 null。
 */
export function dropSideForRect(rect: RectLike, x: number, y: number): SplitSide | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const nx = (x - rect.left) / rect.width;
  const ny = (y - rect.top) / rect.height;
  const distances: ReadonlyArray<readonly [SplitSide, number]> = [
    ['left', nx],
    ['right', 1 - nx],
    ['up', ny],
    ['down', 1 - ny],
  ];
  let best: SplitSide = 'left';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [side, distance] of distances) {
    if (distance < bestDistance) {
      bestDistance = distance;
      best = side;
    }
  }
  return bestDistance <= DROP_EDGE ? best : null;
}
