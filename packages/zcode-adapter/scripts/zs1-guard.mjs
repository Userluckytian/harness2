// ZS1 构建守卫：zcode-adapter 的类型/构建/测试依赖 ZCode scratch 构建区（路线 B，见计划执行记录）。
// CI 与其他机器上没有 scratch → 整包静默跳过（exit 0），不红闸门；本机有 scratch → 执行原命令。
// 跳过口径如实打印；长期 vendored 路线归 ZS6（届时删除本守卫）。
// 路径可用 ZS1_ZCODE_ROOT 环境变量覆盖（与 vitest.config 同源）。
// 子命令一律以 node + 解析到的 JS 入口执行（本机 cmd.exe 缺失，.bin shim 不可依赖）。
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const DEFAULT_ROOT = 'D:/AI_Projects/harness2-zs1-build/ZCode';
const root = process.env.ZS1_ZCODE_ROOT?.trim() || DEFAULT_ROOT;
const marker = `${root}/packages/services/src/index.ts`;

if (!existsSync(marker)) {
  console.log(
    `[zs1-guard] SKIP @harness2/zcode-adapter: ZCode scratch not found (${root}). ` +
      'Route B by design (ZS1 plan); CI-safe skip, vendored route = ZS6.',
  );
  process.exit(0);
}

function entryOf(pkg, rel) {
  try {
    return join(dirname(require.resolve(`${pkg}/package.json`)), rel);
  } catch {
    return null;
  }
}

const TSC = entryOf('typescript', 'bin/tsc');
const VITEST = entryOf('vitest', 'vitest.mjs');

const cmds = {
  build: TSC ? [TSC, ['-p', 'tsconfig.json', '--noEmit']] : null,
  buildBundle: ['build/host-bundle.mjs', []],
  typecheck: TSC ? [TSC, ['-p', 'tsconfig.json', '--noEmit']] : null,
  test: VITEST ? [VITEST, ['run']] : null,
};

const action = process.argv[2];
if (action === 'buildAll') {
  const ok = ['build', 'buildBundle'].every((a) => run(a));
  process.exit(ok ? 0 : 1);
}
process.exit(run(action) ? 0 : 1);

function run(a) {
  const cmd = cmds[a];
  if (!cmd) {
    console.error(`[zs1-guard] unknown action or entry unresolved: ${a}`);
    return false;
  }
  const [entry, args] = cmd;
  // spawnSync 的 args 必须是扁平字符串数组：嵌套数组会被 String() 成逗号串（tsc 报 Unknown compiler option 实证）
  const r = spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit' });
  return (r.status ?? 1) === 0;
}
