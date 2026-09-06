// harness2 会话性能基线复跑脚本（阶段 11 Task 1，消化审查 P2-4 大日志留档）。
// 用法：pnpm build（先产出 core dist）→ pnpm bench
//   可选环境变量：H2_BENCH_EVENTS（事件数，默认 100000）、H2_BENCH_SEED（种子，默认 20260907）
// 输出表格直接粘进 architecture.md「性能预算」节（含环境行）。
import { runSessionBench, formatBenchTable } from '../packages/core/dist/session/bench.js';

const events = Number(process.env['H2_BENCH_EVENTS'] ?? 100_000);
const seed = Number(process.env['H2_BENCH_SEED'] ?? 20260907);
if (!Number.isInteger(events) || events < 1) {
  console.error(`error: H2_BENCH_EVENTS 必须是 >= 1 的整数，实际为 ${process.env['H2_BENCH_EVENTS']}`);
  process.exit(1);
}
const result = runSessionBench({ events, seed });
console.log(formatBenchTable(result));
