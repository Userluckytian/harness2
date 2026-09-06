// harness2 doctor（阶段 11 Task 4）：环境自检分节报告（OK/WARN/FAIL + 明细）。
// 红线：输出出口全部过 redactSecrets（key 只显示来源标签，永不打印明文，与 config check 同源）；
// 各检查项独立 try/catch——单项失败收口为该项 FAIL，不拖垮整份报告（计划风险「doctor 误报」缓解）。
// exit 语义：无 FAIL → 0；有 FAIL → 1（WARN 不影响 exit code）。
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildConfigReport } from '../config/report.js';
import { defaultConfigPaths, loadConfig } from '../config/load.js';
import { readAuthFile } from '../config/auth.js';
import { redactSecrets } from '../config/redact.js';
import type { HarnessConfig } from '../config/schema.js';
import type { McpServerConfig } from '../config/schema.js';
import { McpManager } from '../mcp/client.js';
import { defaultSessionsRoot } from '../session/manager.js';
import { loadSession } from '../session/reader.js';
import { SESSION_LOG_FILE } from '../session/types.js';
import { defaultSkillsRoot, projectSkillsRoot, SkillStore } from '../skills/store.js';
import { ToolRegistry } from '../tools/registry.js';
import { CORE_VERSION } from '../version.js';

/** 单项检查结果 */
export interface DoctorCheck {
  id: string;
  status: 'ok' | 'warn' | 'fail';
  summary: string;
  details?: string[];
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** 0 = 无 FAIL；1 = 有 FAIL（WARN 不影响） */
  exitCode: 0 | 1;
}

export interface DoctorOptions {
  /** 项目根目录（项目级 config 与 .harness2/skills 扫描基点；缺省 process.cwd()） */
  root?: string;
  /** 用户数据根（默认用户 home；测试/多环境用） */
  home?: string;
  /** 实连 MCP 服务器探测（缺省仅列出配置） */
  probe?: boolean;
  /** MCP 探测超时 ms（缺省 5000） */
  probeTimeoutMs?: number;
}

/** node 主版本 ≥22（engines 契约） */
function checkNode(): DoctorCheck {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isInteger(major) && major >= 22) {
    return { id: 'node', status: 'ok', summary: `Node ${process.version}（≥22）` };
  }
  return { id: 'node', status: 'fail', summary: `Node ${process.version} 过旧——harness2 要求 ≥22` };
}

/**
 * config + auth（脱敏）：返回检查结果与已加载 config（MCP 检查复用）。
 * 全新环境（两个配置文件都不存在）= WARN；存在但解析失败 = FAIL；key 全缺 = WARN。
 */
function checkConfig(opts: DoctorOptions): { check: DoctorCheck; config: HarnessConfig | null } {
  const root = opts.root ?? process.cwd();
  const paths = defaultConfigPaths(root, opts.home);
  const loaded = loadConfig({
    root,
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    globalPath: paths.globalConfig,
    projectPath: paths.projectConfig,
  });
  const details: string[] = [
    `全局: ${paths.globalConfig}${loaded.sources.global ? '' : '（不存在）'} · 项目: ${paths.projectConfig}${loaded.sources.project ? '' : '（不存在）'}`,
  ];
  if (loaded.config === null) {
    const fresh = !loaded.sources.global && !loaded.sources.project;
    for (const err of loaded.errors) details.push(`error: ${err}`);
    const check: DoctorCheck = fresh
      ? {
          id: 'config',
          status: 'warn',
          summary: '未找到配置文件（全新环境——真实 provider 前先配置 config.json + auth.json，可用 harness2 config check 核对）',
          details,
        }
      : { id: 'config', status: 'fail', summary: 'config 加载失败', details };
    return { check, config: null };
  }
  // key 来源（buildConfigReport 唯一构造处，只有来源标签）
  const auth = readAuthFile(paths.globalAuth);
  if (auth.error !== undefined) details.push(`auth 警告: ${auth.error}`);
  const report = buildConfigReport(loaded.config, auth.auth);
  for (const p of report.providers) details.push(`${p.channel}: key 来源 ${p.keySource}`);
  const missing = report.providers.filter((p) => p.keySource === '**missing**').length;
  let check: DoctorCheck;
  if (auth.error !== undefined) {
    check = { id: 'config', status: 'warn', summary: 'config 可解析，但 auth.json 读取异常', details };
  } else if (report.providers.length > 0 && missing === report.providers.length) {
    check = { id: 'config', status: 'warn', summary: 'config 可解析，但全部 provider 缺少 API key', details };
  } else {
    check = {
      id: 'config',
      status: 'ok',
      summary: `config 可解析（providers ${report.providers.length} 个，key 只显示来源标签）`,
      details,
    };
  }
  return { check, config: loaded.config };
}

