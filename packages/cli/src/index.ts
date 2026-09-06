#!/usr/bin/env node
// harness2 CLI 入口。traj（阶段 1）、config check（阶段 3）、chat REPL（阶段 4）、serve（阶段 5）、browser/cron（阶段 7）。
import { Command } from 'commander';
import { computeProjection, installBrowserRuntime, loadSession, renderTrajectory } from '@harness2/core';
import {
  buildConfigReport,
  defaultConfigPaths,
  defaultMemoriesRoot,
  defaultPendingRoot,
  loadConfig,
  MemoryStore,
  MockProvider,
  PendingMemoryStore,
  readAuthFile,
  startServe,
  DEFAULT_SERVE_PORT,
  type AuthFile,
  type HarnessConfig,
  type MemoryTarget,
  type MockScript,
} from '@harness2/core';
import { runChat, MOCK_DEMO_SCRIPT } from './chat.js';

const program = new Command();

program.name('harness2').description('跨端 AI agent harness').version('0.1.0');

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
  .command('chat')
  .description('交互式 chat REPL（流式渲染 / 会话管理 / /undo /redo / /fork / 审批交互）')
  .option('--session <id>', '恢复指定会话（缺省：恢复 cwd 最新会话或新建）')
  .option('--fork <id>', '从指定会话分叉新会话并继续（--at 截取事件序号）')
  .option('--at <seq>', '--fork 的截取上界（事件 seq，含）；缺省 = 全部活动事件')
  .option('--provider <name>', "provider：'mock' = 内置演示脚本（不加载配置）；缺省按配置 roles.main", 'config')
  .option('--root <dir>', '工作目录：工具执行 cwd + 会话分组（默认当前目录）')
  .option('--home <dir>', '覆盖用户数据根（配置 + 会话存储；测试/多环境用）')
  .action(async (opts: { session?: string; fork?: string; at?: string; provider: string; root?: string; home?: string }) => {
    let at: number | undefined;
    if (opts.at !== undefined) {
      at = Number(opts.at);
      if (!Number.isInteger(at) || at < 1) {
        console.error('error: --at 必须是 >= 1 的整数');
        process.exit(1);
      }
    }
    try {
      await runChat({
        ...(opts.session !== undefined ? { session: opts.session } : {}),
        ...(opts.fork !== undefined ? { fork: opts.fork } : {}),
        ...(at !== undefined ? { at } : {}),
        ...(opts.provider !== 'config' ? { provider: opts.provider } : {}),
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

program.parseAsync(process.argv);
