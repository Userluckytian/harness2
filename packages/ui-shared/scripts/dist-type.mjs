// 双产物类型标记：Node/TS 按「最近的 package.json type」判定 .js 模块格式。
// dist 在 .gitignore 内（生成物不入库），故每次构建落这两个标记文件。
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const [dir, type] of [
  ['dist/esm', 'module'],
  ['dist/cjs', 'commonjs'],
]) {
  const target = resolve(root, dir);
  mkdirSync(target, { recursive: true });
  writeFileSync(resolve(target, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`, 'utf8');
}

// CSS：tsc 不搬非 TS 文件，这里把 src/**/*.css 复制到 dist/{esm,cjs} 的同名相对路径
// （两条件共用同一份）。范围：src/styles（壳样式表）+ src/renderer/**（组件级样式，如
// renderer/trajectory/trajectory.css —— 由 trajectory-panel.tsx 相对导入，构建后需就位）。
const cssRoot = resolve(root, 'src');
const collectCss = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectCss(abs));
    else if (entry.name.endsWith('.css')) out.push(abs);
  }
  return out;
};
for (const dir of ['dist/esm', 'dist/cjs']) {
  for (const abs of collectCss(cssRoot)) {
    const rel = abs.slice(cssRoot.length + 1);
    const target = resolve(root, dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(abs, target);
  }
}
