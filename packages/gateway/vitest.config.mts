// gateway 用例大量涉及真实 ws 服务器 / 平台网关生命周期（gateway-ws、lifecycle、
// serve-client 重连竞态等），vitest 默认 5s 在 CI 高负载下会假红
// （R10 口径：packages/core 实测 ubuntu/macos 一批 `Test timed out in 5000ms`）。
// 统一抬到 30s：与 packages/core / packages/cli 的口径一致。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
