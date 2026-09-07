// chat REPL 分流入口：TTY/现代终端 → ink 全屏 TUI；其余（piped/CI/逃生舱）→ 原 readline 路径。
// legacy 完整实现与装配在 legacy-chat.ts（字符级搬迁，零行为改动）；ink 路径在 tui/runInkChat.ts。
// 两路径共享同一套会话装配（chat-setup.ts）与命令注册表/模式别名/@file 协议，避免分叉。
import { runLegacyReadlineChat, type ChatOptions } from './legacy-chat.js';

export { runLegacyReadlineChat } from './legacy-chat.js';
export type { ChatOptions } from './legacy-chat.js';

/** mock 演示脚本、子会话脚本、approval 提示与取消哨兵（由 legacy 定义，供外部引用） */
export { MOCK_DEMO_SCRIPT, MOCK_CHILD_DEMO_SCRIPT } from './legacy-chat.js';

export async function runChat(options: ChatOptions = {}): Promise<void> {
  await runLegacyReadlineChat(options);
}