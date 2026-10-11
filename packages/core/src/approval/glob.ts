// A16 权限规则 DSL 的 glob 匹配（自写小函数，不引 minimatch/picomatch——仓库无此依赖）。
// 语义（唯一表述，schema 注释与测试与此对齐）：
//   - `*` 匹配任意字符序列（**含空串与换行**——bash 命令可多行）；
//   - `?` 匹配任意单个字符（含换行）；
//   - 其余字符按字面匹配（正则元字符转义，`git log --oneline (v1)` 之类原样可配）；
//   - 全串锚定（partial match 不算命中，fail-closed）。
// 消费方：approval/policy.ts 的规则键匹配（工具名模式与两段式主体模式）。
/** 已编译模式的缓存（模式来自 config，数量有限；键 = 原样模式串） */
const cache = new Map<string, RegExp>();

/** 规则键中的通配字符（用于「精确键 vs 通配键」判别与字面字符计数） */
export function hasGlobChars(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

/** 模式中的字面字符数（`*`/`?` 不计）——A16 特异性排序的度量 */
export function literalChars(pattern: string): number {
  let n = 0;
  for (const ch of pattern) {
    if (ch !== '*' && ch !== '?') n += 1;
  }
  return n;
}

function compile(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached !== undefined) return cached;
  let source = '';
  for (const ch of pattern) {
    if (ch === '*') source += '[\\s\\S]*';
    else if (ch === '?') source += '[\\s\\S]';
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const re = new RegExp(`^${source}$`, 's');
  cache.set(pattern, re);
  return re;
}

/** glob 全串匹配（`*` 通配任意序列含空串/换行，`?` 单字符；未命中 false） */
export function matchGlob(pattern: string, value: string): boolean {
  return compile(pattern).test(value);
}
