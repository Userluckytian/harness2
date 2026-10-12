// web 壳构建：React + Vite（index.html → dist/）。
//
// 接入方式（serve HTTP/WS）：浏览器与 serve 之间**不跨源**——dev 用代理把 /api 与 /ws
// 转发到本地 serve（serve 的信任域只放行 localhost/127.0.0.1，且不返回 CORS 头），
// 因此 `VITE_HARNESS2_ORIGIN` 缺省留空 = 同源。
//   * `VITE_HARNESS2_PROXY`：dev 代理目标（缺省 http://127.0.0.1:46213 = core DEFAULT_SERVE_PORT）
//   * `HARNESS2_DEV_TOKEN`：serve token，由 **vite 代理在服务端注入** `x-harness2-token` 头
//     （HTTP 走 proxyReq、WS 升级走 proxyReqWs 钩子），**不进浏览器、不进 URL**——
//     用户打开页面无需任何 token 参数；serve 端鉴权强度不降级（token 校验照常）。
//   * `VITE_HARNESS2_TOKEN`：浏览器侧注入通道（?token= 查询参数为其回退），仅部署侧
//     无法走代理时用；dev 流程不再需要。
//   * `VITE_HARNESS2_ORIGIN`：直连 serve 时的绝对源（仅当部署侧已解决同源/代理时使用）
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProxyOptions } from 'vite';

const pkgRoot = dirname(fileURLToPath(import.meta.url));
const proxyTarget = process.env.VITE_HARNESS2_PROXY ?? 'http://127.0.0.1:46213';
const devToken = process.env.HARNESS2_DEV_TOKEN ?? '';

/**
 * 代理 configure 钩子：转发前在**服务端**给上游请求注入 x-harness2-token。
 * http-proxy 事件名：HTTP=proxyReq、WS 升级=proxyReqWs；两者对象都有 setHeader。
 * 无 token 环境变量 = 不注入（serve 严格模式下会 401，如实暴露配置缺失，不静默绕过）。
 */
// 事件名按字面量分支：`proxy.on` 的泛型在联合键上会退化成两签名交集而拒收监听器；
// 分支后每个 on 都是单字面量，首参均为 http.ClientRequest（有 setHeader）。
function injectServeToken(on: 'proxyReq' | 'proxyReqWs'): ProxyOptions['configure'] {
  return (proxy) => {
    if (devToken.length === 0) return;
    const setToken = (proxyReq: { setHeader: (name: string, value: string) => void }): void => {
      proxyReq.setHeader('x-harness2-token', devToken);
    };
    if (on === 'proxyReq') proxy.on('proxyReq', setToken);
    else proxy.on('proxyReqWs', setToken);
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // ui-shared 组件内部的 `@/` 引用（shadcn 约定）指向该包 src
      '@': resolve(pkgRoot, '../ui-shared/src'),
    },
  },
  server: {
    proxy: {
      // changeOrigin: true —— serve 的信任域校验要求 Host 为 127.0.0.1:<serve 端口>
      '/api': { target: proxyTarget, changeOrigin: true, configure: injectServeToken('proxyReq') },
      '/ws': { target: proxyTarget, ws: true, changeOrigin: true, configure: injectServeToken('proxyReqWs') },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
