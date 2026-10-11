// 分屏工作台的**内存状态仓库**（Z2-06 / Z-19）。
//
// 纯 TS（不依赖 React/DOM）：组件经 `useSyncExternalStore` 订阅，动作全部是同步纯状态转移。
// **只存内存、不落盘**：本仓 `test/layout/no-persistence.test.ts`（D-14）禁止渲染端浏览器存储
// 与旧分屏持久化通道；ZCode 的 `zcode-v4-pane-layout:v2` 持久化**本期不做**（见交付说明的登记项）。
//
// 焦点模型：焦点叶（`focusedId`）是视觉焦点；**主格**由壳按 `bindings` 与当前 selectedId 推导
// （绑定当前 selectedId 的那一格 = 主格）。主格无关闭按钮，非主格右上角有浮动关闭按钮（Z-19）。
import {
  MAX_PANES,
  clampRatio,
  countPanes,
  createInitialSnapshot,
  findLeaf,
  findLeafBySession,
  firstLeafId,
  removeLeaf,
  setSplitRatio,
  splitLeafAt,
  type SplitSide,
  type WorkbenchSnapshot,
} from './model.js';

/** 投放被拒/落定原因（供壳给用户可见提示，不静默） */
export type DropReason = 'duplicate' | 'limit' | 'unknown-leaf' | 'empty-session';

export interface DropOutcome {
  readonly ok: boolean;
  readonly reason?: DropReason;
  /** 命中的叶（重复投放时 = 已在分屏中的那一格） */
  readonly leafId?: string;
}

export interface DropInput {
  readonly sessionId: string;
  readonly targetLeafId: string;
  readonly side: SplitSide;
}

/** 分屏工作台状态仓库（应用级单例见文件末 `workbenchStore`；测试可 new 独立实例） */
export class WorkbenchStore {
  private snapshot: WorkbenchSnapshot;
  private seq: number;
  private readonly listeners = new Set<() => void>();

  constructor(initial: WorkbenchSnapshot = createInitialSnapshot()) {
    this.snapshot = initial;
    this.seq = countPanes(initial.root);
  }

  readonly getSnapshot = (): WorkbenchSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(next: WorkbenchSnapshot): void {
    if (next === this.snapshot) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** 复位为单叶初始态（测试/热重载用；正常生命周期与进程同寿） */
  reset(): void {
    this.seq = 1;
    this.set(createInitialSnapshot());
  }

  /** 聚焦某叶（叶不存在或已是焦点时不动） */
  focusLeaf(leafId: string): void {
    const snap = this.snapshot;
    if (snap.focusedId === leafId) return;
    if (findLeaf(snap.root, leafId) === undefined) return;
    this.set({ ...snap, focusedId: leafId });
  }

  /**
   * 会话选择变化时的同步（壳在 selectedId 变化的 effect 里调用）：
   *   * 该会话已在某格 → 焦点移到那一格（主格 = 该格，不新建）；
   *   * 不在任何格 → 让「上一主格」改绑到新会话（主格跟随左侧选择）。
   */
  syncSelection(selectedId: string | null, previousSelectedId: string | null): void {
    if (selectedId === null) return;
    const snap = this.snapshot;
    const existing = findLeafBySession(snap.bindings, selectedId);
    if (existing !== undefined) {
      if (snap.focusedId !== existing) this.set({ ...snap, focusedId: existing });
      return;
    }
    const previous = previousSelectedId === null ? undefined : findLeafBySession(snap.bindings, previousSelectedId);
    const target =
      previous ?? (findLeaf(snap.root, snap.focusedId) !== undefined ? snap.focusedId : firstLeafId(snap.root));
    this.set({ ...snap, bindings: { ...snap.bindings, [target]: selectedId }, focusedId: target });
  }

  /**
   * 投放一个会话到目标格的某条边（Z-19）：
   *   1. 该会话已在分屏中 → 聚焦该格（**去重**，不新建）；
   *   2. 已达上限 4 格 → 拒绝（reason:'limit'）；
   *   3. 否则在目标叶处分裂出新格并绑定该会话，新格成为焦点（**不改变全局 selectedId**）。
   */
  dropSession(input: DropInput): DropOutcome {
    const { sessionId, targetLeafId, side } = input;
    if (sessionId.length === 0) return { ok: false, reason: 'empty-session' };
    const snap = this.snapshot;
    const existing = findLeafBySession(snap.bindings, sessionId);
    if (existing !== undefined) {
      this.focusLeaf(existing);
      return { ok: false, reason: 'duplicate', leafId: existing };
    }
    if (countPanes(snap.root) >= MAX_PANES) return { ok: false, reason: 'limit' };
    const newLeafId = `pane-${this.seq}`;
    const root = splitLeafAt(snap.root, targetLeafId, side, newLeafId);
    if (root === null) return { ok: false, reason: 'unknown-leaf' };
    this.seq += 1;
    this.set({ root, bindings: { ...snap.bindings, [newLeafId]: sessionId }, focusedId: newLeafId });
    return { ok: true, leafId: newLeafId };
  }

  /**
   * 关闭一格：从树中移除该叶、父分割塌缩、绑定删除；焦点回到 `focusAfter`（壳给主格）。
   * **关闭格 ≠ 停止会话**：这里只动布局，不碰任何会话流/进程（会话仍在后台跑）。
   */
  closeLeaf(leafId: string, focusAfter: string): void {
    const snap = this.snapshot;
    if (countPanes(snap.root) <= 1) return; // 最后一格不可关（单格时也不渲染关闭按钮）
    const root = removeLeaf(snap.root, leafId);
    if (root === null) return;
    const bindings = { ...snap.bindings };
    delete bindings[leafId];
    const focus = findLeaf(root, focusAfter) !== undefined ? focusAfter : firstLeafId(root);
    this.set({ root, bindings, focusedId: focus });
  }

  /** 改分割比例（钳制到 [0.25, 0.75]） */
  setRatio(splitId: string, ratio: number): void {
    const snap = this.snapshot;
    const root = setSplitRatio(snap.root, splitId, clampRatio(ratio));
    if (root === snap.root) return;
    this.set({ ...snap, root });
  }
}

/** 应用级单例（渲染端内存；与进程同寿，不落盘） */
export const workbenchStore = new WorkbenchStore();
