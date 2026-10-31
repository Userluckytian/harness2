// vitest 解析 @zcode/* 指向 ZS1 scratch 构建区（与 tsconfig paths 同源）。
// 注意：alias 必须用正则「精确匹配」——字符串 alias 是前缀匹配，会把
// @zcode/shared/model-config 等子路径改写成不存在的路径；全部 @zcode/*
// 导入符必须在本文件或 tsconfig paths 逐条精确映射——scratch 包级
// node_modules 并不存在对应链接（2026-10-31 取证：仅有 zcode-cua 一条），
// 新增导入须同步补 alias，否则运行时即断。
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const zcodeRoot = process.env.ZS1_ZCODE_ROOT ?? 'D:/AI_Projects/harness2-zs1-build/ZCode';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@harness2\/core$/,
        replacement: 'D:/AI_Projects/harness2/packages/core/src/index.ts',
      },
      {
        find: /^@zcode\/services$/,
        replacement: resolve(zcodeRoot, 'packages/services/src/index.ts'),
      },
      {
        find: /^@zcode\/rpc$/,
        replacement: resolve(zcodeRoot, 'packages/rpc/src/index.ts'),
      },
      {
        find: /^@zcode\/shared\/zcode-protocol-v4$/,
        replacement: resolve(zcodeRoot, 'packages/shared/src/zcode-protocol-v4/index.ts'),
      },
      {
        find: /^@zcode\/shared$/,
        replacement: resolve(zcodeRoot, 'packages/shared/src/index.ts'),
      },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
  },
});
