// shell-command-impls.ts — P3-A 新注册 shellOnly 命令的壳层 thin 实现（G-54~G-90 补齐）。
//
// 背景：catalog.ts P3-A 批次加性注册了 8 条 shellOnly 元数据（session-info/export/
// timeline/doctor/memory/skills/plugins/mcps）——能力已在 core 其它模块（全部只读或
// 只读打包），本文件把它们接成「点了有反应」的真命令：每个实现 = core API 调用 +
// io.print 文本输出（输出文案与 cli 对应子命令逐字同源：harness2 export / doctor /
// memory show / skill list / plugin list / mcp list --no-probe）。
//
// 路由契约（接线棒消费）：core 有 run 的命令 → 既有 runSharedCommand；本表命令 →
// runPaletteShellCommand；两者都不是 → core runCoreCommand 的 shellOnly 如实降级文案。
// 面板 Enter 产出的 {kind:'execute', name} 由宿主按此路由（draft-preserving：面板不改
// 草稿，对齐上游 SendSlashCommandPreservingDraft）。
//
// P1-1 收敛：本文件是这 8 条的**单一实现**，由 shell-commands.ts 的壳表引用注册——legacy/
// ink/next 三壳共用同一份（ShellCommandIo 即共享执行缝：print + currentSessionDir/root/home），
// 不再出现「仅 next 有实现、默认壳落 core 兜底」的假入口。
//
// 模式限定：/timeline 仅 fullscreen（G-03，'timeline' 已在 render/minimal.ts 的
// FULLSCREEN_ONLY_COMMANDS 冻结清单）——门控归壳层 handleCommand 的 G-03 谓词与面板
// badge，本文件不做二次裁决（不接模式参数，如实依赖调用方门控）。
import {
  MemoryStore,
  SkillStore,
  computeProjection,
  defaultMemoriesRoot,
  defaultPluginsRoot,
  defaultSkillsRoot,
  describePermissions,
  exportSession,
  loadConfig,
  loadSession,
  projectSkillsRoot,
  renderDoctorReport,
  renderTrajectory,
  runDoctor,
  scanPluginSources,
} from '@harness2/core';

/** 本文件接管的命令 id（与 catalog P3-A 批次的 shellOnly 新增一致） */
export const PALETTE_SHELL_COMMANDS: readonly string[] = [
  'session-info',
  'export',
  'timeline',
  'doctor',
  'memory',
  'skills',
  'plugins',
  'mcps',
];

/** 壳层执行缝（宿主注入；print 输出进转录，root/home 供 skills/plugins/memory/mcps 定位） */
export interface ShellCommandIo {
  /** 输出一行纯文本（进转录系统行） */
  print(text: string): void;
  /** 当前活动会话目录（无活动会话 = null；session-info/export/timeline 用） */
  currentSessionDir(): string | null;
  /** 项目根（skills 项目级扫描、mcps 项目级 config 基点） */
  root: string;
  /** 用户数据根（memory/plugins 全局根、mcps 全局 config；缺省 = 真实 home） */
  home?: string;
}

/**
 * 执行本表命令；返回是否接管（false = 不在本表，调用方回落 core runCoreCommand）。
 * 异步实现（doctor/memory）返回 Promise<boolean>，宿主 await。
 */
export function runPaletteShellCommand(id: string, io: ShellCommandIo, rest: string): boolean | Promise<boolean> {
  switch (id) {
    case 'session-info':
      runSessionInfo(io);
      return true;
    case 'export':
      runExport(io, rest);
      return true;
    case 'timeline':
      runTimeline(io);
      return true;
    case 'doctor':
      return runDoctorCommand(io).then(() => true);
    case 'memory':
      return runMemory(io).then(() => true);
    case 'skills':
      runSkills(io);
      return true;
    case 'plugins':
      runPlugins(io);
      return true;
    case 'mcps':
      runMcps(io);
      return true;
    default:
      return false;
  }
}

function requireSessionDir(io: ShellCommandIo): string | null {
  const dir = io.currentSessionDir();
  if (dir === null) io.print('error: 无活动会话');
  return dir;
}

// ---- G-59 /session-info（/status /info）：会话详情（只读） ----

function runSessionInfo(io: ShellCommandIo): void {
  const dir = requireSessionDir(io);
  if (dir === null) return;
  try {
    const session = loadSession(dir);
    io.print(`会话 ID: ${session.header?.sessionId ?? '—'}`);
    if (session.header?.cwd !== undefined) io.print(`工作目录: ${session.header.cwd}`);
    if (session.header?.createdAt !== undefined) io.print(`创建时间: ${session.header.createdAt}`);
    if (session.header?.parentSession !== undefined) io.print(`分叉自: ${session.header.parentSession}`);
    const active = session.events.filter((e) => e.active).length;
    io.print(`事件: ${session.events.length} 条（活动 ${active}，遮蔽 ${session.events.length - active}）`);
    io.print(`消息: ${computeProjection(session).messages.length} 条`);
    for (const w of session.warnings) io.print(`warning: ${w}`);
  } catch (e) {
    io.print(`error: ${(e as Error).message}`);
  }
}

// ---- G-63 /export：会话轨迹只读打包导出（同 cli `harness2 export` 输出） ----
// 薄扩展（登记）：rest 非空时作为输出 zip 路径（缺省 = process.cwd()/<sessionId>.zip，
// 与 cli export 同默认）——显式路径让面板场景可落到用户指定位置。

