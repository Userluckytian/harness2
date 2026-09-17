// command-registry：两路径共享的命令注册表（名字+一句话描述）。
// P1-Dev-2 内核下沉第二棒：本文件不再是壳内的元数据清单——命令元数据一律从 core
// （CORE_COMMAND_META，经 @harness2/core 导出）派生，壳侧只保留展示/匹配工具函数
// （COMMAND_ORDER / commandNameWithSlash / matchCommands / describeCommand）。
// 旧壳 Composer 的候选下拉与 legacy readline 的 completer 都从这里读，禁止各维护一份。
import { CORE_COMMAND_META } from '@harness2/core';

export interface CommandMeta {
  name: string;
  description: string;
}

/** 全部命令注册表（13 条；声明顺序 = core 元数据顺序 = 帮助展示顺序；壳不维护第二份清单） */
export const COMMAND_REGISTRY: readonly CommandMeta[] = CORE_COMMAND_META.map((meta) => ({
  name: meta.id,
  description: meta.summary,
}));

/** 排序后的展示顺序（/mode 等新命令按注册表顺序） */
export const COMMAND_ORDER: readonly string[] = COMMAND_REGISTRY.map((c) => c.name);

/** 带 / 前缀的命令展示名（候选这些渲染） */
export function commandNameWithSlash(name: string): string {
  return `/${name}`;
}

/** 模糊匹配候选：输入命令名（无 / 前缀）→ 匹配前缀的完整命令名列表 */
export function matchCommands(inputName: string): string[] {
  const prefix = inputName.replace(/^\/+/, '').toLowerCase();
  if (prefix.length === 0) return COMMAND_ORDER.map(commandNameWithSlash);
  return COMMAND_ORDER.filter((name) => name.startsWith(prefix)).map(commandNameWithSlash);
}

/** 单条描述（legacy 帮助用；无则 '（无描述）'） */
export function describeCommand(name: string): string {
  const meta = COMMAND_REGISTRY.find((c) => c.name === name);
  return meta !== undefined ? meta.description : '（无描述）';
}
