// cli 集成用例大量 spawn 真实子进程（serve / export / memory / crash-drill），
// vitest 默认 5s 在高负载机器上会假红（阶段 15 终验实测 3–7 例抖动）。
// 统一抬到 30s：与既有 spawn 型用例显式写的 }, 30000) 口径一致。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
