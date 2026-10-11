// vitest：本包测试直接跑 src（无需先 build）。
// 默认 node 环境；React 组件测试用文件级 `// @vitest-environment jsdom`。
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// components/ui/* 内部沿用 shadcn 的 `@/lib/utils` 约定（vite 构建侧三壳均已配同名 alias）。
// Z3-04 起渲染端组件（composer-controls）开始消费 components/ui 原语 → 测试侧也需要同一
// alias 才能解析（此前 ConversationStatusPanel 因此手写菜单；现统一补齐 alias）。
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    env: {
      NODE_ENV: 'test',
    },
  },
});
