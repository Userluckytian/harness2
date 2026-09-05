#!/usr/bin/env node
// harness2 CLI 入口。阶段 1 提供 traj 命令；阶段 3 提供 config check；后续扩展 chat 等。
import { Command } from 'commander';
import { computeProjection, loadSession, renderTrajectory } from '@harness2/core';
import {
  defaultConfigPaths,
  loadConfig,
  readAuthFile,
  resolveApiKey,
  type HarnessConfig,
} from '@harness2/core';

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
        const errors = [...result.errors];
        if (result.config) {
          // 深层展示（含 auth 读取）；auth 损坏等展示期错误追加进 errors 统一 exit 1
          errors.push(...printConfigReport(result.config, result.warnings, result.sources, paths));
        }
        if (errors.length > 0) {
          for (const err of errors) console.error(`error: ${err}`);
          process.exit(1);
        }
      }),
  );

/** 打印脱敏报告；key 来源只显示 auth.json / env:XXX / **missing**，永不显示明文。
 *  返回展示期发现的错误（如 auth.json 损坏），由调用方统一 exit 1。 */
function printConfigReport(
  config: HarnessConfig,
  warnings: string[],
  sources: { global: boolean; project: boolean },
  paths: { globalConfig: string; projectConfig: string; globalAuth: string },
): string[] {
  const errors: string[] = [];
  const auth = readAuthFile(paths.globalAuth);
  if (auth.error) errors.push(auth.error);

  const lines: string[] = [];
  lines.push(
    `config OK (global: ${sources.global ? paths.globalConfig : '-'} , project: ${sources.project ? paths.projectConfig : '-'})`,
  );
  lines.push('providers:');
  for (const [channel, p] of Object.entries(config.providers)) {
    lines.push(`  ${channel}  ${p.protocol}  ${p.baseUrl}${p.envKey ? `  envKey=${p.envKey}` : ''}`);
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
    const source = resolveApiKey(channel, p, auth.auth, process.env);
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
  return errors;
}

program.parseAsync(process.argv);
