// core 命令层契约：命令类型 + 执行缝。与渲染完全无关——本目录不 import 任何
// UI 框架/ANSI/终端概念，输出一律经 ctx.print 产出纯文本行（错误行以 'error: '
// 前缀开头，与壳既有文案逐字一致）；壳负责把文本行映射到自己的呈现。
// 主线 P1 授权的加性下沉：11 条命令业务实现进 core；mode/reasoning 只注册元数据
// （shellOnly，实现留壳——审批模式切换与推理展示开关是壳状态/呈现语义，模式枚举
// 与校验来自 core 的 approval policy，经 describeCapabilities().modes 暴露）。
import type { CronJob } from '../cron/jobs.js';
import type { SessionManager } from '../session/manager.js';
import type { SnapshotStore } from '../session/snapshots.js';
import type { SessionWriter } from '../session/writer.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolSelectionConfig } from '../tools/selection.js';

/** 命令语义分组（describeCapabilities / 帮助展示用） */
export type CoreCommandGroup = '会话' | '历史' | '上下文' | '调度' | '模式' | '通用';

/** 单次命令调用的参数（后续扩展加字段不破坏既有 run 签名） */
export interface CoreCommandArgs {
  /** 命令词后的其余参数（已 trim；可为空串） */
  rest: string;
}

/**
 * 命令执行缝：由壳（piped REPL / TUI / 桌面 / 未来 web）注入运行时句柄。
 * 基础缝对齐 cli commands.ts 的 CommandContext（print/manager/cwd/current/
 * switchSession/requestExit/snapshots/fork），并为 context/compact/tasks 增加最小缝
 * （读上下文占用、触发压缩、读 cron 任务列表）；不注入的可选缝由命令侧如实降级
 * （对齐现有壳行为，不伪造执行）。
 */
export interface CoreCommandContext {
  /** 输出一行纯文本（无 ANSI；error 行以 'error: ' 开头） */
  print(text: string): void;
  /** 会话管理器（/sessions 列表与搜索） */
  manager: SessionManager;
  /** 会话分组/搜索的工作目录 */
  cwd: string;
  /** 当前活动会话（无则 null） */
  current(): { id: string; writer: SessionWriter } | null;
  /** 切换会话；id 为 null = 新建会话 */
  switchSession(id: string | null): void;
  /** 请求退出 REPL */
  requestExit(): void;
  /** 当前会话的快照存储（undo/redo 联动；未启用快照返回 undefined） */
  snapshots(): SnapshotStore | undefined;
  /** 从当前会话分叉新会话并切换（at = 截取到的事件序号，缺省全部活动）；未注入 = 不支持分叉 */
  fork?(at?: number): void;
  /**
   * 读当前上下文占用（0..1）；无活动会话/无法估算返回 undefined。
   * /context 的缺省口径（不注入时）：core getContextUsage(current().writer.dir)。
   */
  contextUsage?(): number | undefined;
  /**
   * 手动触发一次上下文压缩；返回是否实际执行（false = 未达阈值或摘要失败跳过）。
   * 未注入时 /compact 只输出自动压缩提示（对齐现有壳行为）。
   */
  compact?(): boolean | Promise<boolean>;
  /** 读 cron 任务列表（只读）。未注入时 /tasks 输出 `harness2 cron list` 引导文案（对齐现有壳行为）。 */
  cronJobs?(): readonly CronJob[];
  /**
   * 当前运行时工具注册表（/tools list|show 的盘点来源；未注入 = 空表，列表如实为空）。
   * 形状与 tools/manage.ts 的 ToolsCommandIo.registry 同源——壳只做一行注入。
   */
  toolRegistry?(): ToolRegistry;
  /** 当前生效的工具选择配置（config.tools；未注入 = 不裁剪，与既有全量行为一致） */
  toolSelection?(): ToolSelectionConfig | undefined;
  /** 项目 config.json 路径（/tools select 落盘目标；未注入 = 只打印片段不落盘，只读/干跑） */
  configPath?(): string | undefined;
}

/** 命令执行体；新命令可异步（返回 Promise），旧 8 条保持同步（cli 既有测试不改字） */
export type CoreCommandRun = (ctx: CoreCommandContext, args: CoreCommandArgs) => void | Promise<void>;

/** 命令定义（id 不带 /；shellOnly 命令 run 必须缺省，不画饼） */
export interface CoreCommand {
  /** 规范命令 id（不含 /，小写） */
  id: string;
  /** 别名（不含 /；如 help 的 '?'、exit 的 'quit'） */
  aliases?: readonly string[];
  group: CoreCommandGroup;
  /** 一句话描述（帮助/候选下拉展示） */
  summary: string;
  /** 参数格式说明（如 '[n] [--dry-run]'；无参可省略） */
  argsSpec?: string;
  /** true = 实现留壳（仅注册元数据；审批模式切换与推理展示开关是壳状态/呈现语义） */
  shellOnly?: boolean;
  /** 执行体；shellOnly 命令必须缺省 */
  run?: CoreCommandRun;
}
