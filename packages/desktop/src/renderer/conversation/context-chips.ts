// context-chips.ts — Z10-2 桌面「项目」「Git 分支」chip 的数据接线（会话 cwd → 项目名；
// `gitBranch` IPC → 分支名）。
//
// ⚠️ 如实口径（红线⑩）：
//   * 两者本仓都**无切换通道** —— 全仓 grep 无 `git checkout` / `switch branch` / 「切换当前会话
//     项目/cwd」类 IPC（唯一 git IPC 是只读的 `gitBranch`）→ chip 只读（disabled + title），
//     由 `context-chips.tsx`（ui-shared）落实，绝不为它新造 IPC。
//   * 无 cwd → 项目 chip 不渲染；`gitBranch` 返回 null / 失败 → 分支 chip 不渲染（不显示假分支名）。
//
// 数据取**本格会话**（分屏每格各自正确）：cwd 来自 store 的会话摘要，分支对 cwd 现查。
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { AppStore } from '@harness2/ui-shared/renderer/store.js';
import {
  buildContextChips,
  type ComposerContextChipsProps,
} from '@harness2/ui-shared/renderer/conversation/composer/context-chips.js';

/** 读本格会话的 cwd（无会话 / 无 cwd → undefined）。订阅 store，会话或 cwd 变化即更新。 */
export function useSessionCwd(store: AppStore, sessionId: string | undefined | null): string | undefined {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  if (sessionId === undefined || sessionId === null) return undefined;
  return state.sessions.find((s) => s.id === sessionId)?.cwd;
}

/**
 * 对 cwd 调 `gitBranch`（异步；每次 cwd 变化重新查）。无 cwd / 无通道 / 失败 / null → undefined
 * （**不显示假分支名**）。切换会话（cwd 变）先清旧值再查，避免短暂显示上一会话的分支。
 */
export function useGitBranch(cwd: string | undefined): string | undefined {
  const [branch, setBranch] = useState<string | undefined>(undefined);
  useEffect(() => {
    setBranch(undefined);
    if (cwd === undefined || cwd.length === 0) return;
    const api = window.harness2;
    if (api.gitBranch === undefined) return;
    let cancelled = false;
    api
      .gitBranch(cwd)
      .then((b) => {
        if (!cancelled) setBranch(b ?? undefined);
      })
      .catch(() => {
        if (!cancelled) setBranch(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);
  return branch;
}

/**
 * 桌面会话席位用的 chip 数据面：项目名 = 会话 cwd 末段；分支 = `gitBranch(cwd)` 简称。
 * 两者都无 → undefined（整行不渲染）。两 chip 均无切换通道 → 只读（buildContextChips 缺省无 onPick）。
 */
export function useSessionContextChips(
  store: AppStore,
  sessionId: string | undefined | null,
): ComposerContextChipsProps | undefined {
  const cwd = useSessionCwd(store, sessionId);
  const branch = useGitBranch(cwd);
  return useMemo(() => buildContextChips(cwd, branch), [cwd, branch]);
}
