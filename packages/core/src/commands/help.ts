// 帮助文本：由元数据目录构建（与 cli HELP_TEXT 逐字一致——同源元数据 + 同源说明区）。
// 说明区属 core 语义（快照/rewind/分叉/审批 [a] 说明），从 cli commands.ts 搬平。
import { CORE_COMMAND_META } from './catalog.js';

const HELP_NOTES: readonly string[] = [
  '说明：',
  '  - write/edit 工具的文件改动会进文件快照，可被 /undo 恢复（创建的文件将被删除）；',
  '    bash 命令造成的改动不进快照，/undo 无法恢复它（如实声明）。',
  '  - run_script 在独立 Node 子进程里执行代码（与 bash 同级的代码执行，审批在工具级）；',
  '    脚本内经 harness.tools 的 write/edit 改动同样不进快照、/undo 无法恢复，内层调用也不进',
  '    会话日志与执行观察面——需要可回滚的写入请直接调 write/edit。',
  '  - redo 会恢复到撤销前状态，撤销之后新输入的消息将被移出当前上下文',
  '    （仍保留在日志中，可用 traj 查看）。',
  '  - 撤回/重做只追加 rewind 标记（append-only），会话日志永不回改。',
  '  - 分叉（/fork）= 复制当前会话的活动事件到新会话（血缘入 header）；',
  '    原会话零改动，新会话 undo 从零开始（文件快照不复制）。',
  '  - 审批提示中的 [a] 本会话总是 = 该工具后续所有调用不再询问（仅进程内会话级，不落盘）。',
  '  - 以 / 开头的普通消息会被当作命令，无法直接发送。',
];

/** 由命令元数据构建帮助文本（供 HELP_TEXT 与测试复用） */
export function buildHelpText(entries: ReadonlyArray<{ id: string; summary: string }>): string {
  // 列宽 16：容纳 P7 的 /compact-layers（15 列，B 棒会话能力命令）与 /session-info（13 列，
  // G-59 上游规范名）并保留 ≥1 空格间隔（最长的 /compact-layers 15 + 1 = 16）。
  const list = entries.map((c) => `  ${`/${c.id}`.padEnd(16)}${c.summary}`);
  return ['命令：', ...list, ...HELP_NOTES].join('\n');
}

/** /help 输出（29 条命令清单 + core 语义说明区；P3-A 加性 15→23，P7 加性 23→29） */
export const HELP_TEXT: string = buildHelpText(CORE_COMMAND_META);