function runExport(io: ShellCommandIo, rest: string): void {
  const dir = requireSessionDir(io);
  if (dir === null) return;
  try {
    const r = exportSession(dir, rest.length > 0 ? rest : undefined);
    io.print(`已导出 ${r.sessionId} → ${r.outFile}（${r.entryCount} 个文件）`);
    if (r.subagentIds.length > 0) io.print(`子代理会话：${r.subagentIds.join(', ')}`);
  } catch (e) {
    io.print(`error: ${(e as Error).message}`);
  }
}

// ---- G-03 /timeline（仅 fullscreen）：轨迹时间线只读输出（同 cli `harness2 traj` 文本态） ----

function runTimeline(io: ShellCommandIo): void {
  const dir = requireSessionDir(io);
  if (dir === null) return;
  try {
    const session = loadSession(dir);
    for (const line of renderTrajectory(session)) io.print(line);
    for (const w of session.warnings) io.print(`warning: ${w}`);
  } catch (e) {
    io.print(`error: ${(e as Error).message}`);
  }
}

// ---- G-85 /doctor：环境自检分节报告（同 cli `harness2 doctor`；不实连探测） ----

async function runDoctorCommand(io: ShellCommandIo): Promise<void> {
  const report = await runDoctor({
    root: io.root,
    ...(io.home !== undefined ? { home: io.home } : {}),
  });
  for (const line of renderDoctorReport(report)) io.print(line);
}

// ---- G-77 /memory：长期记忆只读查看（同 cli `harness2 memory show` 输出） ----

async function runMemory(io: ShellCommandIo): Promise<void> {
  const store = new MemoryStore(defaultMemoriesRoot(io.home));
  for (const target of ['memory', 'user'] as const) {
    const v = await store.read(target);
    io.print(`${v.file}（${v.entriesCount} 条，${v.usedChars}/${v.budget} 字符，剩余 ${v.remainingChars}）`);
    if (v.drift) io.print('  warning: 结构被外部修改（§ 结构漂移），写入将被拒绝并备份 .bak');
    for (const [i, entry] of v.entries.entries()) {
      io.print(`  [${i + 1}] ${entry.replace(/\r?\n/g, '\\n')}`);
    }
    io.print('');
  }
}

// ---- G-78 /skills：两级扫描合并列出（同 cli `harness2 skill list` 输出） ----

function runSkills(io: ShellCommandIo): void {
  const store = new SkillStore(projectSkillsRoot(io.root), defaultSkillsRoot(io.home));
  const scan = store.scan();
  if (scan.skills.length === 0) {
    io.print('（无 skill——把带 frontmatter 的 .md 放进 .harness2/skills/ 或 ~/.harness2/skills/）');
    return;
  }
  for (const s of scan.skills) io.print(`${s.name}  [${s.source}]  ${s.description}`);
  for (const w of scan.warnings) io.print(`warning: ${w}`);
}

// ---- G-78 /plugins：插件目录与装载审批状态（同 cli `harness2 plugin list` 输出） ----

function runPlugins(io: ShellCommandIo): void {
  const sources = scanPluginSources(defaultPluginsRoot(io.home));
  if (sources.length === 0) {
    io.print('（无插件）');
    return;
  }
  const loaded = loadConfig(io.home !== undefined ? { home: io.home } : {});
  const allow = new Set(loaded.config?.plugins.allow ?? []);
  // B4-3：如实声明 v1 插件同进程非隔离边界（与 cli plugin list 同文案）
  io.print('注意：v1 插件与主进程同进程运行（非隔离），manifest 权限仅为 API 层约束，不提供沙箱。');
  for (const s of sources) {
    if (s.manifest === null) {
      io.print(`${s.name}  [manifest 非法] ${s.error ?? ''}`);
      continue;
    }
    const approved = allow.has(s.manifest.name);
    io.print(
      `${s.manifest.name}  v${s.manifest.version}  ${approved ? '已批准（重启会话/serve 后装载）' : '未批准（plugin enable 启用）'}`,
    );
    io.print(`  权限: ${describePermissions(s.manifest)}`);
  }
}

// ---- G-88 /mcps：MCP 配置只读列表（同 cli `harness2 mcp list --no-probe`；不实连） ----

/** MCP server 一行描述（与 cli mcp.ts 的私有 describeMcpServer 同文案；core 未导出，故本地同源复制） */
function describeMcpServer(cfg: { command?: string; args?: readonly string[]; url?: string }): string {
  if (typeof cfg.command === 'string') {
    return `[stdio] ${cfg.command}${cfg.args?.length ? ` ${cfg.args.join(' ')}` : ''}`;
  }
  return `[url] ${cfg.url ?? ''}`;
}

function runMcps(io: ShellCommandIo): void {
  const loaded = loadConfig({
    root: io.root,
    ...(io.home !== undefined ? { home: io.home } : {}),
  });
  if (loaded.config === null) {
    io.print(`error: ${loaded.errors[0] ?? 'config 未加载成功'}`);
    return;
  }
  for (const w of loaded.warnings) io.print(`warning: ${w}`);
  const servers = loaded.config.mcpServers;
  const names = Object.keys(servers);
  if (names.length === 0) {
    io.print('（未配置 MCP 服务器——config.mcpServers）');
    return;
  }
  for (const name of names) {
    io.print(`${name}  ${describeMcpServer(servers[name] ?? {})}`);
  }
}
