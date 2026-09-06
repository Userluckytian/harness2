// 渲染端构建（React + Vite）：src/renderer → dist/renderer（Electron loadFile 加载）。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(pkgRoot, 'src/renderer'),
  plugins: [react()],
  build: {
    outDir: resolve(pkgRoot, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
  },
});