/** ~/.harness2 目录可写（探针文件写入 + 删除；探针即真实目录验证） */
function checkHomeWritable(opts: DoctorOptions): DoctorCheck {
  const home = opts.home ?? homedir();
  const root = join(home, '.harness2');
  try {
    mkdirSync(root, { recursive: true });
    const probePath = join(root, `.doctor-probe-${process.pid}`);
    writeFileSync(probePath, 'ok', 'utf8');
    unlinkSync(probePath);
    return { id: 'home', status: 'ok', summary: `用户数据根可写：${root}` };
  } catch (e) {
    return {
      id: 'home',
      status: 'fail',
      summary: `用户数据根不可写：${root}（${(e as Error)?.message ?? String(e)}）`,
    };
  }
}

function describeMcpServer(cfg: McpServerConfig): string {
  if ('command' in cfg) return `[stdio] ${cfg.command}${cfg.args?.length ? ` ${cfg.args.join(' ')}` : ''}`;
  return `[url] ${cfg.url}`;
}

/** MCP servers：缺省仅列出配置；probe 实连（单 server 独立超时，down = WARN 不 FAIL） */
async function checkMcp(config: HarnessConfig | null, opts: DoctorOptions): Promise<DoctorCheck> {
  const servers = config?.mcpServers ?? {};
  const names = Object.keys(servers);
  if (names.length === 0) {
    return { id: 'mcp', status: 'ok', summary: '未配置 MCP 服务器（config.mcpServers）' };
  }
  const details = names.map((n) => `${n}  ${describeMcpServer(servers[n]!)}`);
  if (opts.probe !== true) {
    return { id: 'mcp', status: 'ok', summary: `已配置 ${names.length} 个 MCP 服务器（--probe 实连探测）`, details };
  }
  const timeoutMs = opts.probeTimeoutMs ?? 5_000;
  let connected = 0;
  for (const name of names) {
    const cfg = servers[name]!;
    const tools = new ToolRegistry();
    const manager = new McpManager({ tools, maxRestarts: 0, timeoutMs, connectTimeoutMs: timeoutMs, logSink: () => {} });
    try {
      const report = await manager.connectAll({ [name]: cfg });
      const status = manager.status().find((s) => s.server === name);
      if (report.connected.includes(name)) {
        connected += 1;
        details.push(`${name}: 已连接，${status?.tools.length ?? 0} 个工具`);
      } else {
        details.push(`${name}: down（${report.failed[0]?.error ?? status?.lastError ?? '未知错误'}）`);
      }
    } catch (e) {
      details.push(`${name}: down（${(e as Error)?.message ?? String(e)}）`);
    } finally {
      await manager.close().catch(() => {});
    }
  }
  return {
    id: 'mcp',
    status: connected === 0 ? 'warn' : 'ok',
    summary: `MCP 探测（超时 ${timeoutMs}ms）：${connected}/${names.length} 已连接`,
    details,
  };
}

/**
 * 会话库完整性：逐会话 loadSession（坏行/告警统计 + 不可读计数）。
 * 全库遍历与 list/search 同口径（P2-4 留档）；坏行不中断（reader 容错语义）。
 */
