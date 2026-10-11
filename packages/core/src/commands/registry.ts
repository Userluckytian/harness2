// core 命令注册表：29 条元数据（P7-B/C 加性 23→29：会话能力 5 条 + 工具面 1 条）。
// 非 shellOnly 命令必须有 run（RUNS 表；模块加载时缺 run 即抛错，杜绝假入口）。
// findCoreCommand / parseCoreCommand / runCoreCommand 供各壳统一分发（词法解析来自 parse.ts）。
// D02 命令注册开放化（文件尾）：registerCoreCommand / unregisterCoreCommand 开放运行时
// 注册，内建 29 条行为零变化（source='builtin'，不可覆盖不可注销——fail-closed）。
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
import type { CoreCommand, CoreCommandArgs, CoreCommandContext, CoreCommandGroup, CoreCommandRun } from './types.js';

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
  return listCoreCommands().find((c) => c.id === key || (c.aliases ?? []).includes(key));
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

// —— D02 命令注册开放化（2026-10-11）———————————————————————————————
// 语义参照 refs-deepseek-harness D-30（注册表：拒重复 key、保注册顺序、幂等注销）——
// 只取注册表语义，不引 Cordis 运行时。内建 29 条（CORE_COMMANDS）行为零变化：
// 不可覆盖、不可注销（fail-closed）；运行时注册的扩展命令追加在分发面尾部，
// 注册时重名（id 或别名）即抛明确错误，故永不遮蔽内建。
// 生命周期立场：模块级单例（与 CORE_COMMANDS 同为进程级形态），多入口共享同一命令面；
// 测试隔离经 resetCoreCommands()（只清扩展，内建不动）。

/** 运行时注册的扩展命令形态（source 恒为 'extension'） */
export type RegisteredExtensionCommand = CoreCommand & { source: 'extension' };

/**
 * 注册输入：run 必填（扩展命令没有「留壳」语义——core 即执行层，无 run 即假入口）；
 * source 由注册表统一盖 'extension' 章，调用方不可自报（防伪装内建，fail-closed）。
 */
export interface CoreCommandRegistration {
  /** 规范命令 id（不含 /，小写字母开头，仅小写字母/数字/连字符） */
  id: string;
  /** 别名（不含 /；与任何内建/扩展的 id 或别名冲突即拒） */
  aliases?: readonly string[];
  group: CoreCommandGroup;
  /** 一句话描述（帮助/候选下拉展示） */
  summary: string;
  /** 参数格式说明（无参可省略） */
  argsSpec?: string;
  /** 执行体（必填） */
  run: CoreCommandRun;
}

/** id/别名命名约束：与内建命令 id 同风格（小写字母开头，仅小写字母/数字/连字符） */
const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** 内建命令占用名集合（id + 别名；registration 只读目录，零依赖实现模块） */
const BUILTIN_KEYS: ReadonlySet<string> = new Set(
  CORE_COMMAND_META.flatMap((meta) => [meta.id, ...(meta.aliases ?? [])]),
);

/** 运行时注册的扩展命令（注册序；模块级单例，立场见本段文件头） */
const extensionCommands: RegisteredExtensionCommand[] = [];

function assertFreeKey(key: string, conflict: ReadonlySet<string>, kind: string): void {
  if (!NAME_RE.test(key)) {
    throw new Error(`invalid core command ${kind}: ${key}（需小写字母开头，仅小写字母/数字/连字符）`);
  }
  if (BUILTIN_KEYS.has(key)) {
    throw new Error(`core command ${kind} "${key}" collides with builtin command（内建不可覆盖）`);
  }
  if (conflict.has(key)) {
    throw new Error(`core command ${kind} "${key}" already registered`);
  }
}

/**
 * 注册扩展命令（D02 命令注册开放化）：id/别名与内建或已注册扩展冲突即抛明确错误
 * （fail-closed，内建不可覆盖）；id/别名格式非法、缺 run、summary 为空、自报 source
 * 一律抛错。注册后命令即进入 findCoreCommand / parseCoreCommand / runCoreCommand
 * 分发面与 describeCapabilities()（source='extension'）。
 */
export function registerCoreCommand(cmd: CoreCommandRegistration): void {
  if (typeof cmd?.id !== 'string' || cmd.id.length === 0) {
    throw new Error(`invalid core command id: ${String(cmd?.id)}`);
  }
  if (typeof cmd.run !== 'function') {
    throw new Error(`core command ${cmd.id}: run is required（扩展命令无「留壳」语义）`);
  }
  if ('source' in cmd && (cmd as { source?: unknown }).source !== undefined) {
    throw new Error(`core command ${cmd.id}: source is assigned by the registry（不可自报）`);
  }
  if (typeof cmd.summary !== 'string' || cmd.summary.length === 0) {
    throw new Error(`core command ${cmd.id}: summary must be a non-empty string`);
  }
  const conflict = new Set<string>();
  for (const existing of extensionCommands) {
    for (const key of [existing.id, ...(existing.aliases ?? [])]) conflict.add(key);
  }
  assertFreeKey(cmd.id, conflict, 'id');
  for (const alias of cmd.aliases ?? []) assertFreeKey(alias, conflict, 'alias');
  extensionCommands.push({
    id: cmd.id,
    ...(cmd.aliases !== undefined ? { aliases: [...cmd.aliases] } : {}),
    group: cmd.group,
    summary: cmd.summary,
    ...(cmd.argsSpec !== undefined ? { argsSpec: cmd.argsSpec } : {}),
    run: cmd.run,
    source: 'extension',
  });
}

/**
 * 注销扩展命令（dispose 配套）：builtin 命令不可注销（fail-closed 抛错）；
 * 扩展命令存在则移除返回 true，不存在返回 false（幂等）。
 * 注销后命令退出分发面与 describeCapabilities()。
 */
export function unregisterCoreCommand(id: string): boolean {
  const key = id.replace(/^\/+/, '').toLowerCase();
  if (BUILTIN_KEYS.has(key)) {
    throw new Error(`cannot unregister builtin command: ${key}（内建不可注销）`);
  }
  const at = extensionCommands.findIndex((c) => c.id === key);
  if (at === -1) return false;
  extensionCommands.splice(at, 1);
  return true;
}

/** 全部可分发命令：内建在前（声明序），扩展按注册序追加（重名拒绝保证无遮蔽） */
export function listCoreCommands(): readonly CoreCommand[] {
  return [...CORE_COMMANDS, ...extensionCommands];
}

/** 扩展命令只读视图（describeCapabilities 消费；注册序） */
export function listExtensionCoreCommands(): readonly RegisteredExtensionCommand[] {
  return extensionCommands;
}

/** 测试隔离：清空全部扩展命令（内建 29 条不动） */
export function resetCoreCommands(): void {
  extensionCommands.length = 0;
}

/** 服务容器内建服务 'commands' 的门面（模块级注册表的对象形态，便于容器挂载与外部持有） */
export interface CoreCommandRegistryService {
  /** 注册扩展命令（语义同 registerCoreCommand） */
  register(cmd: CoreCommandRegistration): void;
  /** 注销扩展命令（语义同 unregisterCoreCommand；builtin 抛错） */
  unregister(id: string): boolean;
  /** 全部命令（内建 + 扩展，注册序） */
  list(): readonly CoreCommand[];
  /** 按命令词查找（id 或别名，可带 / 前缀；语义同 findCoreCommand） */
  find(word: string): CoreCommand | undefined;
}

export const coreCommandRegistry: CoreCommandRegistryService = {
  register: registerCoreCommand,
  unregister: unregisterCoreCommand,
  list: listCoreCommands,
  find: findCoreCommand,
};
