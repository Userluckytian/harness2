// ZS1 桩 host bundle 构建：把 src/host-entry.ts 连同 @zcode/rpc / @zcode/services /
// @zcode/shared 依赖闭包打包为单文件 CJS（utilityProcess.fork 可加载）。
// 依赖解析指向 ZS1 scratch 构建区（Apache-2.0；产物为 ZCode 代码的衍生作品，
// 合规声明见包内 LICENSE-ZCODE.md 与产物 banner）。
// 用法：node build/host-bundle.mjs [--out <path>] [--zcode-root <path>]
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const zcodeRoot = argValue("--zcode-root", "D:/AI_Projects/harness2-zs1-build/ZCode");
const outPath = argValue("--out", resolve(packageRoot, "dist/host-entry.cjs"));

mkdirSync(dirname(outPath), { recursive: true });

const result = await build({
  entryPoints: [resolve(packageRoot, "src/host-entry.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: outPath,
  // 模块解析：@zcode/* 精确匹配走包内 tsconfig paths（指向 scratch 源）；
  // 子路径依赖（@zcode/shared/zcode-protocol-v4 等）不经 paths，由 scratch 源内
  // 的包级 node_modules workspace 链接 + package.json exports 自然解析。
  tsconfig: resolve(packageRoot, "tsconfig.json"),
  // node 内建由 platform 处理；zod 等 npm 依赖一并打包（运行期不依赖 scratch node_modules）
  external: [],
  minify: false,
  sourcemap: false,
  logLevel: "info",
  banner: {
    js: [
      "/*!",
      " * ZS1 stub host bundle — derived from ZCode v3.16.2 (commit 3c5b2276).",
      " * Original code licensed under Apache-2.0 (see LICENSE-ZCODE.md in this package).",
      " * Bundled modules: @zcode/rpc, @zcode/services, @zcode/shared.",
      " */",
    ].join("\n"),
  },
});

if (result.errors.length > 0) {
  process.exit(1);
}
console.log(`[host-bundle] wrote ${outPath} (zcode root: ${zcodeRoot})`);
