// packages/cli/src/commands/tools.ts
// P7-C H-31：`harness2 tools <list|show|select>` 的壳侧薄接线（core 实现 = tools/manage.ts）。
// 壳只做：解析 argv → loadConfig 取 config.tools → 调 runToolsCommand → 打印 + 退出码。
// 盘点注册表 = 内置工具（registerBuiltinTools）；配置为全量启用基线时 list 里的
// enabled/disabled 由 runToolsCommand 依 config.tools 现算（壳不维护第二份选择逻辑）。
import { Command } from 'commander';
import {
  loadConfig,
  defaultConfigPaths,
  registerBuiltinTools,
  runToolsCommand,
  ToolRegistry,
  type ToolsCommandIo,
} from '@harness2/core';

export function registerToolsCommand(program: Command): void {
  /** tools 命令（P7-C）：查看/切换工具面（工具清单、工具集 list/show/select）。 */
  program
    .command('tools')
    .description('工具面管理：列出工具与工具集、查看单个工具/工具集、选择工具集写回 config.json')
    .argument('[args...]', 'list | show <工具名|工具集名> | select <工具集名>')
    .option('--root <dir>', '项目根目录（默认当前目录）')
    .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
    .option('--json', '以 JSON 输出（机器可读）')
    .option('--dry-run', 'select 只打印将要写入的片段，不落盘')
    .action((args: string[], opts: { root?: string; home?: string; json?: boolean; dryRun?: boolean }) => {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry);
      const loaded = loadConfig({ root: opts.root, ...(opts.home !== undefined ? { home: opts.home } : {}) });
      for (const w of loaded.warnings) console.error(`warning: ${w}`);
      const paths = defaultConfigPaths(opts.root, opts.home);
      const io: ToolsCommandIo = {
        registry,
        ...(loaded.config?.tools !== undefined ? { current: loaded.config.tools } : {}),
        configPath: paths.projectConfig,
      };
      const argv = [...args];
      if (opts.json === true && !argv.includes('--json')) argv.push('--json');
      if (opts.dryRun === true && !argv.includes('--dry-run')) argv.push('--dry-run');
      const result = runToolsCommand(argv, io);
      if (result.output.length > 0) console.log(result.output);
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    });
}
