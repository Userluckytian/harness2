// vitest：默认 node 环境（客户端/协议测试）；React 组件测试用文件级 `// @vitest-environment jsdom`。
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Z3-04：ui-shared 的 components/ui/*（shadcn 原语）内部用 `@/lib/utils`；web 壳经
// ConversationSeat 间接进入这些原语 → 测试侧与 vite 构建侧（vite.config.mts 已有同名 alias）
// 保持一致，指向该包 src。
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../ui-shared/src', import.meta.url)),
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
