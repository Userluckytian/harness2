// vitest 独立于 vite.config（避免继承其 renderer root）。
// 默认 node 环境；React 组件测试用文件级 // @vitest-environment jsdom。
// NODE_ENV=test 强制 React/react-dom 加载 development 构建（CJS act 存在），
// 修复 @testing-library/react 16.3 调用 React.act 的 TypeError。
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Z3-04：ui-shared 的 components/ui/*（shadcn 原语）内部用 `@/lib/utils`；renderer 组件
// （composer-controls）经 ui-shared 进入这些原语 → 测试侧与 vite 构建侧（vite.config.mts
// 已有同名 alias）保持一致，指向该包 src。
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../ui-shared/src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // 真渲染 App 的装配级用例（如 test/app.test.tsx「会话列表与切换重放」）单例 ~2s，
    // 但六包并行满载时多次偶发越过 5s 默认线（Z3-04/Z3-07 验收各一次，见 issue-log §18/§19）；
    // 放宽到 15s 消除负载抖动，用例本身不断言时间。
    testTimeout: 15_000,
    env: {
      NODE_ENV: 'test',
    },
  },
});
