// vitest 解析 @zcode/* 指向 ZS1 scratch 构建区（与 tsconfig paths 同源）。
// 注意：alias 必须用正则「精确匹配」——字符串 alias 是前缀匹配，会把
// @zcode/shared/model-config 等子路径改写成不存在的路径；子路径依赖
// （provider→shared/*、services→provider 等）经 scratch 包级 node_modules
// 的 workspace 链接自然解析。
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const zcodeRoot = process.env.ZS1_ZCODE_ROOT ?? 'D:/AI_Projects/harness2-zs1-build/ZCode';

export default defineConfig({
  resolve: {
    alias: [
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
