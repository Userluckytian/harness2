// H-31 工具集系统（P7-C）：按场景成套分发工具，而不是让用户逐个配。
//
// 语义（与 selection.ts 的组合规则配套，两处注释必须一致）：
//   - 工具集条目 = 精确工具名，或以 `*` 结尾的前缀通配（如 `browser_*`）；
//   - 工具集按「当前已注册的工具名」求交：条目指向未注册的工具（browser 未启用、memory off、
//     没有 MCP 服务器等）静默跳过——工具集是分发视图，不是硬清单，不因配置缺席报错；
//   - 工具集不含 MCP/插件工具（它们在装配期才知道）；需要放行时用 `tools.enable` 逐工具覆盖，
//     或用 `all`（`*`）整表放行。
//
// 本模块只做「定义 + 解析」，不做持久化（写 config 见 manage.ts 的 select）。
import type { ToolCategory } from './inventory.js';

/** 一个工具集定义（name 用于 config.tools.toolset 取值） */
export interface ToolsetDef {
  name: string;
  /** 一句话场景说明（`harness2 tools list` 展示） */
  summary: string;
  /** 成员条目：精确名或 `前缀_*` 通配 */
  tools: readonly string[];
  /** 建议的必需分类（文档用；不参与过滤） */
  categories?: readonly ToolCategory[];
}

/** 工具集全集（声明顺序 = 展示顺序） */
export const TOOLSETS: readonly ToolsetDef[] = [
  {
    name: 'read-only',
    summary: '只读探索：查看/检索文件与技能，可截浏览器快照；不能写盘、执行命令或派子代理',
    tools: ['read', 'glob', 'grep', 'skill', 'browser_snapshot', 'browser_screenshot'],
  },
  {
    name: 'coding',
    summary: '编码：读写/编辑文件 + 搜索 + 命令执行 + 脚本编排',
    // P2-1：skill_author（经验造技能，config.skills.authoring=on 才注册）也归编码场景——
    // 此前不在任何工具集 → 选具体工具集时被静默剔除（只提案工具，放行无写盘风险）。
    tools: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'skill', 'skill_author', 'run_script'],
  },
  {
    name: 'research',
    summary: '调研：只读文件/检索 + 浏览器 + 记忆 + 子代理（含并行扇出）',
    tools: [
      'read',
      'glob',
      'grep',
      'skill',
      'skill_author',
      'browser_*',
      'memory',
      'subagent_start',
      'subagent_continue',
      'subagent_fanout',
    ],
  },
  {
    name: 'ops',
    summary: '运维：命令执行 + 文件读写 + 浏览器 + 脚本编排',
    tools: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'browser_*', 'run_script'],
  },
  {
    name: 'all',
    summary: '不按场景裁剪：放行全部已注册工具（含 MCP/插件工具）',
    tools: ['*'],
  },
];

/** 全部可用工具集名（config 校验 / 命令补全用；与 TOOLSETS 同源） */
export const TOOLSET_NAMES: readonly string[] = TOOLSETS.map((t) => t.name);

/** 按名取工具集；未知名返回 undefined（不抛错——校验由调用方决定报错时机） */
export function getToolset(name: string): ToolsetDef | undefined {
  return TOOLSETS.find((t) => t.name === name);
}

/** 条目匹配：精确名 或 `前缀*`（`*` 单独出现 = 匹配一切） */
export function matchToolsetEntry(entry: string, toolName: string): boolean {
  if (entry === '*') return true;
  if (entry.endsWith('*')) return toolName.startsWith(entry.slice(0, -1));
  return entry === toolName;
}

/**
 * 把工具集解析成「已注册工具名」子集（保持 available 的原始顺序）。
 * 未知工具集名 → 抛错（配置侧已校验；这里是编程错误的快速失败）。
 */
export function resolveToolsetNames(name: string, available: readonly string[]): string[] {
  const set = getToolset(name);
  if (set === undefined) {
    throw new Error(`unknown toolset "${name}"（可用：${TOOLSET_NAMES.join('、')}）`);
  }
  return available.filter((tool) => set.tools.some((entry) => matchToolsetEntry(entry, tool)));
}

/** 工具集定义里、当前注册表中缺失的条目（报告/doctor 用；不报错） */
export function missingToolsetEntries(name: string, available: readonly string[]): string[] {
  const set = getToolset(name);
  if (set === undefined) return [];
  const missing: string[] = [];
  for (const entry of set.tools) {
    if (entry === '*') continue;
    const matched = entry.endsWith('*')
      ? available.some((t) => t.startsWith(entry.slice(0, -1)))
      : available.includes(entry);
    if (!matched) missing.push(entry);
  }
  return missing;
}
