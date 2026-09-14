// core 命令注册表：29 条元数据（P7-B/C 加性 23→29：会话能力 5 条 + 工具面 1 条）。
// 非 shellOnly 命令必须有 run（RUNS 表；模块加载时缺 run 即抛错，杜绝假入口）。
// findCoreCommand / parseCoreCommand / runCoreCommand 供各壳统一分发（词法解析来自 parse.ts）。
import { runSessionCapability } from '../session/capabilities.js';
import { runToolsCommand, type ToolsCommandIo } from '../tools/manage.js';
import { ToolRegistry } from '../tools/registry.js';
import { asSessionCapabilityContext } from './capability-bridge.js';
import { CORE_COMMAND_META } from './catalog.js';
import {
  runCompact,
  runContext,
  runExit,
  runFork,
  runHelp,
  runNew,
  runRedo,
  runResume,
  runSessions,
  runTasks,
  runUndo,
} from './handlers.js';
import { splitCommandLine } from './parse.js';
import type { CoreCommand, CoreCommandArgs, CoreCommandContext, CoreCommandRun } from './types.js';

/** 会话能力命令适配器（RUNS 表用）：委托 runSessionCapability，未识别 id 不会到达这里 */
function sessionCapability(id: string): CoreCommandRun {
  return (ctx: CoreCommandContext, args: CoreCommandArgs) =>
    runSessionCapability(id, { rest: args.rest }, asSessionCapabilityContext(ctx)).then(() => undefined);
}

/**
 * /tools 适配器（RUNS 表用）：core 只做数据 + 决策，壳注入 registry/selection/configPath
 * （未注入时如实为空表 / 不落盘——不伪造执行）。参数按空白切分（rest 已 trim）。
 */
export function runTools(ctx: CoreCommandContext, args: CoreCommandArgs): void {
  const selection = ctx.toolSelection?.();
  const configPath = ctx.configPath?.();
  const io: ToolsCommandIo = {
    registry: ctx.toolRegistry?.() ?? new ToolRegistry(),
    ...(selection !== undefined ? { current: selection } : {}),
    ...(configPath !== undefined ? { configPath } : {}),
  };
  const argv = args.rest.split(/\s+/).filter((s) => s.length > 0);
  ctx.print(runToolsCommand(argv, io).output);
}

/** id → run 装配表（shellOnly 命令不出现） */
const RUNS: Readonly<Record<string, CoreCommandRun>> = {
  new: runNew,
  sessions: runSessions,
  resume: runResume,
  fork: runFork,
  // P7-B 会话能力命令（H-11～H-14）：core 实现 = session/capabilities.ts
  search: sessionCapability('search'),
  reindex: sessionCapability('reindex'),
  import: sessionCapability('import'),
  title: sessionCapability('title'),
  undo: runUndo,
  redo: runRedo,
  help: runHelp,
  exit: runExit,
  // P7-C 工具面命令（H-31）：core 实现 = tools/manage.ts
  tools: runTools,
  context: runContext,
  compact: runCompact,
  'compact-layers': sessionCapability('compact-layers'),
  tasks: runTasks,
};

/** 全部命令（声明顺序 = 帮助展示顺序；非 shellOnly 一律带 run，shellOnly 仅元数据） */
export const CORE_COMMANDS: readonly CoreCommand[] = CORE_COMMAND_META.map((meta) => {
  if (meta.shellOnly === true) return { ...meta };
  const run = RUNS[meta.id];
  if (run === undefined) throw new Error(`core command missing run: ${meta.id}`);
  return { ...meta, run };
});

/** 按命令词（id 或别名，可带 / 前缀）查找命令；未注册返回 undefined */
export function findCoreCommand(word: string): CoreCommand | undefined {
  const key = word.replace(/^\/+/, '').toLowerCase();
  if (key.length === 0) return undefined;
  return CORE_COMMANDS.find((c) => c.id === key || (c.aliases ?? []).includes(key));
}

/** 解析结果：raw 供未知命令报错文案，id 为规范命令（别名已解析；未注册为 null） */
export interface ParsedCoreCommand {
  /** 原始命令词（含 / 前缀，小写） */
  raw: string;
  /** 规范命令 id（不含 /）；未注册命令为 null */
  id: string | null;
  /** 其余参数（已 trim） */
  rest: string;
}

/** 解析命令行：非命令返回 null；别名（/? /quit）解析为规范 id */
export function parseCoreCommand(line: string): ParsedCoreCommand | null {
  const split = splitCommandLine(line);
  if (split === null) return null;
  return { raw: split.word, id: findCoreCommand(split.word)?.id ?? null, rest: split.rest };
}

/**
 * 分发执行：未知命令输出「未知命令」文案（与 cli 一致）；shellOnly 命令如实声明
 * 由界面层执行（core 不提供 run，不画饼）；其余委托命令 run（旧 8 条同步，可异步者返回 Promise）。
 */
export function runCoreCommand(parsed: ParsedCoreCommand, ctx: CoreCommandContext): void | Promise<void> {
  const cmd = parsed.id === null ? undefined : findCoreCommand(parsed.id);
  if (cmd === undefined) {
    ctx.print(`未知命令 ${parsed.raw}（/help 查看命令列表）`);
    return;
  }
  if (cmd.run === undefined) {
    ctx.print(`error: 命令 ${parsed.raw} 由界面层实现（shellOnly），core 未提供执行体`);
    return;
  }
  return cmd.run(ctx, { rest: parsed.rest });
}
