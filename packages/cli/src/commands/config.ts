// packages/cli/src/commands/config.ts
// B3-1 拆分产物：原 index.ts 第 136–213 行逐字搬入，零逻辑改动。
// config check 命令（阶段 3）：两级合并配置校验 + 脱敏展示（P2-9 先校验后输出）。
import { Command } from 'commander';
import {
  buildConfigReport,
  defaultConfigPaths,
  loadConfig,
  readAuthFile,
  type AuthFile,
  type HarnessConfig,
} from '@harness2/core';

export function registerConfigCommand(program: Command): void {
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
}
