#!/usr/bin/env node
// harness2 CLI 入口。traj（阶段 1）、config check（阶段 3）、chat REPL（阶段 4）。
import { Command } from 'commander';
import { computeProjection, loadSession, renderTrajectory } from '@harness2/core';
import {
  defaultConfigPaths,
  loadConfig,
  readAuthFile,
  redactObject,
  resolveApiKey,
  type AuthFile,
  type HarnessConfig,
} from '@harness2/core';
import { runChat } from './chat.js';

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
 *  前置条件：调用方已确认 errors 为空（先校验后输出，P2-9），本函数不再返回错误。 */
function printConfigReport(
  config: HarnessConfig,
  warnings: string[],
  sources: { global: boolean; project: boolean },
  paths: { globalConfig: string; projectConfig: string },
  auth: AuthFile,
): void {
  const lines: string[] = [];
  lines.push(
    `config OK (global: ${sources.global ? paths.globalConfig : '-'} , project: ${sources.project ? paths.projectConfig : '-'})`,
  );
  lines.push('providers:');
  for (const [channel, p] of Object.entries(config.providers)) {
    // P2-6/P2-9：展示值统一过 redactObject（全部字符串叶子过 redactSecrets），
    // 防 ${VAR} 展开值（如内网地址内嵌 token）或误写入的 key 泄入输出
    const safe = redactObject(p);
    lines.push(`  ${channel}  ${safe.protocol}  ${safe.baseUrl}${safe.envKey ? `  envKey=${safe.envKey}` : ''}`);
    const models = Object.keys(p.models ?? {});
    if (models.length > 0) lines.push(`    models: ${models.join(', ')}`);
  }
  lines.push('roles:');
  for (const [role, r] of Object.entries(config.roles)) {
    lines.push(`  ${role} -> ${r.channel}/${r.model}`);
  }
  const approvalRules = Object.entries(config.approval.tools ?? {})
    .map(([tool, rule]) => `${tool}=${rule}`)
    .join(', ');
  lines.push(`approval: mode=${config.approval.mode ?? 'default'}${approvalRules ? `, rules: ${approvalRules}` : ''}`);
  lines.push('keys:');
  for (const [channel, p] of Object.entries(config.providers)) {
    const source = resolveApiKey(channel, p, auth, process.env);
    const label =
      source.kind === 'auth.json'
        ? 'auth.json'
        : source.kind === 'env'
          ? `env:${source.envKey}`
          : '**missing**';
    lines.push(`  ${channel}: ${label}`);
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

program.parseAsync(process.argv);
