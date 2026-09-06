// vitest 配置（独立于 vite.config：避免继承其 renderer root）。
// 默认 node 环境；React 组件测试用文件级注释 // @vitest-environment jsdom。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
