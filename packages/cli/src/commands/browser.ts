// packages/cli/src/commands/browser.ts
// B3-1 拆分产物：原 index.ts 第 481–498 行逐字搬入，零逻辑改动。
// browser 命令（阶段 7）：chromium 安装（浏览器工具的浏览器二进制）。
import { Command } from 'commander';
import { installBrowserRuntime } from '@harness2/core';

export function registerBrowserCommand(program: Command): void {
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
}
