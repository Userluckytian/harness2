// web-context-chips.ts — Z10-2 composer 上方「项目」「Git 分支」chip 的 web 接线。
//
// 如实降级（红线⑩）：
//   * **项目 chip = 只读展示**：项目名由会话 cwd 末段推出（web 的会话经 serve 带 cwd，无需额外通道）；
//     本壳无「切换当前会话项目/cwd」通道 → 只读（disabled + title，由 ui-shared 落实）。
//   * **分支 chip 恒不出**：web 无 `gitBranch` 通道（那在桌面主进程 preload/IPC），拿不到分支名就不
//     渲染 —— 不摆 disabled 假分支、更不显示假分支名（`buildContextChips` 的 branch 传 undefined）。
//   * 无会话 / 无 cwd → undefined（整行不渲染）。
import type { SessionMeta } from '@harness2/ui-shared/renderer/store.js';
import {
  buildContextChips,
  type ComposerContextChipsProps,
} from '@harness2/ui-shared/renderer/conversation/composer/context-chips.js';

/** web 会话席位用的 chip 数据面（项目只读；分支无通道不渲染）。 */
export function webContextChipsForSession(
  sessions: readonly SessionMeta[],
  sessionId: string | undefined | null,
): ComposerContextChipsProps | undefined {
  if (sessionId === undefined || sessionId === null) return undefined;
  const cwd = sessions.find((s) => s.id === sessionId)?.cwd;
  // branch 恒 undefined：web 无 gitBranch 通道 → 分支 chip 不出（不显示假分支名）。
  return buildContextChips(cwd, undefined);
}
