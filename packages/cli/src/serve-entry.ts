#!/usr/bin/env node
// serve-only 打包入口（桌面端资源包 dist-bundle/harness2-cli.cjs 用）。
// 只注册 serve 命令，不含 chat/ink —— 避免 ink 的 ESM top-level-await 与 esbuild CJS
// 打包冲突（此前 bundle 把一个含 ink 的完整 CLI 打成 cjs 会失败）。桌面端只 spawn serve，
// 不需要交互 chat，故此处是干净、可 CJS 打包的最小入口。
import { Command } from 'commander';
import {
  DEFAULT_SERVE_PORT,
  MockProvider,
  installCrashReporter,
  startServe,
  type MockScript,
} from '@harness2/core';

// 与完整 CLI 入口一致：顶层崩溃报告（无遥测、零网络）。
installCrashReporter();

/** --provider mock 的服务端演示脚本：回复 1000 次（长驻服务不能像 REPL 一样耗尽即停） */
const SERVE_MOCK_SCRIPT: MockScript = Array.from({ length: 1000 }, () => ({
  textChunks: ['mock 回复：', '已收到你的消息。'],
}));

const program = new Command();
program.name('harness2').description('harness2 本地会话服务（桌面端 serve 资源）');

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
        ...(opts.provider === 'mock' ? { provider: new MockProvider(SERVE_MOCK_SCRIPT) } : {}),
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

// eslint-disable-next-line @typescript-eslint/no-floating-promises
program.parseAsync(process.argv);
