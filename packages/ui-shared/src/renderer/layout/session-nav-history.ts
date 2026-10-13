// SessionNavHistory —— 壳无关的「会话导航历史」（Z10-3：顶部 后退 / 前进）。
//
// 语义对标浏览器前进/后退栈，与 ZCode 顶部两枚按钮、`navigateBack = CmdOrCtrl+[` /
// `navigateForward = CmdOrCtrl+]`（源码 @zcode/shared/shortcutCommands.ts，权威）一致：
//   * record(会话 id)：选中会话变化时调用；
//       - **相邻重复去重**：与游标处相同则不记录（点回同一会话不污染历史）；
//       - **截断 forward 分支**：从非栈顶记录时丢弃游标之后的分支（同浏览器访问新页）；
//       - **上限 50**：超出则丢最旧，防无限增长。
//   * back() / forward()：游标 ±1 并返回目标 sessionId（无路可走 → null，不抛错）。
//   * canGoBack() / canGoForward()：驱动顶部按钮的 disabled（ZCode 常驻显示，无路可走即置灰）。
//
// 纯逻辑（不依赖 React / DOM、**不落盘**，D-14）：组件经 `useSyncExternalStore` 订阅。
// 两壳各自在「selectedId 变化」处 record，并把 back/forward 接到同一个 `controller.selectSession`。

/** 历史栈上限（防无限增长；超出丢最旧） */
export const SESSION_NAV_HISTORY_LIMIT = 50;

/** 导航历史快照（entries 为会话 id 序列；index = 游标，-1 表示空栈） */
export interface SessionNavHistoryState {
  readonly entries: readonly string[];
  /** 当前游标（-1 = 空栈） */
  readonly index: number;
}

/** 空历史（栈空、游标 -1） */
export function initialSessionNavHistory(): SessionNavHistoryState {
  return { entries: [], index: -1 };
}

/** 当前游标所在条目；空栈 → null */
export function currentHistoryEntry(state: SessionNavHistoryState): string | null {
  if (state.index < 0) return null;
  return state.entries[state.index] ?? null;
}

/** 是否有可回退的历史 */
export function canGoBack(state: SessionNavHistoryState): boolean {
  return state.index > 0;
}

/** 是否有可前进的历史（游标之后仍有条目） */
export function canGoForward(state: SessionNavHistoryState): boolean {
  return state.index >= 0 && state.index < state.entries.length - 1;
}

/**
 * 记录一次会话选中（纯函数，返回新状态；无变化时原样返回同一引用）。
 * @param state - 当前历史状态。
 * @param sessionId - 被选中的会话 id（空串 → 不记录）。
 * @returns 记录后的历史状态。
 */
export function recordHistoryEntry(state: SessionNavHistoryState, sessionId: string): SessionNavHistoryState {
  if (sessionId.length === 0) return state;
  if (state.entries[state.index] === sessionId) return state; // 相邻重复：不动
  const kept = state.entries.slice(0, state.index + 1); // 截断 forward 分支
  kept.push(sessionId);
  const overflow = kept.length - SESSION_NAV_HISTORY_LIMIT;
  if (overflow > 0) kept.splice(0, overflow); // 超上限：丢最旧
  return { entries: kept, index: kept.length - 1 };
}

/** 游标后退一格（纯函数；已到最旧 → 原样返回） */
export function stepHistoryBack(state: SessionNavHistoryState): SessionNavHistoryState {
  if (!canGoBack(state)) return state;
  return { entries: state.entries, index: state.index - 1 };
}

/** 游标前进一格（纯函数；已到最新 → 原样返回） */
export function stepHistoryForward(state: SessionNavHistoryState): SessionNavHistoryState {
  if (!canGoForward(state)) return state;
  return { entries: state.entries, index: state.index + 1 };
}

/** 会话导航历史仓库（应用级单例见文件末 `sessionNavHistory`；测试可 new 独立实例） */
export class SessionNavHistory {
  private state: SessionNavHistoryState = initialSessionNavHistory();
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): SessionNavHistoryState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(next: SessionNavHistoryState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** 复位为空历史（测试/热重载用；正常生命周期与进程同寿） */
  reset(): void {
    this.set(initialSessionNavHistory());
  }

  /** 记录一次会话选中（去重 / 截断 forward / 超上限丢最旧） */
  record(sessionId: string): void {
    this.set(recordHistoryEntry(this.state, sessionId));
  }

  /** 后退一格并返回目标会话 id；无路可走 → null（不抛错、不误动） */
  back(): string | null {
    this.set(stepHistoryBack(this.state));
    return currentHistoryEntry(this.state);
  }

  /** 前进一格并返回目标会话 id；无路可走 → null */
  forward(): string | null {
    this.set(stepHistoryForward(this.state));
    return currentHistoryEntry(this.state);
  }

  canGoBack(): boolean {
    return canGoBack(this.state);
  }

  canGoForward(): boolean {
    return canGoForward(this.state);
  }
}

/** 应用级单例（渲染端内存；与进程同寿，不落盘） */
export const sessionNavHistory = new SessionNavHistory();
