// core 命令层公共出口（加性导出；由包根 src/index.ts 转出）。
// handlers.ts 不在此导出——执行体经 CORE_COMMANDS 装配后消费，不单独暴露。
export * from './types.js';
export { CORE_COMMAND_META, type CoreCommandMeta } from './catalog.js';
export { parseUndoArgs, splitCommandLine, type SplitCommandLine, type UndoArgs } from './parse.js';
export { buildHelpText, HELP_TEXT } from './help.js';
export {
  findCoreCommand,
  parseCoreCommand,
  runCoreCommand,
  CORE_COMMANDS,
  type ParsedCoreCommand,
} from './registry.js';
// D02 命令注册开放化（加性）：运行时注册/注销/清单 + 容器内建服务门面。
export {
  registerCoreCommand,
  unregisterCoreCommand,
  listCoreCommands,
  listExtensionCoreCommands,
  resetCoreCommands,
  coreCommandRegistry,
  type CoreCommandRegistration,
  type CoreCommandRegistryService,
  type RegisteredExtensionCommand,
} from './registry.js';
export {
  describeCapabilities,
  type ApprovalModeCapability,
  type ApprovalPolicyCapability,
  type CoreCapabilities,
  type ToolCapability,
} from './capabilities.js';