function checkSessions(opts: DoctorOptions): DoctorCheck {
  const root = defaultSessionsRoot(opts.home);
  if (!existsSync(root)) {
    return { id: 'sessions', status: 'ok', summary: `会话库为空（${root} 不存在）` };
  }
  let total = 0;
  let withWarnings = 0;
  let unreadable = 0;
  const details: string[] = [];
  const pushDetail = (line: string): void => {
    if (details.length < 10) details.push(line);
  };
  for (const group of readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = join(root, group.name);
    let entries: Array<{ name: string; isDirectory(): boolean }> = [];
    try {
      entries = readdirSync(groupDir, { withFileTypes: true });
    } catch (e) {
      unreadable += 1;
      pushDetail(`组目录不可读 ${group.name}（${(e as Error)?.message ?? String(e)}）`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(groupDir, entry.name);
      if (!existsSync(join(dir, SESSION_LOG_FILE))) continue;
      total += 1;
      try {
        const session = loadSession(dir);
        if (session.warnings.length > 0) {
          withWarnings += 1;
          for (const w of session.warnings.slice(0, 3)) pushDetail(`${entry.name}: ${w}`);
        }
      } catch (e) {
        unreadable += 1;
        pushDetail(`${entry.name}: 不可读（${(e as Error)?.message ?? String(e)}）`);
      }
    }
  }
  if (unreadable > 0 || withWarnings > 0) {
    return {
      id: 'sessions',
      status: 'warn',
      summary: `会话库 ${total} 个会话：${withWarnings} 个含坏行/告警，${unreadable} 个不可读`,
      ...(details.length > 0 ? { details } : {}),
    };
  }
  return { id: 'sessions', status: 'ok', summary: `会话库 ${total} 个会话全部可解析（坏行 0）` };
}

/** skills 扫描摘要（两级合并后计数 + 告警；与 chat/serve 注入同源） */
function checkSkills(opts: DoctorOptions): DoctorCheck {
  const root = opts.root ?? process.cwd();
  const store = new SkillStore(projectSkillsRoot(root), defaultSkillsRoot(opts.home));
  const scan = store.scan();
  const details = scan.skills.map((s) => `${s.name} [${s.source}] ${s.description}`);
  for (const w of scan.warnings) details.push(`warning: ${w}`);
  if (scan.warnings.length > 0) {
    return {
      id: 'skills',
      status: 'warn',
      summary: `skills ${scan.skills.length} 个（含 ${scan.warnings.length} 条告警）`,
      ...(details.length > 0 ? { details: details.slice(0, 10) } : {}),
    };
  }
  return {
    id: 'skills',
    status: 'ok',
    summary: `skills ${scan.skills.length} 个（无告警）`,
    ...(details.length > 0 ? { details: details.slice(0, 10) } : {}),
  };
}

/** 单项异常收口：检查函数自身抛错 = 该项 FAIL（不拖垮报告） */
function crashedCheck(id: string, e: unknown): DoctorCheck {
  return { id, status: 'fail', summary: `检查项异常：${(e as Error)?.message ?? String(e)}` };
}

/** 输出出口统一脱敏（红线：doctor 输出必须过 redactSecrets） */
function sanitizeCheck(c: DoctorCheck): DoctorCheck {
  return {
    ...c,
    summary: redactSecrets(c.summary),
    ...(c.details !== undefined ? { details: c.details.map((d) => redactSecrets(d)) } : {}),
  };
}

/** 跑全部 doctor 检查（顺序执行；各项独立 try/catch） */
export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const run = (id: string, fn: () => DoctorCheck): void => {
    try {
      checks.push(fn());
    } catch (e) {
      checks.push(crashedCheck(id, e));
    }
  };
  const runAsync = async (id: string, fn: () => Promise<DoctorCheck>): Promise<void> => {
    try {
      checks.push(await fn());
    } catch (e) {
      checks.push(crashedCheck(id, e));
    }
  };

  run('node', checkNode);
  let config: HarnessConfig | null = null;
  try {
    const r = checkConfig(opts);
    checks.push(r.check);
    config = r.config;
  } catch (e) {
    checks.push(crashedCheck('config', e));
  }
  run('home', () => checkHomeWritable(opts));
  await runAsync('mcp', () => checkMcp(config, opts));
  run('sessions', () => checkSessions(opts));
  run('skills', () => checkSkills(opts));

  const failed = checks.some((c) => c.status === 'fail');
  return { checks: checks.map(sanitizeCheck), exitCode: failed ? 1 : 0 };
}

/** 渲染分节文本报告（CLI doctor 输出） */
export function renderDoctorReport(report: DoctorReport): string[] {
  const marker = { ok: '[OK]', warn: '[WARN]', fail: '[FAIL]' } as const;
  const lines: string[] = [`harness2 doctor（${CORE_VERSION}，${new Date().toISOString()}）`];
  for (const c of report.checks) {
    lines.push(`${marker[c.status].padEnd(5)} ${c.id}: ${c.summary}`);
    for (const d of c.details ?? []) lines.push(`       - ${d}`);
  }
  const counts = {
    ok: report.checks.filter((c) => c.status === 'ok').length,
    warn: report.checks.filter((c) => c.status === 'warn').length,
    fail: report.checks.filter((c) => c.status === 'fail').length,
  };
  lines.push(
    `结果：${counts.ok} OK / ${counts.warn} WARN / ${counts.fail} FAIL → exit ${report.exitCode}${report.exitCode === 0 ? '' : '（FAIL 项见上）'}`,
  );
  return lines;
}
