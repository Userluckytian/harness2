// ink 侧共享命令执行（T5 → P1-Dev-2 内核下沉第二棒）：命令业务实现已下沉 core，
// 本文件用 ChatRuntime 构建真实 CoreCommandContext（cli 旧 CommandContext 的超集）并
// 委托 core `runCoreCommand` 执行——legacy（runCoreCommand 直调）与 next（本文件）走同一
// 份 core 实现，不再有壳内第二份命令语义。
//
// 缝注入（core 可选缝）：
//   - contextUsage：从 runtime 既有口径取（getContextUsage(getCurrent().dir)，与三处壳
//     改造前逐字同算法），/context 输出与改造前一致；
//   - compact：ChatRuntime 无手动压缩句柄（压缩在 core loop turn 开始时自动触发）——
//     如实不注入，core 降级文案与现壳逐字一致，不伪造执行；
//   - cronJobs：ChatRuntime 无 cron 存储句柄——如实不注入，core 降级文案与现壳逐字一致。
//
// 重投影语义：/undo /redo 只向会话日志追加 rewind/marker（append-only），因此执行后必须用
// `projectSession` 重新投影转录，遮蔽的 user/assistant 条目才会消失（/redo 恢复时再出现）。
// 会话切换（new/resume/fork）同样以会话 id 变化触发重投影（替换而非叠加）。
// 先重投影、后回放命令输出行，避免命令提示被整体替换吃掉。
import { SnapshotStore, findCoreCommand, getContextUsage, runCoreCommand } from '@harness2/core';
import type { CoreCommandContext, SessionWriter } from '@harness2/core';
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
 * 用 ChatRuntime 构建 CoreCommandContext 并委托 core runCoreCommand。
 * 入参保持 { name, rest }（name 含 / 前缀）形状——既有调用方与测试不改一字；
 * 内部经 findCoreCommand 解析别名后转 core ParsedCoreCommand。
 * 返回 { reprojected } 供上层记录（当前仅 /undo /redo 与切换会话会重投影）。
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
  const ctx: CoreCommandContext = {
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
    // /context 缝：runtime 既有取法（与改造前三处壳逐字同算法同输出）
    contextUsage: () => {
      const c = runtime.getCurrent();
      return c === null ? undefined : getContextUsage(c.dir);
    },
  };
  const beforeId = runtime.getCurrent()?.id ?? null;
  // 本文件注入的缝全为同步（不注入 compact），runCoreCommand 实际同步完成；void 标注
  // 类型上的 Promise 可能性（core 命令允许异步缝）。
  void runCoreCommand({ raw: parsed.name, id: findCoreCommand(parsed.name)?.id ?? null, rest: parsed.rest }, ctx);
  const afterId = runtime.getCurrent()?.id ?? null;
  const reprojected = REPROJECT_COMMANDS.has(parsed.name) || beforeId !== afterId;
  if (reprojected) io.reproject();
  for (const line of lines) io.print(line);
  return { reprojected };
}
