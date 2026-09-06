#!/usr/bin/env node
// harness2 CLI 入口。traj（阶段 1）、config check（阶段 3）、chat REPL（阶段 4）、serve（阶段 5）。
import { Command } from 'commander';
import { computeProjection, loadSession, renderTrajectory } from '@harness2/core';
import {
  buildConfigReport,
  defaultConfigPaths,
  loadConfig,
  MockProvider,
  readAuthFile,
  startServe,
  DEFAULT_SERVE_PORT,
  type AuthFile,
  type HarnessConfig,
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
  .description('交互式 chat REPL（流式渲染 / 会话管理 / /undo /redo / 审批交互）')
  .option('--session <id>', '恢复指定会话（缺省：恢复 cwd 最新会话或新建）')
  .option('--provider <name>', "provider：'mock' = 内置演示脚本（不加载配置）；缺省按配置 roles.main", 'config')
  .option('--root <dir>', '工作目录：工具执行 cwd + 会话分组（默认当前目录）')
  .option('--home <dir>', '覆盖用户数据根（配置 + 会话存储；测试/多环境用）')
  .action(async (opts: { session?: string; provider: string; root?: string; home?: string }) => {
    try {
      await runChat({
        ...(opts.session !== undefined ? { session: opts.session } : {}),
        ...(opts.provider !== 'config' ? { provider: opts.provider } : {}),
        ...(opts.root !== undefined ? { root: opts.root } : {}),
        ...(opts.home !== undefined ? { home: opts.home } : {}),
      });
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

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

program.parseAsync(process.argv);
