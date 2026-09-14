// vitest：本包测试直接跑 src（无需先 build）。
// 默认 node 环境；React 组件测试用文件级 `// @vitest-environment jsdom`。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    env: {
      NODE_ENV: 'test',
    },
  },
});
