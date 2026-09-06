#!/usr/bin/env node
// harness2 CLI 入口。traj（阶段 1）、config check（阶段 3）、chat REPL（阶段 4）、serve（阶段 5）、browser/cron（阶段 7）、plugin/mcp（阶段 8）。
import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, sep } from 'node:path';
import {
  buildConfigReport,
  CronJobStore,
  CronScheduler,
  computeProjection,
  createApprovalPolicy,
  createProvider,
  defaultConfigPaths,
  defaultCronRoot,
  defaultMemoriesRoot,
  defaultPendingRoot,
  defaultPluginsRoot,
  defaultSkillsRoot,
  defaultSessionsRoot,
  describePermissions,
  exportSession,
  installBrowserRuntime,
  installCrashReporter,
  importReplay,
  loadConfig,
  loadSession,
  McpManager,
  MemoryStore,
  MockProvider,
  noteCrashSessionId,
  PendingMemoryStore,
  projectSkillsRoot,
  readAuthFile,
  registerBuiltinTools,
  renderDoctorReport,
  renderTrajectory,
  runDoctor,
  scanPluginSources,
  SkillStore,
  startServe,
  ToolRegistry,
  CORE_VERSION,
  DEFAULT_SERVE_PORT,
  type AuthFile,
  type ChatProvider,
  type HarnessConfig,
  type McpServerConfig,
  type MemoryTarget,
  type MockScript,
} from '@harness2/core';
import { runChat, MOCK_DEMO_SCRIPT } from './chat.js';
// gateway 仅 gateway 命令使用：动态加载，避免拖慢 chat/serve 等所有命令的启动
import type { PlatformAdapter } from '@harness2/gateway';

// 顶层崩溃报告（阶段 11 Task 4）：uncaughtException → ~/.harness2/crash/<ISO>.log（redact
// 后）+ 控制台路径与手动反馈指引；无遥测，零网络发送。
installCrashReporter();

const program = new Command();

program.name('harness2').description('跨端 AI agent harness').version(CORE_VERSION);

interface TrajOptions {
  json: boolean;
  all: boolean;
}

program
  .command('traj')
  .description('查看会话轨迹时间线')
  .argument('<sessionDir>', '会话目录（含 session.v1.jsonl）')
  .option('--json', '输出结构化 JSON（事件 + 投影 + 告警）', false)
  .option('--all', '包含被回退遮蔽的影子事件', false)
  .action((sessionDir: string, opts: TrajOptions) => {
    try {
      const session = loadSession(sessionDir);
      if (opts.json) {
        const projection = computeProjection(session);
        const events = session.events.map(({ event, active }) => ({ ...event, active }));
        console.log(
          JSON.stringify({ header: session.header, warnings: session.warnings, projection, events }, null, 2),
        );
        return;
      }
      for (const line of renderTrajectory(session, { includeShadowed: opts.all })) {
        console.log(line);
      }
      for (const w of session.warnings) {
        console.error(`warning: ${w}`);
      }
    } catch (e) {
      // 友好错误：一行摘要 + exit 1，不打印堆栈（P2-5）
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    }
  });

