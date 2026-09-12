// bench.mjs — 方案A（Ink 基线）基准编排器：逐阶段 spawn 子进程 worker，隔离故障与内存。
// 运行：node bench.mjs [--skip-10k]
//   --skip-10k 跳过非虚拟化 10k 行（已知极慢，单独跑：node worker.mjs init-10k）
// 输出：各阶段 JSON 结果 + 汇总表。全部数字为本机实测，命令与原始输出记入 results.md。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const skip10k = process.argv.includes('--skip-10k');

const phases = [
  ['冷启动（子进程 spawn→import→首帧）', 'cold', 120_000],
  ['非虚拟化 10k 行初始渲染', 'init-10k', 300_000],
  ['虚拟化窗口初始渲染（viewport±10 缓冲）', 'init-vp', 120_000],
  ['虚拟化滚动 2000 步（每步 3 行）', 'scroll', 300_000],
  ['输入回显延迟 120 样本', 'echo', 120_000],
];

const results = [];
for (const [label, mode, timeout] of phases) {
  if (skip10k && mode === 'init-10k') {
    results.push({ mode, skipped: true });
    continue;
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, 'worker.mjs'), mode], {
    cwd: here,
    encoding: 'utf8',
    timeout,
  });
  const wall = Date.now() - t0;
  const outText = (r.stdout ?? '') + (r.stderr ?? '');
  const m = outText.match(/RESULT_JSON=(\{.*\})/);
  if (m) {
    const data = JSON.parse(m[1]);
    results.push({ mode, label, wallSpawnMs: wall, ...data });
    console.log(`[ok] ${label}: ${m[1]}`);
  } else {
    results.push({ mode, label, error: `no RESULT_JSON (exit=${r.status}, signal=${r.signal}, wall=${wall}ms)`, raw: outText.slice(-2000) });
    console.error(`[fail] ${label}: exit=${r.status} signal=${r.signal} wall=${wall}ms`);
    console.error(outText.slice(-2000));
  }
}

console.log('\n=== 汇总 ===');
for (const r of results) {
  if (r.skipped) { console.log(`${r.mode}: SKIPPED`); continue; }
  if (r.error) { console.log(`${r.mode}: ERROR`); continue; }
  console.log(JSON.stringify(r));
}
console.log('\n原始 JSON 已逐行打印于上方；汇总亦写入 stdout，可重定向留档。');
