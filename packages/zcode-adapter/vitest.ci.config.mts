// CI 专用 vitest 配置（F8 假绿治理，2026-10-31）：只跑无 scratch 依赖的用例子集。
//
// 取证（2026-10-31）：test/ 下 20 个测试文件中 16 个的直接或传递 import 闭包含 @zcode/*
// （vitest.config.mts 的 alias 指向 ZS1 scratch 构建区，GitHub runner 必无），不可在 CI 跑；
// 以下 4 个文件的闭包只含 node:* 与本包 src——host-crash 经 core-bridge 的 createRequire
// 动态加载 @harness2/core dist（Node 按包解析走 workspace node_modules，不经 vitest alias，
// 也不含机器特定路径），pnpm build 后即可用。实测：ZS1_ZCODE_ROOT 指向不存在路径
// （模拟无 scratch runner）4 文件 23 用例全绿。
//
// 维护约定：新增无 scratch 依赖的测试文件时把文件名加进 include；新增含 @zcode/* 依赖的
// 文件不要加（在 CI 必红）。其余 16 文件仍须本地 scratch 环境跑全门（pnpm --filter
// @harness2/zcode-adapter test，结论以本地为准）。
import { readdirSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const include = [
  'test/attachment-store.test.ts',
  'test/boot-timing.test.ts',
  'test/host-crash.test.ts',
  'test/task-index.test.ts',
];

// 如实输出排除口径：被排除文件数与清单（新增测试文件后自动更新，不靠人改 CI 注释）
const allTests = readdirSync(new URL('./test', import.meta.url))
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => `test/${f}`);
const excluded = allTests.filter((f) => !include.includes(f));
console.log(
  `[vitest.ci] ${excluded.length} 个 scratch 依赖测试文件已排除，须本地 scratch 环境跑全门：` +
    `${excluded.join(', ')}`,
);

export default defineConfig({
  test: {
    include,
    testTimeout: 30000,
  },
});
