// 渲染端构建（React + Vite）：src/renderer → dist/renderer（Electron loadFile 加载）。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(pkgRoot, 'src/renderer'),
  plugins: [react()],
  // 用相对路径：Electron 经 file:// 加载 index.html，绝对路径 /assets/... 会拼成 file:///assets/...
  // 导致 js/css 全打不开而白屏（2026-09-07 桌面白屏根因；冒烟只看 did-finish-load 与 preload，查不到）
  base: './',
  build: {
    outDir: resolve(pkgRoot, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
  },
});
