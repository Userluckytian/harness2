// 目录/文件忽略规则的单一事实源（glob / grep / 代码索引共用同一套语义）。
//
// 语义（与既有 glob.ts、grep.ts 完全一致，A22 抽取共享，行为零变化）：
//   - node_modules / .git 无条件排除（含整棵子树），与 .gitignore 是否覆盖无关；
//   - 隐藏项（点开头）在**目录遍历**场景默认不进入——同时覆盖 .env* 等敏感文件与
//     .harness2 自有数据目录（点开头），避免把索引/会话等派生物再索引一遍；
//   - 显式传入单个文件路径时照常处理（对齐 rg 对显式路径的语义，调用侧决定）。
//
// glob 工具基于 fast-glob：其 ignore 只吃模式，故这里同时提供 EXCLUDED_GLOBS；
// grep 的 JS 回退按目录项名过滤，用 isSkippedEntryName。二者共享 SKIP_DIRS。
// 已知边界（如实声明）：本套语义不解析 .gitignore（rg 后端会，JS 回退不会）；
// 代码索引复用本语义，因此同样不解析 .gitignore。

/** 无条件排除的目录名（含整棵子树） */
export const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git']);

/** fast-glob 忽略模式：node_modules/.git 目录本身与其子树（glob 工具既有取值） */
export const EXCLUDED_GLOBS: readonly string[] = ['**/node_modules', '**/node_modules/**', '**/.git', '**/.git/**'];

/**
 * 目录遍历时是否跳过该目录项：隐藏（点开头，覆盖 .env* 与 .harness2）或
 * node_modules/.git。仅用于遍历；显式路径不经此过滤。
 */
export function isSkippedEntryName(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.has(name);
}
