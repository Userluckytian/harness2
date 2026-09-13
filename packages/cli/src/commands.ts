// chat 命令集（P1-Dev-2 内核下沉第二棒起为薄 facade）：命令业务实现已下沉 core
// （packages/core/src/commands/，经 @harness2/core 导出）。本文件只做导出名兼容转发
// 与参数形状适配——parseCommand/parseUndoArgs/HELP_TEXT/handleCommand/CommandContext
// 的既有调用方（含测试）不改一字。
//   - parseCommand = core parseCoreCommand 的形状适配（name 含 / 前缀 = core raw）；
//   - handleCommand = core findCoreCommand + runCoreCommand（ctx 即 core CoreCommandContext，
//     core 缝为可选，不注入时命令侧如实降级）；
//   - 壳侧 shellOnly 命令（mode/reasoning）的分发见 shell-commands.ts，不经本文件。
import {
  findCoreCommand,
  parseCoreCommand,
  runCoreCommand,
  type CoreCommandContext,
  HELP_TEXT as CORE_HELP_TEXT,
  parseUndoArgs as coreParseUndoArgs,
  type UndoArgs,
} from '@harness2/core';

/** /help 输出（与 core 同源构建：13 条命令清单 + core 语义说明区） */
export const HELP_TEXT = CORE_HELP_TEXT;

/** 解析命令行：以 / 开头返回命令名与其余参数；非命令返回 null（形状适配 core parseCoreCommand） */
export function parseCommand(line: string): { name: string; rest: string } | null {
  const parsed = parseCoreCommand(line);
  return parsed === null ? null : { name: parsed.raw, rest: parsed.rest };
}

/** 命令处理所需的状态缝 = core CoreCommandContext（print/manager/cwd/current/switchSession/
 *  requestExit/snapshots/fork 为必选，contextUsage/compact/cronJobs 为可选缝） */
export type CommandContext = CoreCommandContext;

/** 命令分发（兼容入口）：parseCoreCommand + runCoreCommand 的薄转发 */
export function handleCommand(parsed: { name: string; rest: string }, ctx: CommandContext): void {
  const id = findCoreCommand(parsed.name)?.id ?? null;
  const result = runCoreCommand({ raw: parsed.name, id, rest: parsed.rest }, ctx);
  if (result !== undefined) void result; // 命令侧异步缝（compact 注入时）；必选 8 条保持同步
}

/** /undo 参数解析：[n] [--dry-run]；非法返回错误消息（core 同源实现） */
export function parseUndoArgs(rest: string): UndoArgs | string {
  return coreParseUndoArgs(rest);
}
