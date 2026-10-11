// 品牌行构建标签（依据 refs-deepseek-harness.md D-25）：
//   徐标文案 = `version[-commit][-dirty]`，来源 `DSH_CLIENT_VERSION` /
//   `DSH_CLIENT_COMMIT_HASH`（7 位）/ `DSH_CLIENT_GIT_DIRTY=true`；
//   缺少版本元数据时**不显示徐标**（不摆「unknown」之类占位）。
// 纯函数：装配层负责把构建期环境（vite define / import.meta.env 等）折算成入参。

/** 构建标签输入（三键皆可缺；缺 version 即整体不显示） */
export interface BuildVersionInput {
  version?: string | undefined;
  commit?: string | undefined;
  dirty?: boolean | undefined;
}

/** 构建元数据来源的环境变量名（与上游同名，便于打包脚本直接对齐） */
export const BUILD_VERSION_ENV_KEYS = {
  version: 'DSH_CLIENT_VERSION',
  commit: 'DSH_CLIENT_COMMIT_HASH',
  dirty: 'DSH_CLIENT_GIT_DIRTY',
} as const;

/** 提交号展示位数（D-25：commit 取 7 位） */
export const COMMIT_SHORT_LENGTH = 7;

/** 去空白后非空才算给值（空串/纯空白等同缺省） */
function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 组装构建标签。规则：
 *   - version 缺失（或空白）→ undefined（无徐标）；
 *   - commit 取前 7 位（不足 7 位原样），缺失则省去该段；
 *   - dirty 仅在显式 true 时追加 `-dirty`。
 * @param input - 构建元数据（version/commit/dirty）。
 * @returns 标签文案；无版本时为 undefined。
 */
export function formatBuildVersion(input: BuildVersionInput): string | undefined {
  const version = clean(input.version);
  if (version === undefined) return undefined;
  const commit = clean(input.commit);
  const shortCommit = commit === undefined ? undefined : commit.slice(0, COMMIT_SHORT_LENGTH);
  return version + (shortCommit === undefined ? '' : `-${shortCommit}`) + (input.dirty === true ? '-dirty' : '');
}

/**
 * 从环境变量表（键为 DSH_CLIENT_* 名）解析构建标签；`DSH_CLIENT_GIT_DIRTY`
 * 只有字面 `'true'` 才算脏（其他值含 `'1'`/`'TRUE'` 一律不标，避免误标）。
 */
export function resolveBuildVersion(env: Record<string, string | undefined>): string | undefined {
  return formatBuildVersion({
    version: env[BUILD_VERSION_ENV_KEYS.version],
    commit: env[BUILD_VERSION_ENV_KEYS.commit],
    dirty: env[BUILD_VERSION_ENV_KEYS.dirty] === 'true',
  });
}
