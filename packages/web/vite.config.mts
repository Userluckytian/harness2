// web 壳构建：React + Vite（index.html → dist/）。
//
// 接入方式（serve HTTP/WS）：浏览器与 serve 之间**不跨源**——dev 用代理把 /api 与 /ws
// 转发到本地 serve（serve 的信任域只放行 localhost/127.0.0.1，且不返回 CORS 头），
// 因此 `VITE_HARNESS2_ORIGIN` 缺省留空 = 同源。
//   * `VITE_HARNESS2_PROXY`：dev 代理目标（缺省 http://127.0.0.1:46213 = core DEFAULT_SERVE_PORT）
//   * `VITE_HARNESS2_TOKEN`：serve 一次性 token（严格模式必需；也可用页面 URL 的 ?token=）
//   * `VITE_HARNESS2_ORIGIN`：直连 serve 时的绝对源（仅当部署侧已解决同源/代理时使用）
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const proxyTarget = process.env.VITE_HARNESS2_PROXY ?? 'http://127.0.0.1:46213';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // changeOrigin: true —— serve 的信任域校验要求 Host 为 127.0.0.1:<serve 端口>
      '/api': { target: proxyTarget, changeOrigin: true },
      '/ws': { target: proxyTarget, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
