// ink 侧共享命令执行（T5）：把 ink 本地未覆盖的命令（/undo /redo，以及 /new /resume /fork
// /exit /quit 与未知命令）委托给共享 `commands.ts` 的 `handleCommand`，用 ChatRuntime 构建
// 真实 CommandContext。避免 ink 与 legacy 各维护一份命令语义（命令对齐缺口 ③）。
//
// 重投影语义：/undo /redo 只向会话日志追加 rewind/marker（append-only），因此执行后必须用
// `projectSession` 重新投影转录，遮蔽的 user/assistant 条目才会消失（/redo 恢复时再出现）。
// 会话切换（new/resume/fork）同样以会话 id 变化触发重投影（替换而非叠加）。
// 先重投影、后回放命令输出行，避免命令提示被整体替换吃掉。
import { SnapshotStore, type SessionWriter } from '@harness2/core';
import { handleCommand, type CommandContext } from '../commands.js';
import type { ChatRuntime } from '../chat-setup.js';

export interface InkCommandIo {
  /** 追加一条系统转录条目 */
  print(text: string): void;
  /** 用 projectSession 重新投影当前会话（rewind/切换后） */
  reproject(): void;
  /** 退出（幂等 createShutdown 路径，exit code 0） */
  requestExit(): void;
}

/** 需要执行后重投影的命令（rewind 语义） */
const REPROJECT_COMMANDS = new Set(['/undo', '/redo']);

/**
 * 用 ChatRuntime 构建 CommandContext 并委托共享 handleCommand。
 * 返回 { reprojected } 供上层记录（当前仅 /undo //redo 与切换会话会重投影）。
 */
export function runSharedCommand(
  parsed: { name: string; rest: string },
  runtime: ChatRuntime,
  io: InkCommandIo,
): { reprojected: boolean } {
  const lines: string[] = [];
  const collect = (t: string): void => {
    lines.push(t);
  };
  const ctx: CommandContext = {
    print: collect,
    manager: runtime.sessionManager,
    cwd: runtime.root,
    current: () => {
      const c = runtime.getCurrent();
      return c === null ? null : { id: c.id, writer: c.writer as SessionWriter };
    },
    switchSession: (id: string | null) => {
      runtime.switchSession(id, { print: collect });
    },
    requestExit: () => io.requestExit(),
    snapshots: () => {
      const c = runtime.getCurrent();
      return c === null ? undefined : new SnapshotStore(c.dir);
    },
    fork: (at?: number) => {
      runtime.fork(at, { print: collect });
    },
  };
  const beforeId = runtime.getCurrent()?.id ?? null;
  handleCommand(parsed, ctx);
  const afterId = runtime.getCurrent()?.id ?? null;
  const reprojected = REPROJECT_COMMANDS.has(parsed.name) || beforeId !== afterId;
  if (reprojected) io.reproject();
  for (const line of lines) io.print(line);
  return { reprojected };
}
