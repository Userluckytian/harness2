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

// CSS：tsc 不搬非 TS 文件，这里把 src/styles/*.css 复制到 dist/{esm,cjs}/styles（两条件共用同一份）。
const stylesDir = resolve(root, 'src/styles');
for (const dir of ['dist/esm/styles', 'dist/cjs/styles']) {
  const target = resolve(root, dir);
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(stylesDir)) {
    copyFileSync(resolve(stylesDir, name), resolve(target, name));
  }
}
