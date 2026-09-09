// packages/cli/src/commands/serve.ts
// B3-1 拆分产物：原 index.ts 第 438–475 行逐字搬入，零逻辑改动。
// serve 命令（阶段 5）：本地会话服务（HTTP 控制面 + WS 事件面，仅 127.0.0.1）。
// 监听成功后向 stdout 打印一行 JSON {"port":N,"pid":M}；SIGINT/SIGTERM 优雅关闭。
import { Command } from 'commander';
import { DEFAULT_SERVE_PORT, MockProvider, startServe, type MockScript } from '@harness2/core';

export function registerServeCommand(program: Command): void {
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
}
