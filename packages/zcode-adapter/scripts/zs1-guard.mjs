// ZS1 构建守卫：zcode-adapter 的类型/构建/测试依赖 ZCode scratch 构建区（路线 B，见计划执行记录）。
// CI 与其他机器上没有 scratch → 整包静默跳过（exit 0），不红闸门；本机有 scratch → 执行原命令。
// 跳过口径如实打印；长期 vendored 路线归 ZS6（届时删除本守卫）。
// 路径可用 ZS1_ZCODE_ROOT 环境变量覆盖（与 vitest.config 同源）。
// 子命令一律以 node + 解析到的 JS 入口执行（本机 cmd.exe 缺失，.bin shim 不可依赖）。
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

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
  const ok = ['build', 'buildBundle', 'smokeBundle'].every((a) => run(a));
  process.exit(ok ? 0 : 1);
}
process.exit(run(action) ? 0 : 1);

function run(a) {
  if (a === 'smokeBundle') return smokeBundle();
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

// 冒烟：require 产物必须活到 host-entry 自己的运行门（非 Electron 下预期报
// 「must run inside Electron utilityProcess」）。若炸在加载期（MODULE_NOT_FOUND /
// SyntaxError / is not valid JSON）= 打包把不该内联的依赖闭包卷进来了——
// ZS4-T5 实证：静态 import '@harness2/core' 令 jsonc-parser 的运行时相对 require 断裂，
// typecheck/vitest 全绿但宿主启动即崩。core 一律走 core-bridge 的 createRequire 动态加载。
function smokeBundle() {
  const { fileURLToPath } = require('node:url');
  const outPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'host-entry.cjs');
  if (!existsSync(outPath)) {
    console.error('[smokeBundle] dist/host-entry.cjs 不存在');
    return false;
  }
  const probe = `try{require(${JSON.stringify(outPath)})}catch(e){console.log('SMOKE_ERR:'+(e&&e.message||''))}`;
  const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 30_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const loadFail =
    /MODULE_NOT_FOUND|Cannot find module|SyntaxError|is not valid JSON/.test(out) &&
    !/must run inside Electron/.test(out);
  if (loadFail) {
    console.error('[smokeBundle] host bundle 加载期崩溃（打包依赖闭包断裂）:');
    console.error(out.split('\n').slice(0, 6).join('\n'));
    return false;
  }
  console.log('[smokeBundle] host bundle 加载冒烟 OK（预期停在 Electron 运行门）');
  return true;
}
