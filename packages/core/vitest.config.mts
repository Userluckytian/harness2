// core 用例大量涉及 spawn 子进程 / 文件系统 / serve 端到端（fork、server、ws、
// tool-failure-circuit、nudge 等），vitest 默认 5s 在 POSIX（尤其 CI 高负载）下会假红
// （R10：ubuntu/macos job 实测一批 `Test timed out in 5000ms`，隔离复跑单文件耗时 8–13s）。
// 统一抬到 30s：与 packages/cli / packages/desktop 的口径一致。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