/** export/replay（阶段 10 Task 1）：轨迹作为资产——只读打包导出 + 回放校验投影摘要。 */
program
  .command('export')
  .description('导出会话轨迹为 ZIP（只读打包；含子代理会话 subagents/<id>/）')
  .argument('<sessionDir>', '会话目录（含 session.v1.jsonl）')
  .option('-o, --out <file>', '输出 zip 路径（缺省：当前目录/<sessionId>.zip）')
  .action((sessionDir: string, opts: { out?: string }) => {
    try {
      const r = exportSession(sessionDir, opts.out);
      console.log(`已导出 ${r.sessionId} → ${r.outFile}（${r.entryCount} 个文件）`);
      if (r.subagentIds.length > 0) {
        console.log(`子代理会话：${r.subagentIds.join(', ')}`);
      }
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('replay')
  .description('回放校验导出的 ZIP（逐事件解析 + 投影摘要；坏行报告；CI 零 key 可跑）')
  .argument('<zip>', 'export 产出的 zip 文件')
  .action((zipPath: string) => {
    try {
      const report = importReplay(zipPath);
      for (const s of report.sessions) {
        const label = s.source === 'session.v1.jsonl' ? '主会话' : '子会话';
        console.log(
          `${label} ${s.id}  events=${s.events}  messages=${s.messageCount}  lastSeq=${s.lastSeq}  badLines=${s.badLines}`,
        );
        for (const w of s.warnings) console.log(`  warning: ${w}`);
      }
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    }
  });

interface ConfigCheckOptions {
  root?: string;
  home?: string;
}

program
  .command('config')
  .description('配置管理')
  .addCommand(
    new Command('check')
      .description('校验两级合并配置并脱敏展示 providers/roles/key 来源')
      .option('--root <dir>', '项目根目录（默认当前目录）')
      .option('--home <dir>', '覆盖全局配置 home 目录（默认用户 home；测试/多环境用）')
      .action((opts: ConfigCheckOptions) => {
        const paths = defaultConfigPaths(opts.root, opts.home);
        const result = loadConfig({
          root: opts.root,
          home: opts.home,
          globalPath: paths.globalConfig,
          projectPath: paths.projectConfig,
        });
        // P2-9：先校验后输出——auth.json 读取与全部 error 收集完成前，不允许 "config OK" 先行打印
        const errors = [...result.errors];
        const auth = readAuthFile(paths.globalAuth);
        if (auth.error) errors.push(auth.error);
        if (errors.length === 0) {
          if (result.config) {
            printConfigReport(result.config, result.warnings, result.sources, paths, auth.auth);
          } else {
            errors.push('config 未加载成功（无可用配置）');
          }
        }
        if (errors.length > 0) {
          for (const err of errors) console.error(`error: ${err}`);
          process.exit(1);
        }
      }),
  );

/** 打印脱敏报告；key 来源只显示 auth.json / env:XXX / **missing**，永不显示明文。
 *  前置条件：调用方已确认 errors 为空（先校验后输出，P2-9），本函数不再返回错误。
 *  报告数据与 GET /api/config 同源（core buildConfigReport 唯一构造处），此处只负责文本渲染。 */
function printConfigReport(
  config: HarnessConfig,
  warnings: string[],
  sources: { global: boolean; project: boolean },
  paths: { globalConfig: string; projectConfig: string },
  auth: AuthFile,
): void {
  const report = buildConfigReport(config, auth);
  const lines: string[] = [];
  lines.push(
    `config OK (global: ${sources.global ? paths.globalConfig : '-'} , project: ${sources.project ? paths.projectConfig : '-'})`,
  );
  lines.push('providers:');
  for (const p of report.providers) {
    lines.push(`  ${p.channel}  ${p.protocol}  ${p.baseUrl}${p.envKey ? `  envKey=${p.envKey}` : ''}`);
    if (p.models.length > 0) lines.push(`    models: ${p.models.join(', ')}`);
  }
  lines.push('roles:');
  for (const r of report.roles) {
    lines.push(`  ${r.role} -> ${r.channel}/${r.model}`);
  }
  const approvalRules = Object.entries(report.approval.tools)
    .map(([tool, rule]) => `${tool}=${rule}`)
    .join(', ');
  lines.push(`approval: mode=${report.approval.mode}${approvalRules ? `, rules: ${approvalRules}` : ''}`);
  lines.push('keys:');
  for (const p of report.providers) {
    lines.push(`  ${p.channel}: ${p.keySource}`);
  }
  if (warnings.length > 0) {
    lines.push('warnings:');
    for (const w of warnings) lines.push(`  - ${w}`);
  }
  console.log(lines.join('\n'));
}

program
  .command('doctor')
  .description('环境自检：node 版本 / config+auth（脱敏）/ 目录可写 / MCP（--probe 实连）/ 会话库完整性 / skills')
  .option('--root <dir>', '项目根目录（默认当前目录）')
  .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
  .option('--probe', '实连 MCP 服务器探测（每 server 超时 5s；缺省仅列出配置）', false)
  .action(async (opts: { root?: string; home?: string; probe?: boolean }) => {
    const report = await runDoctor({
      ...(opts.root !== undefined ? { root: opts.root } : {}),
      ...(opts.home !== undefined ? { home: opts.home } : {}),
      ...(opts.probe === true ? { probe: true } : {}),
    });
    for (const line of renderDoctorReport(report)) console.log(line);
    process.exitCode = report.exitCode;
  });

program
  .command('chat')
  .description('交互式 chat REPL（流式渲染 / 会话管理 / /undo /redo / /fork / 审批交互）')
  .option('--session <id>', '恢复指定会话（缺省：恢复 cwd 最新会话或新建）')
  .option('--fork <id>', '从指定会话分叉新会话并继续（--at 截取事件序号）')
  .option('--at <seq>', '--fork 的截取上界（事件 seq，含）；缺省 = 全部活动事件')
  .option('--provider <name>', "provider：'mock' = 内置演示脚本（不加载配置）；缺省按配置 roles.main", 'config')
  .option('--mock-script <file>', '覆盖 mock 演示脚本（JSON 文件，MockScript 形态；测试/演示用）')
  .option('--mock-child-script <file>', '覆盖 mock 子会话脚本（subagent_start 派发的子会话 turn；测试/演示用）')
  .option('--root <dir>', '工作目录：工具执行 cwd + 会话分组（默认当前目录）')
  .option('--home <dir>', '覆盖用户数据根（配置 + 会话存储；测试/多环境用）')
  .action(async (opts: { session?: string; fork?: string; at?: string; provider: string; mockScript?: string; mockChildScript?: string; root?: string; home?: string }) => {
    let at: number | undefined;
    if (opts.at !== undefined) {
      at = Number(opts.at);
      if (!Number.isInteger(at) || at < 1) {
        console.error('error: --at 必须是 >= 1 的整数');
        process.exit(1);
      }
    }
    const readScript = (file: string | undefined, label: string): MockScript | undefined => {
      if (file === undefined) return undefined;
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (!Array.isArray(parsed)) throw new Error('必须是数组');
        return parsed as MockScript;
      } catch (e) {
        console.error(`error: --${label} 读取失败: ${(e as Error).message}`);
        process.exit(1);
      }
    };
    const mockScript = readScript(opts.mockScript, 'mock-script');
    const mockChildScript = readScript(opts.mockChildScript, 'mock-child-script');
    try {
      await runChat({
        ...(opts.session !== undefined ? { session: opts.session } : {}),
        ...(opts.fork !== undefined ? { fork: opts.fork } : {}),
        ...(at !== undefined ? { at } : {}),
        ...(opts.provider !== 'config' ? { provider: opts.provider } : {}),
        ...(mockScript !== undefined ? { mockScript } : {}),
        ...(mockChildScript !== undefined ? { mockChildScript } : {}),
        ...(opts.root !== undefined ? { root: opts.root } : {}),
        ...(opts.home !== undefined ? { home: opts.home } : {}),
      });
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

/** memory 命令（阶段 6）：MEMORY.md/USER.md 查看/清空 + ask 模式待审批暂存管理。
 *  只延迟不丢弃：approve 重放 ops 到 store（失败保留暂存），reject 显式丢弃。 */
const memoryCmd = new Command('memory')
  .description('长期记忆管理（MEMORY.md/USER.md + 待审批暂存）');

interface MemoryHomeOptions {
  home?: string;
}

memoryCmd
  .command('show')
  .description('查看记忆条目与用量（含漂移告警）')
  .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
  .action(async (opts: MemoryHomeOptions) => {
    const store = new MemoryStore(defaultMemoriesRoot(opts.home));
    for (const target of ['memory', 'user'] as const) {
      const v = await store.read(target);
      console.log(`${v.file}（${v.entriesCount} 条，${v.usedChars}/${v.budget} 字符，剩余 ${v.remainingChars}）`);
      if (v.drift) {
        console.log(`  warning: 结构被外部修改（§ 结构漂移），写入将被拒绝并备份 .bak`);
      }
      for (const [i, entry] of v.entries.entries()) {
        console.log(`  [${i + 1}] ${entry.replace(/\r?\n/g, '\\n')}`);
      }
      console.log('');
    }
  });

memoryCmd
  .command('clear')
  .description('清空记忆条目（--target memory|user|all，默认 all；不可恢复）')
  .option('--target <t>', 'memory | user | all', 'all')
  .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
  .action(async (opts: MemoryHomeOptions & { target: string }) => {
    const targets: MemoryTarget[] =
      opts.target === 'all' ? ['memory', 'user'] : [opts.target as MemoryTarget];
    if (opts.target !== 'all' && !['memory', 'user'].includes(opts.target)) {
      console.error(`error: --target 必须是 memory | user | all，实际为 ${opts.target}`);
      process.exit(1);
    }
    const store = new MemoryStore(defaultMemoriesRoot(opts.home));
    for (const target of targets) {
      const v = await store.read(target);
      if (v.drift) {
        console.error(`error: ${v.file} 结构漂移，拒绝清空（未做备份，请先手工恢复 § 结构或删除该文件后重试）`);
        process.exitCode = 1;
        continue;
      }
      if (v.entries.length === 0) {
        console.log(`${v.file}: 无条目`);
        continue;
      }
      const ops = v.entries.map((e) => ({ operation: 'remove' as const, target, oldText: e }));
      const r = await store.apply(ops);
      if (r.ok) console.log(`${v.file}: 已清空 ${ops.length} 条`);
      else {
        console.error(`error: ${v.file} 清空失败: ${r.error}`);
        process.exitCode = 1;
      }
    }
  });

memoryCmd
  .command('pending')
  .description('列出待审批的记忆写入（ask 模式暂存，先到先审）')
  .option('--clear', '清空全部待审批项（不可恢复），输出清除条数')
  .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
  .action(async (opts: MemoryHomeOptions & { clear?: boolean }) => {
    const pending = new PendingMemoryStore(defaultPendingRoot(opts.home));
    if (opts.clear === true) {
      const cleared = await pending.clearAll();
      console.log(`已清除 ${cleared} 条待审批项`);
      return;
    }
    const items = await pending.list();
    if (items.length === 0) {
      console.log('（无待审批项）');
      return;
    }
    for (const p of items) {
      console.log(`${p.id}  ${p.createdAt}  会话 ${p.sessionId}`);
      for (const [i, op] of p.ops.entries()) {
        const text = op.operation === 'remove' ? (op.oldText ?? '') : (op.text ?? '');
        console.log(
          `  [${i + 1}] ${op.operation} ${op.target}: ${text.replace(/\s+/g, ' ').slice(0, 60)}`,
        );
      }
    }
  });

memoryCmd
  .command('approve')
  .description('批准并重放执行一条待审批写入（预算/漂移校验照常生效）')
  .argument('<id>', '待审批项 id')
  .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
  .action(async (id: string, opts: MemoryHomeOptions) => {
    // approve 重放需要绑定目标 store（预算/漂移校验照常生效）
    const pending = new PendingMemoryStore(
      defaultPendingRoot(opts.home),
      new MemoryStore(defaultMemoriesRoot(opts.home)),
    );
    const r = await pending.approve(id);
    if (!r.ok) {
      console.error(`error: ${r.error}`);
      process.exit(1);
    }
    const usage = r.result?.files.map((f) => `${f.target} ${f.usedChars}/${f.budget}`).join(', ');
    console.log(`已写入${usage ? `（${usage}）` : ''}`);
  });

memoryCmd
  .command('reject')
  .description('拒绝并丢弃一条待审批写入')
  .argument('<id>', '待审批项 id')
  .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
  .action(async (id: string, opts: MemoryHomeOptions) => {
    const pending = new PendingMemoryStore(defaultPendingRoot(opts.home));
    const ok = await pending.reject(id);
    if (!ok) {
      console.error(`error: 未找到待审批项 ${id}`);
      process.exit(1);
    }
    console.log(`已丢弃 ${id}`);
  });

program.addCommand(memoryCmd);

/** skill 命令（阶段 10）：项目级 Skills 查看。skill 全文按需经模型侧 skill 工具加载。 */
const skillCmd = new Command('skill').description('项目级 Skills 管理（.harness2/skills/ 与 ~/.harness2/skills/）');

skillCmd
  .command('list')
  .description('列出两级扫描合并后的 skills（名称/来源/描述；同名项目覆盖全局）')
  .option('--root <dir>', '项目根目录（默认当前目录）')
  .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
  .action((opts: { root?: string; home?: string }) => {
    const store = new SkillStore(projectSkillsRoot(opts.root), defaultSkillsRoot(opts.home));
    const scan = store.scan();
    if (scan.skills.length === 0) {
      console.log('（无 skill——把带 frontmatter 的 .md 放进 .harness2/skills/ 或 ~/.harness2/skills/）');
      return;
    }
    for (const s of scan.skills) {
      console.log(`${s.name}  [${s.source}]  ${s.description}`);
    }
    for (const w of scan.warnings) console.error(`warning: ${w}`);
  });

program.addCommand(skillCmd);

/** serve：本地会话服务（阶段 5）。127.0.0.1-only；监听成功后向 stdout 打印一行 JSON
 *  {"port":N,"pid":M}（--port 0 = 随机端口，桌面端固定用它）。SIGINT/SIGTERM 优雅关闭
 *  （取消运行中 turn、拒绝待审批、释放端口锁）。 */
program
  .command('serve')
  .description('启动本地会话服务（HTTP 控制面 + WS 事件面，仅 127.0.0.1）')
  .option('--port <n>', '监听端口（0 = 随机可用端口）', String(DEFAULT_SERVE_PORT))
  .option('--root <dir>', '工具执行 cwd + 会话分组目录（默认当前目录）')
  .option('--home <dir>', '覆盖用户数据根（配置/会话存储/端口锁；测试/多环境用）')
  .option('--provider <name>', "'mock' = 长驻演示脚本（不加载配置、不触发审批）", 'config')
  .action(async (opts: { port: string; root?: string; home?: string; provider: string }) => {
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error('error: --port 必须是 0..65535 的整数');
      process.exit(1);
    }
    try {
      const handle = await startServe({
        port,
        ...(opts.root !== undefined ? { root: opts.root } : {}),
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        ...(opts.provider === 'mock' ? { provider: new MockProvider(SERVE_MOCK_SCRIPT satisfies MockScript) } : {}),
      });
      console.log(JSON.stringify({ port: handle.port, pid: process.pid }));
      const shutdown = (): void => {
        void handle
          .close()
          .catch(() => {})
          .finally(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    }
  });

/** --provider mock 的服务端演示脚本：回复 1000 次（长驻服务不能像 REPL 一样耗尽即停） */
const SERVE_MOCK_SCRIPT: MockScript = Array.from({ length: 1000 }, () => ({
  textChunks: ['mock 回复：', '已收到你的消息。'],
}));

/** browser 命令（阶段 7）：chromium 安装（浏览器工具的浏览器二进制，npm 包本身随依赖安装）。 */
const browserCmd = new Command('browser').description('浏览器工具管理');

browserCmd
  .command('install')
  .description('安装 chromium（Playwright 浏览器二进制，约 130MB；浏览器工具首次使用前必须安装）')
  .action(async () => {
    console.log('正在安装 chromium（Playwright）…');
    const code = await installBrowserRuntime();
    if (code !== 0) {
      console.error(`error: chromium 安装失败（exit ${code}）`);
      process.exit(code);
    }
    console.log('chromium 安装完成：浏览器工具（browser_*）已可用。');
  });

program.addCommand(browserCmd);

/** cron 命令（阶段 7）：定时任务的增删查/手工执行/历史。数据在 ~/.harness2/cron（用户数据，不入 git）。 */
const cronCmd = new Command('cron').description('定时任务管理（serve 运行期间到点自动执行）');

interface CronHomeOptions {
  home?: string;
}

cronCmd
  .command('list')
  .description('列出全部任务（id/调度/下次执行/启用/连续失败）')
  .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
  .action((opts: CronHomeOptions) => {
    const jobs = new CronJobStore(defaultCronRoot(opts.home)).list();
    if (jobs.length === 0) {
      console.log('（无任务）');
      return;
    }
    for (const j of jobs) {
      const instruction = j.instruction.replace(/\s+/g, ' ').slice(0, 60);
      console.log(
        `${j.id}  ${j.schedule}  next=${j.nextRun}${j.enabled ? '' : ' [已熔断/disabled]'}  fail=${j.failCount}`,
      );
      console.log(`  ${instruction}`);
    }
  });

cronCmd
  .command('add')
  .description('新增任务：harness2 cron add "指令" --every 5m | --at "daily 09:00"')
  .argument('<instruction>', '发给模型的指令')
  .option('--every <spec>', '间隔调度："5m"/"2h"/"1d"（最小 1 分钟）')
  .option('--at <spec>', '每日调度："daily HH:MM"（本地时区）')
  .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
  .action((instruction: string, opts: CronHomeOptions & { every?: string; at?: string }) => {
    if (Boolean(opts.every) === Boolean(opts.at)) {
      console.error('error: --every 与 --at 必须二选一');
      process.exit(1);
    }
    const schedule = opts.every ?? opts.at!;
    try {
      const job = new CronJobStore(defaultCronRoot(opts.home)).add(instruction, schedule);
      console.log(`已添加 ${job.id}  ${job.schedule}  首次执行 ${job.nextRun}`);
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    }
  });

cronCmd
  .command('remove')
  .description('删除任务')
  .argument('<id>', '任务 id')
  .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
  .action((id: string, opts: CronHomeOptions) => {
    if (!new CronJobStore(defaultCronRoot(opts.home)).remove(id)) {
      console.error(`error: 未找到任务 ${id}`);
      process.exit(1);
    }
    console.log(`已删除 ${id}`);
  });

cronCmd
  .command('run')
  .description('立即执行一次（不动 nextRun/熔断计数；结果写 history）')
  .argument('<id>', '任务 id')
  .option('--home <dir>', '覆盖用户数据根（配置 + cron 存储）')
  .option('--root <dir>', '工具执行 cwd（默认当前目录）')
  .action(async (id: string, opts: CronHomeOptions & { root?: string }) => {
    const root = opts.root ?? process.cwd();
    const loaded = loadConfig({ root, ...(opts.home !== undefined ? { home: opts.home } : {}) });
    if (loaded.config === null) {
      console.error(`error: ${loaded.errors[0] ?? 'config 未加载成功'}`);
      process.exit(1);
    }
    let provider: ChatProvider;
    try {
      const paths = defaultConfigPaths(root, opts.home);
      provider = createProvider(loaded.config, 'main', { authPath: paths.globalAuth });
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    }
    const tools = new ToolRegistry();
    registerBuiltinTools(tools);
    const scheduler = new CronScheduler({
      root: defaultCronRoot(opts.home),
      cwd: root,
      provider,
      toolsForSession: () => tools,
      // P1-1（阶段 7 审查）：与 serve 调度路径同语义——手工执行同样走审批策略，
      // unsafe 工具不再 allow-all；ask 无人工通道 → 执行器按拒绝处理
      decide: createApprovalPolicy(loaded.config.approval).decide,
      fsync: false,
    });
    const outcome = await scheduler.runOnce(id);
    if (outcome === null) {
      console.error(`error: 未找到任务 ${id}`);
      process.exit(1);
    }
    console.log(outcome.ok ? `执行完成：${outcome.dir}` : `执行失败：${outcome.error ?? outcome.stopReason}（${outcome.dir}）`);
    process.exitCode = outcome.ok ? 0 : 1;
  });

cronCmd
  .command('history')
  .description('查看任务执行历史（最近 20 次；含 result.md 摘要）')
  .argument('<id>', '任务 id')
  .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
  .action((id: string, opts: CronHomeOptions) => {
    const historyDir = join(defaultCronRoot(opts.home), 'history', id);
    if (!existsSync(historyDir)) {
      console.log('（无历史）');
      return;
    }
    const runs = readdirSync(historyDir).sort().reverse().slice(0, 20);
    if (runs.length === 0) {
      console.log('（无历史）');
      return;
    }
    for (const run of runs) {
      let summary = '(result.md 缺失)';
      try {
        const text = readFileSync(join(historyDir, run, 'result.md'), 'utf8');
        summary = text.split('\n').find((l) => l.startsWith('- stopReason') || l.startsWith('- error')) ?? summary;
      } catch {
        // result.md 缺失照实展示
      }
      console.log(`${run}${sep}  ${summary}`);
    }
  });

program.addCommand(cronCmd);

/** plugin 命令（阶段 8）：插件查看与装载审批。插件在 ~/.harness2/plugins/<name>；
 *  审批结果记录在全局 config 的 plugins.allow（manifest 合法 + 名单内才会装载）。 */
const pluginCmd = new Command('plugin').description('插件管理（manifest 权限 + 装载审批）');

interface PluginHomeOptions {
  home?: string;
}

pluginCmd
  .command('list')
  .description('列出插件目录中的插件：manifest 权限与审批状态')
  .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
  .action((opts: PluginHomeOptions) => {
    const sources = scanPluginSources(defaultPluginsRoot(opts.home));
    if (sources.length === 0) {
      console.log('（无插件）');
      return;
    }
    const allow = readPluginsAllow(opts.home);
    for (const s of sources) {
      if (s.manifest === null) {
        console.log(`${s.name}  [manifest 非法] ${s.error ?? ''}`);
        continue;
      }
      const approved = allow.has(s.manifest.name);
      console.log(`${s.manifest.name}  v${s.manifest.version}  ${approved ? '已批准（重启会话/serve 后装载）' : '未批准（plugin enable 启用）'}`);
      console.log(`  权限: ${describePermissions(s.manifest)}`);
    }
  });

pluginCmd
  .command('enable')
  .description('装载审批：打印权限清单，确认后写入全局 config 的 plugins.allow')
  .argument('<name>', '插件名（目录名）')
  .option('--yes', '跳过交互确认（脚本/自动化用）', false)
  .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
  .action(async (name: string, opts: PluginHomeOptions & { yes: boolean }) => {
    const sources = scanPluginSources(defaultPluginsRoot(opts.home));
    const src = sources.find((s) => s.name === name);
    if (src === undefined || src.manifest === null) {
      console.error(`error: 插件 ${name} 不存在或 manifest 非法${src?.error ? `（${src.error}）` : ''}`);
      process.exit(1);
    }
    const manifest = src.manifest;
    console.log(`插件 ${manifest.name} v${manifest.version} 权限清单：`);
    console.log(`  ${describePermissions(manifest)}`);
    console.log('注意：插件与主进程同进程运行（v1 非隔离），批准即授予上述 API 层权限。');
    if (!opts.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => rl.question('确认批准装载? [y/N] ', resolve));
      rl.close();
      if (answer.trim().toLowerCase() !== 'y') {
        console.log('已取消（未写入 config）');
        return;
      }
    }
    try {
      mutatePluginsAllow(opts.home, (allow) => {
        if (!allow.includes(manifest.name)) allow.push(manifest.name);
      });
      console.log(`已批准：plugins.allow += ${manifest.name}（重启 chat/serve 后生效）`);
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    }
  });

pluginCmd
  .command('disable')
  .description('撤销装载审批：从全局 config 的 plugins.allow 移除该插件')
  .argument('<name>', '插件名（目录名）')
  .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
  .action((name: string, opts: PluginHomeOptions) => {
    try {
      let removed = false;
      mutatePluginsAllow(opts.home, (allow) => {
        const i = allow.indexOf(name);
        if (i >= 0) {
          allow.splice(i, 1);
          removed = true;
        }
      });
      console.log(removed ? `已撤销：plugins.allow -= ${name}（重启 chat/serve 后生效）` : `plugins.allow 中没有 ${name}（本就未批准）`);
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program.addCommand(pluginCmd);

/** 读取全局 config 的 plugins.allow（config 不可用时返回空名单，不阻塞 list 展示） */
function readPluginsAllow(home?: string): Set<string> {
  const loaded = loadConfig({ home });
  return new Set(loaded.config?.plugins.allow ?? []);
}

/** 原子改写全局 config 的 plugins.allow（严格 JSON；含注释的 JSONC 拒绝改写，避免静默丢注释） */
function mutatePluginsAllow(home: string | undefined, mutate: (allow: string[]) => void): void {
  const paths = defaultConfigPaths(undefined, home);
  let raw: Record<string, unknown> = {};
  if (existsSync(paths.globalConfig)) {
    const text = readFileSync(paths.globalConfig, 'utf8');
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('config 根节点必须是对象');
      }
      raw = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`全局 config（${paths.globalConfig}）不是严格 JSON（可能含注释）——请手工编辑 plugins.allow`);
    }
  }
  const plugins = (raw['plugins'] ?? {}) as Record<string, unknown>;
  const allow = Array.isArray(plugins['allow']) ? [...(plugins['allow'] as unknown[]).filter((x): x is string => typeof x === 'string')] : [];
  mutate(allow);
  raw['plugins'] = { ...plugins, allow };
  // P2-5③：temp + rename 原子写（对齐 write/edit 工具与 MemoryStore 口径）——写入中途崩溃
  // 不留半截 config；同目录 rename 保证同盘原子性
  const tmpPath = `${paths.globalConfig}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, paths.globalConfig);
}

/** mcp 命令（阶段 8）：MCP 服务器查看与连接探测。 */
const mcpCmd = new Command('mcp').description('MCP 服务器管理');

mcpCmd
  .command('list')
  .description('列出配置的 MCP 服务器；默认逐 server 连接探测（状态 + 工具数），--no-probe 只看配置')
  .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
  .option('--root <dir>', '项目根目录（默认当前目录）')
  .option('--no-probe', '不连接，只展示配置', true)
  .action(async (opts: { home?: string; root?: string; probe: boolean }) => {
    const loaded = loadConfig({ ...(opts.root !== undefined ? { root: opts.root } : {}), ...(opts.home !== undefined ? { home: opts.home } : {}) });
    if (loaded.config === null) {
      console.error(`error: ${loaded.errors[0] ?? 'config 未加载成功'}`);
      process.exit(1);
    }
    const servers = loaded.config.mcpServers;
    const names = Object.keys(servers);
    if (names.length === 0) {
      console.log('（未配置 MCP 服务器——config.mcpServers）');
      return;
    }
    for (const w of loaded.warnings) console.error(`warning: ${w}`);
    if (!opts.probe) {
      for (const name of names) {
        console.log(`${name}  ${describeMcpServer(servers[name]!)}`);
      }
      return;
    }
    // 探测：逐 server 独立连接（不重试——探测即时反馈，正式装载才退避重启）
    for (const name of names) {
      const cfg = servers[name]!;
      process.stdout.write(`${name}  ${describeMcpServer(cfg)}  探测中…`);
      const tools = new ToolRegistry();
      const manager = new McpManager({ tools, maxRestarts: 0, timeoutMs: 8000, logSink: () => {} });
      const report = await manager.connectAll({ [name]: cfg });
      const status = manager.status().find((s) => s.server === name)!;
      if (report.connected.includes(name)) {
        console.log(`\r${name}  ${describeMcpServer(cfg)}  已连接，${status.tools.length} 个工具（mcp__${name}__*）`);
      } else {
        // P2-2：如实显示 down 状态与恢复路径（chat/serve 启动装载时自动退避重试）
        console.log(
          `\r${name}  ${describeMcpServer(cfg)}  down（连接失败：${report.failed[0]?.error ?? status.lastError ?? '未知错误'}；chat/serve 启动时将自动退避重试，修正 config 后重启即可恢复）`,
        );
      }
      await manager.close();
    }
  });

function describeMcpServer(cfg: McpServerConfig): string {
  if ('command' in cfg) {
    return `[stdio] ${cfg.command}${cfg.args?.length ? ` ${cfg.args.join(' ')}` : ''}`;
  }
  return `[url] ${cfg.url}`;
}

program.addCommand(mcpCmd);

// —— gateway（阶段 9）：IM 网关常驻进程（QQ/飞书 → 本地 serve）——
program
  .command('gateway')
  .description('启动 IM 网关：把 QQ/飞书消息桥接到本地会话（需先配置 config.gateways 与 auth.json.gateways 凭据）')
  .option('--root <dir>', 'serve 工作根目录（工具执行 cwd + 会话分组）', process.cwd())
  .option('--home <dir>', '用户数据根（默认 ~/.harness2）')
  .option('--port <n>', 'serve 监听端口（0 = 随机）', '0')
  .option('--platform <list>', '启用的平台（逗号分隔，缺省 = 配置里的全部）')
  .action(async (opts: { root: string; home?: string; port: string; platform?: string }) => {
    const { startServe } = await import('@harness2/core');
    const { startGateway, QqAdapter, FeishuAdapter } = await import('@harness2/gateway');
    const home = opts.home;
    const paths = defaultConfigPaths(opts.root, home);
    const loaded = loadConfig({ root: opts.root, ...(home !== undefined ? { home } : {}) });
    const auth = readAuthFile(paths.globalAuth);
    // P1-6（审查）：配置/凭据错误如实输出（对齐 config check 口径），排障不再被「凭据缺失」一言蔽之
    for (const err of loaded.errors) console.error(`config 错误: ${err}`);
    if (auth.error !== undefined) console.error(`auth 警告: ${auth.error}`);
    const gwConfig = loaded.config?.gateways ?? {};
    const gwAuth = auth.auth.gateways ?? {};

    const wanted = (opts.platform ?? 'qq,feishu')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const adapters: PlatformAdapter[] = [];
    const credFor = (name: string, envKey: string | undefined): { appId: string; appSecret: string } | null => {
      const fromAuth = gwAuth[name];
      if (fromAuth !== undefined) return fromAuth;
      const secret = envKey !== undefined ? process.env[envKey] : undefined;
      return typeof secret === 'string' && secret.length > 0 ? { appId: gwConfig[name as keyof typeof gwConfig]!.appId, appSecret: secret } : null;
    };

    if (wanted.includes('qq')) {
      const qq = gwConfig.qq;
      if (qq === undefined || !qq.enabled) {
        console.error('提示: config.gateways.qq 未配置或 enabled=false，跳过 QQ');
      } else {
        const cred = gwAuth.qq ?? credFor('qq', qq.appSecretEnvKey);
        if (cred === null) {
          console.error(`error: QQ 网关凭据缺失——请在 auth.json.gateways.qq 配置 appId/appSecret（或设 ${qq.appSecretEnvKey ?? '对应环境变量'}）`);
          process.exitCode = 1;
          return;
        }
        adapters.push(new QqAdapter({ config: qq, auth: cred }));
      }
    }
    if (wanted.includes('feishu')) {
      const fs = gwConfig.feishu;
      if (fs === undefined || !fs.enabled) {
        console.error('提示: config.gateways.feishu 未配置或 enabled=false，跳过飞书');
      } else {
        const cred = gwAuth.feishu ?? credFor('feishu', fs.appSecretEnvKey);
        if (cred === null) {
          console.error(`error: 飞书网关凭据缺失——请在 auth.json.gateways.feishu 配置 appId/appSecret（或设 ${fs.appSecretEnvKey ?? '对应环境变量'}）`);
          process.exitCode = 1;
          return;
        }
        adapters.push(new FeishuAdapter({ config: fs, auth: cred, verificationToken: process.env['FEISHU_VERIFICATION_TOKEN'] }));
      }
    }
    if (adapters.length === 0) {
      console.error('error: 没有可启用的平台（检查 --platform 与 config.gateways 配置）');
      process.exitCode = 1;
      return;
    }

    const serve = await startServe({
      port: Number(opts.port) || 0,
      root: opts.root,
      ...(home !== undefined ? { home } : {}),
    });
    const gw = await startGateway({
      root: opts.root,
      ...(home !== undefined ? { home } : {}),
      serve: { baseUrl: `http://127.0.0.1:${serve.port}`, wsUrl: `ws://127.0.0.1:${serve.port}/ws` },
      adapters,
    });
    console.log(JSON.stringify({ gateway: true, platforms: adapters.map((a) => a.channel), port: serve.port }));
    const shutdown = async (): Promise<void> => {
      await gw.stop();
      await serve.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  });

program.parseAsync(process.argv);
