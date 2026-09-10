// packages/cli/src/commands/chat.ts
// B3-1 拆分产物：原 index.ts 第 230–291 行逐字搬入，零逻辑改动。
// chat 命令（阶段 4）：交互式 chat REPL（实现逻辑在 ../chat.ts，此处只做参数解析与装配）。
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { runChat } from '../chat.js';
import { type MockScript } from '@harness2/core';

export function registerChatCommand(program: Command): void {
  program
    .command('chat')
    .description('交互式 chat REPL（流式渲染 / 会话管理 / /undo /redo / /fork / 审批交互）')
    .option('--session <id>', '恢复指定会话（缺省：恢复 cwd 最新会话或新建）')
    .option('--fork <id>', '从指定会话分叉新会话并继续（--at 截取事件序号）')
    .option('--at <seq>', '--fork 的截取上界（事件 seq，含）；缺省 = 全部活动事件')
    .option('--provider <name>', "provider：'mock' = 内置演示脚本（不加载配置）；缺省按配置 roles.main", 'config')
    .option('--mock-script <file>', '覆盖 mock 演示脚本（JSON 文件，MockScript 形态；测试/演示用）')
    .option('--mock-child-script <file>', '覆盖 mock 子会话脚本（subagent_start 派发的子会话 turn；测试/演示用）')
    .option('--root <dir>', '工作目录：工具执行 cwd + 会话分组（默认当前目录）')
    .option('--home <dir>', '覆盖用户数据根（配置 + 会话存储；测试/多环境用）')
    .option('--no-tui', '强制走 legacy readline 路径（关闭自动 TUI；也可用 HARNESS2_NO_TUI=1）')
    .action(
      async (opts: {
        session?: string;
        fork?: string;
        at?: string;
        provider: string;
        mockScript?: string;
        mockChildScript?: string;
        root?: string;
        home?: string;
      }) => {
        let at: number | undefined;
        if (opts.at !== undefined) {
          at = Number(opts.at);
          if (!Number.isInteger(at) || at < 1) {
            console.error('error: --at 必须是 >= 1 的整数');
            process.exit(1);
          }
        }
        const readScript = (file: string | undefined, label: string): MockScript | undefined => {
          if (file === undefined) return undefined;
          try {
            const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
            if (!Array.isArray(parsed)) throw new Error('必须是数组');
            return parsed as MockScript;
          } catch (e) {
            console.error(`error: --${label} 读取失败: ${(e as Error).message}`);
            process.exit(1);
          }
        };
        const mockScript = readScript(opts.mockScript, 'mock-script');
        const mockChildScript = readScript(opts.mockChildScript, 'mock-child-script');
        try {
          await runChat({
            ...(opts.session !== undefined ? { session: opts.session } : {}),
            ...(opts.fork !== undefined ? { fork: opts.fork } : {}),
            ...(at !== undefined ? { at } : {}),
            ...(opts.provider !== 'config' ? { provider: opts.provider } : {}),
            ...(mockScript !== undefined ? { mockScript } : {}),
            ...(mockChildScript !== undefined ? { mockChildScript } : {}),
            ...(opts.root !== undefined ? { root: opts.root } : {}),
            ...(opts.home !== undefined ? { home: opts.home } : {}),
          });
        } catch (e) {
          console.error(`error: ${(e as Error).message}`);
          process.exitCode = 1;
        }
      },
    );
}
