// 插件契约（阶段 8）：manifest 声明式权限 + definePlugin 模块形态 + PluginContext。
// 沙箱边界（v1 如实声明）：插件与宿主**同进程**运行、非隔离——permissions 是 API 层
// 约束（PluginContext 逐调用校验）而非强制隔离，恶意代码理论上可绕过（import 宿主模块）。
// worker/isolate 代码隔离已评估：v1 不做，留档（见 architecture.md 插件小节与阶段计划）。
import type { ToolDefinition } from '../tools/types.js';
import type { AnySessionEvent } from '../session/types.js';
import type { HarnessConfig } from '../config/schema.js';

/** 插件名约束：目录名 = manifest.name（装载身份一致性） */
export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * manifest 声明式权限（未声明的能力一律无权限，最小授权）：
 *   tools  —— true = 可注册任意工具名；string[] = 仅名单内工具名可注册
 *   events —— 可订阅的会话事件类型（KNOWN_EVENT_TYPES 成员或 '*'）
 *   cron   —— 预留声明：v1 PluginContext 未提供 cron 注册 API（本阶段明确不做），
 *             仅做 manifest 校验与展示，装载不产生 cron 行为。
 */
export interface PluginPermissions {
  tools?: true | string[];
  events?: string[];
  cron?: true;
}

/** 插件清单：<pluginsRoot>/<name>/manifest.json */
export interface PluginManifest {
  name: string;
  version: string;
  permissions?: PluginPermissions;
}

/** 插件事件处理入参（内存总线帧；非落盘事件类型，零新增事件类型不变量不受影响） */
export interface PluginEventFrame {
  sessionId: string;
  event: AnySessionEvent;
}

export type PluginEventHandler = (frame: PluginEventFrame) => void;

/**
 * 插件运行上下文：装配层逐插件构造。
 * registerTool/on 返回 disposer（bus 依获取顺序登记，卸载插件时逆序展开）；
 * log/config 无资源副作用，不产生 disposer。
 */
export interface PluginContext {
  /** 注册工具进宿主 ToolRegistry（重名拒绝、受 permissions.tools 约束）；返回 disposer */
  registerTool(def: ToolDefinition): () => void;
  /** 订阅会话事件（受 permissions.events 约束；'*' 需显式授权）；返回退订函数 */
  on(event: string, handler: PluginEventHandler): () => void;
  /** 带插件前缀的日志（sink 由装配层注入） */
  log(message: string): void;
  /** 只读配置快照：深冻结拷贝，改动不影响宿主与后续调用 */
  config(): Readonly<HarnessConfig>;
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
