// H-30 「可单独启禁」的运行时过滤（P7-C）：config.tools → 真实进模型的工具集。
//
// 组合语义（唯一权威表述；config/schema.ts 与 manage.ts 的说明必须与此一致）：
//   1. 没有 tools 段（或全空）        → 全量启用（向后兼容，行为与 P7 之前完全一致）；
//   2. tools.toolset = X             → 基线 = 工具集 X 的成员（按已注册名求交，见 toolsets.ts）；
//   3. tools.enable[name] = true     → 覆盖基线**加入**该工具（工具集没选的也加回来）；
//   4. tools.enable[name] = false    → 覆盖基线**剔除**该工具（含 `all` 工具集选中的）；
//   5. 覆盖优先级：enable（逐工具） > toolset（成套） > 缺省全量。
//      —— 逐工具永远赢：这就是「谁覆盖谁」的答案；两者冲突时以 enable 为准。
//   6. enable 指向**未注册**的工具名：禁用项静默接受（未来注册即生效，config 可先行）；
//      启用项如实计入 unknownEnable（调用方可告警，不硬失败——MCP/插件工具名装配期才存在）。
//
// 过滤结果是一个**新的 ToolRegistry**：禁用的工具既不进 ChatRequest.tools（模型看不见），
// 也不在注册表里（执行器查不到 → `unknown tool` 拒绝调用），双保险。
import { ToolRegistry } from './registry.js';
import type { ToolDefinition } from './types.js';
import { resolveToolsetNames } from './toolsets.js';

/** config.tools 段（config/schema.ts 的 ToolsConfig 同形；此处不 import config，避免层级倒挂） */
export interface ToolSelectionConfig {
  /** 工具集名（见 TOOLSET_NAMES）；缺省 = 不裁剪 */
  toolset?: string;
  /** 逐工具覆盖：true 启用 / false 禁用（优先级高于 toolset） */
  enable?: Record<string, boolean>;
}

/** 选择结果（含诊断信息，供 CLI/doctor 展示） */
export interface ToolSelectionResult {
  /** 过滤后的注册表（顺序保持原注册顺序） */
  registry: ToolRegistry;
  /** 最终进模型的工具名（推导自 registry，非并行维护） */
  enabled: readonly string[];
  /** 被剔除的工具名（因 toolset 或 enable=false） */
  disabled: readonly string[];
  /** enable 里声明 true 但当前未注册的名字（如实上报，不静默） */
  unknownEnable: readonly string[];
  /** 生效的工具集名（未配置为 undefined） */
  toolset?: string;
}

/**
 * 纯函数解析：给定已注册工具名与选择配置，算出最终工具名集合。
 * 顺序 = available 原顺序；enable=true 追加的名字（若已注册）保持 available 顺序（不会重排）。
 */
export function resolveEnabledToolNames(
  available: readonly string[],
  config: ToolSelectionConfig = {},
): { enabled: string[]; disabled: string[]; unknownEnable: string[] } {
  const known = new Set(available);
  let base: Set<string>;
  if (config.toolset !== undefined) {
    base = new Set(resolveToolsetNames(config.toolset, available));
  } else {
    base = new Set(available);
  }
  const unknownEnable: string[] = [];
  for (const [name, on] of Object.entries(config.enable ?? {})) {
    if (on) {
      if (known.has(name)) base.add(name);
      else unknownEnable.push(name);
    } else {
      base.delete(name);
    }
  }
  const enabled = available.filter((n) => base.has(n));
  const disabled = available.filter((n) => !base.has(n));
  return { enabled, disabled, unknownEnable };
}

/** 过滤注册表（新实例；输入注册表不被修改——共享注册表可被多会话复用） */
export function applyToolSelection(registry: ToolRegistry, config: ToolSelectionConfig = {}): ToolRegistry {
  return selectTools(registry, config).registry;
}

/** 过滤 + 诊断（applyToolSelection 的完整形态） */
export function selectTools(registry: ToolRegistry, config: ToolSelectionConfig = {}): ToolSelectionResult {
  const available = registry.list().map((d) => d.name);
  const { enabled, disabled, unknownEnable } = resolveEnabledToolNames(available, config);
  const keep = new Set(enabled);
  const filtered = new ToolRegistry();
  for (const def of registry.list()) {
    if (keep.has(def.name)) filtered.register(def);
  }
  return {
    registry: filtered,
    enabled,
    disabled,
    unknownEnable,
    ...(config.toolset !== undefined ? { toolset: config.toolset } : {}),
  };
}

/** 工具是否被允许调用（执行前的显式自查缝；正常路径靠过滤后的注册表天然拦截） */
export function isToolEnabled(result: ToolSelectionResult, name: string): boolean {
  return result.registry.get(name) !== undefined;
}

/** 从注册表取工具定义（过滤后调用方的唯一入口；禁用的工具返回 undefined） */
export function getEnabledTool(registry: ToolRegistry, name: string): ToolDefinition | undefined {
  return registry.get(name);
}
