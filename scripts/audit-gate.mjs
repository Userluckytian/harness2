// 生产依赖漏洞门禁（F11，2026-10-31）：解析 `pnpm audit --prod --json` 输出，按级别决定退出码。
//
// 门禁策略（选定理由）：
// - 不用裸 `pnpm audit --prod` 退出码做门：它对任意级别（含 low/moderate）都 exit 1，
//   单条低危传递依赖就会长期挡住合流。本脚本只对 critical/high 红灯（任务硬线），
//   moderate/low 打印清单但放行——当前生产依赖 0 漏洞，门为绿（2026-10-31 实测）。
// - dev 依赖漏洞只输出报告不挡门：存量 19 条（high 7 / moderate 11 / low 1）全在
//   vitest 工具链（undici/vite/brace-expansion/@vitest/mocker），挡门会让 CI 永红；
//   待工具链升级自然消退，届时本报告清零。
//
// 为什么显式 `--registry=https://registry.npmjs.org`：默认 registry 可能是 npmmirror，
// 其无 audit 端点（ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS），审计必须打 npmjs 官方端点。
//
// 为什么不需要 pnpm install：pnpm audit 只读 pnpm-lock.yaml 查询审计端点，与
// node_modules 无关（临时目录仅放 package.json + lockfile 实测可跑）。
//
// 失败语义：pnpm 审计命令跑失败 / 输出不可解析（网络或端点故障）→ fail closed exit 1
// ——安全门宁可误红（重跑即可），不静默放行。全量（dev 报告）跑失败只警告，不挡门。
//
// 测试钩子：`node scripts/audit-gate.mjs --from-file <audit.json>` 跳过 pnpm 直接读
// 审计 JSON 文件当 --prod 结果用，用于本地验证红灯路径（如喂入全量 --json 输出）。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REGISTRY = 'https://registry.npmjs.org';
const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low'];
const BLOCKING = new Set(['critical', 'high']);

/** 把 advisories map 汇总成每级别计数与涉事模块清单 */
function summarize(advisories) {
  const counts = {};
  const modules = {};
  for (const a of Object.values(advisories ?? {})) {
    counts[a.severity] = (counts[a.severity] ?? 0) + 1;
    (modules[a.severity] ??= new Set()).add(a.module_name);
  }
  return { counts, modules };
}

function formatCounts(counts) {
  return SEVERITY_ORDER.map((s) => `${s}=${counts[s] ?? 0}`).join(' ');
}

/**
 * 跑一次 pnpm audit --json 并解析。pnpm 约定：发现漏洞 exit 1、干净 exit 0，
 * 两种都算「跑成功」；其余 status / spawn 错误 / 不可解析输出按 fatal 决定是否 exit 1。
 */
function runAudit(args, label, fatal) {
  const r = spawnSync('pnpm', args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  const ranFine = !r.error && (r.status === 0 || r.status === 1);
  if (!ranFine) {
    const detail = r.error?.message ?? r.stderr ?? r.stdout ?? '';
    console.error(`[audit-gate] pnpm audit（${label}）运行失败 status=${r.status}：${String(detail).slice(0, 400)}`);
    if (fatal) process.exit(1);
    return null;
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    console.error(`[audit-gate] pnpm audit（${label}）输出不可解析，fail closed。stdout 前 400 字：`);
    console.error((r.stdout ?? '').slice(0, 400));
    if (fatal) process.exit(1);
    return null;
  }
}

function printSummary(label, summary) {
  console.log(`[audit-gate] ${label}: ${formatCounts(summary.counts)}`);
  for (const s of SEVERITY_ORDER) {
    const mods = summary.modules[s];
    if (mods?.size) console.log(`[audit-gate]   ${s}: ${[...mods].join(', ')}`);
  }
}

const fromFileIdx = process.argv.indexOf('--from-file');
let prodJson;
if (fromFileIdx > -1) {
  const file = process.argv[fromFileIdx + 1];
  if (!file) {
    console.error('[audit-gate] --from-file 需要跟一个 JSON 文件路径');
    process.exit(1);
  }
  try {
    prodJson = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[audit-gate] 读取 ${file} 失败：${e.message}`);
    process.exit(1);
  }
} else {
  prodJson = runAudit(['audit', '--prod', '--json', `--registry=${REGISTRY}`], '生产依赖', true);
}

const prodSummary = summarize(prodJson.advisories);
printSummary('生产依赖审计（--prod）', prodSummary);

// dev 报告：独立跑全量审计（含 dev），任何失败只警告不挡门（--from-file 测试模式跳过）
if (fromFileIdx === -1) {
  const full = runAudit(['audit', '--json', `--registry=${REGISTRY}`], '全量', false);
  if (full) {
    printSummary('全量审计报告（含 dev，不挡门）', summarize(full.advisories));
  } else {
    console.log('[audit-gate] 全量审计本轮不可用（网络/端点故障），dev 漏洞报告缺失——不挡门');
  }
}

const blocking = SEVERITY_ORDER.filter((s) => BLOCKING.has(s) && (prodSummary.counts[s] ?? 0) > 0);
if (blocking.length > 0) {
  console.error(`[audit-gate] 门禁不通过：生产依赖存在 ${blocking.join('/')} 级漏洞（清单见上）`);
  process.exit(1);
}
console.log('[audit-gate] 门禁通过：生产依赖无 critical/high 漏洞');
process.exit(0);
