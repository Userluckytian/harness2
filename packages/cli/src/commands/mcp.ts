// packages/cli/src/commands/mcp.ts
// B3-1 拆分产物：原 index.ts 第 766–825 行逐字搬入，零逻辑改动。
// mcp 命令（阶段 8）：MCP 服务器查看与连接探测（down 如实显示 + 恢复路径）。
import { Command } from 'commander';
import { McpManager, ToolRegistry, loadConfig, type McpServerConfig } from '@harness2/core';

export function registerMcpCommand(program: Command): void {
  /** mcp 命令（阶段 8）：MCP 服务器查看与连接探测。 */
  const mcpCmd = new Command('mcp').description('MCP 服务器管理');

  mcpCmd
    .command('list')
    .description('列出配置的 MCP 服务器；默认逐 server 连接探测（状态 + 工具数），--no-probe 只看配置')
    .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
    .option('--root <dir>', '项目根目录（默认当前目录）')
    .option('--no-probe', '不连接，只展示配置', true)
    .action(async (opts: { home?: string; root?: string; probe: boolean }) => {
      const loaded = loadConfig({
        ...(opts.root !== undefined ? { root: opts.root } : {}),
        ...(opts.home !== undefined ? { home: opts.home } : {}),
      });
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
}
