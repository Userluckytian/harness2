// vitest 独立于 vite.config（避免继承其 renderer root）。
// 默认 node 环境；React 组件测试用文件级 // @vitest-environment jsdom。
// NODE_ENV=test 强制 React/react-dom 加载 development 构建（CJS act 存在），
// 修复 @testing-library/react 16.3 调用 React.act 的 TypeError。
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
