// 插件契约（阶段 8）：manifest 声明式权限 + definePlugin 模块形态 + PluginContext。
// 沙箱边界（v1 如实声明）：插件与宿主**同进程**运行、非隔离——permissions 是 API 层
// 约束（PluginContext 逐调用校验）而非强制隔离，恶意代码理论上可绕过（import 宿主模块）。
// worker/isolate 代码隔离已评估：v1 不做，留档（见 architecture.md 插件小节与阶段计划）。
import type { ToolDefinition } from '../tools/types.js';
import type { AnySessionEvent } from '../session/types.js';
import type { ExtensionSessionEvent } from '../session/extension-events.js';
import type { HarnessConfig } from '../config/schema.js';
import type { ServiceContainer } from '../container.js';
import type { CoreCommandRegistration } from '../commands/registry.js';

/** 插件名约束：目录名 = manifest.name（装载身份一致性） */
export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * manifest 声明式权限（未声明的能力一律无权限，最小授权；红线⑩/批次4：能力全走显式
 * 声明，fail-closed，不自动授权）：
 *   tools    —— true = 可注册任意工具名；string[] = 仅名单内工具名可注册
 *   events   —— 可订阅的会话事件类型（内建 KNOWN_EVENT_TYPES 成员、已注册扩展类型
 *               （extensionEventTypes，装载时须已注册）或 '*'）
 *   cron     —— 预留声明：v1 PluginContext 未提供 cron 注册 API（本阶段明确不做），
 *               仅做 manifest 校验与展示，装载不产生 cron 行为。
 *   commands —— 可注册的扩展命令 id 名单（精确 id，无通配；每项须匹配命令 id 约束，
 *               与 registerCoreCommand 的 NAME_RE 同风格；未声明即无权限）。
 */
export interface PluginPermissions {
  tools?: true | string[];
  events?: string[];
  cron?: true;
  commands?: string[];
}

/** 插件清单：<pluginsRoot>/<name>/manifest.json */
export interface PluginManifest {
  name: string;
  version: string;
  permissions?: PluginPermissions;
}

/** 插件事件处理入参（内存总线帧；非落盘事件类型，零新增事件类型不变量不受影响）。
 * 批次4 加性：扩展事件类型（已注册者）与内建事件同帧分发（bus 的 emitSessionEvent
 * 参数同步放宽，宿主把 writer.appendExtension 的产物喂进来即可触达订阅）。 */
export interface PluginEventFrame {
  sessionId: string;
  event: AnySessionEvent | ExtensionSessionEvent;
}

export type PluginEventHandler = (frame: PluginEventFrame) => void;

/**
 * 插件运行上下文：装配层逐插件构造。
 * registerTool/on/registerCommand 返回 disposer（bus 依获取顺序登记，卸载插件时逆序展开）；
 * log/config 无资源副作用，不产生 disposer。
 */
export interface PluginContext {
  /** 注册工具进宿主 ToolRegistry（重名拒绝、受 permissions.tools 约束）；返回 disposer */
  registerTool(def: ToolDefinition): () => void;
  /**
   * 注册扩展命令进 coreCommandRegistry（批次4 加性；受 permissions.commands 约束——
   * 声明名单外的 id 抛 PluginError）。插件卸载时经 disposer 自动 unregisterCoreCommand
   * （生命周期 = 插件自身的 disposer 链，非容器 dispose：容器是宿主作用域，插件级
   * 清理语义归 bus 的逆序展开，见 bus 头注释）。返回 disposer。
   */
  registerCommand(cmd: CoreCommandRegistration): () => void;
  /** 订阅会话事件（内建/已注册扩展类型；受 permissions.events 约束；'*' 需显式授权）；返回退订函数 */
  on(event: string, handler: PluginEventHandler): () => void;
  /** 带插件前缀的日志（sink 由装配层注入） */
  log(message: string): void;
  /** 只读配置快照：深冻结拷贝，改动不影响宿主与后续调用 */
  config(): Readonly<HarnessConfig>;
  /**
   * D02 服务容器（批次4 加性）：预置 'commands' / 'eventTypes' 两内建服务（缺省
   * createCoreContainer，可经 PluginBusOptions.container 注入宿主自有容器）。
   * 生命周期立场：容器是**宿主作用域**——随宿主创建/销毁，不随单个插件卸载；
   * 插件经容器拿到的服务实例与 ctx.registerCommand/on 是同一内核单例。
   * 边界（同 v1 非隔离声明）：容器是进程内对象，permissions 是 API 层约束而非强制
   * 隔离——插件代码本就可 import 宿主模块，ctx.container 只是同一面的便捷入口。
   */
  container: ServiceContainer;
}

/** 插件模块形态：index.js 默认导出 definePlugin({...}) */
export interface PluginModule {
  name: string;
  setup(ctx: PluginContext): void | Promise<void>;
}

/** 插件作者入口：恒等标注（类型检查用；运行时零包装） */
export function definePlugin(mod: PluginModule): PluginModule {
  return mod;
}

/** 插件层错误（权限不足/重名/契约不合法等；loader 收口为跳过 + 告警，不拖垮宿主） */
export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginError';
  }
}
