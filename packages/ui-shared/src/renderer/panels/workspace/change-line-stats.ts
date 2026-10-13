// 变更审查面板的「每文件 +N/−M」行级增删统计（Z10-6c 交付 1）——纯函数，壳无关。
//
// 算法与依赖取舍（报告须说明）：**复用既有 `diff` 依赖**（`diffLines`），不手写 LCS/Myers。
//   理由：① `diff` 已是本包直接依赖（package.json `"diff": "^9.0.0"`），非新增；
//         ② 本面板已用 `buildDiffRows`（components/DiffCard）经同一 `diffLines` 渲染红绿 diff 行，
//            统计与渲染同源可保证「+N/−M」与下方逐行 diff 完全一致（自写算法易与渲染口径漂移）；
//         ③ 与 `conversation/status-panel/status-panel-model.ts` 的 `countDiffLines` 同口径
//            （那是状态面板 Git 子块的既有实现，位于本次禁止改动的 `renderer/conversation/**`，
//             无法合流；此处为面板自有的一份等价实现，逻辑逐行一致）。
//
// null 语义（如实、不猜）：
//   - `before === null` = 新增文件 → 全增（after 全部计入 added）；
//   - `after  === null` = 删除文件 → 全删（before 全部计入 deleted）；
//   - 两边都 null      = 无内容可比 → 返回 **null**，调用方据此**不显示计数**（不显示 +0 −0 冒充）。
// 末尾空行按 DiffCard 同口径丢弃（`split('\n')` 末位空串弹出），不产生多余计数。
import { diffLines } from 'diff';

export interface ChangeLineStats {
  /** 拟议新增行数 */
  added: number;
  /** 拟议删除行数 */
  deleted: number;
}

/**
 * 由拟议 before→after 文本算行级增删。
 * @param before 快照记录的拟议起点（null = 文件此前不存在）
 * @param after 快照记录的拟议落点（null = 文件被删除）
 * @returns 行级增删计数；**两边都 null → null**（无内容可比，不猜）。
 */
export function changeLineStats(before: string | null, after: string | null): ChangeLineStats | null {
  if (before === null && after === null) return null;
  let added = 0;
  let deleted = 0;
  for (const ch of diffLines(before ?? '', after ?? '')) {
    const lines = ch.value.split('\n');
    // 末尾空串（change 末值）丢弃 —— 与 DiffCard.buildDiffRows 同口径
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (ch.added) added += lines.length;
    else if (ch.removed) deleted += lines.length;
  }
  return { added, deleted };
}
