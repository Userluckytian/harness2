// H-30 工具面盘点（P7-C）：把「工具数量与分类」做成可复核的数据，而不是口头数字。
//
// 口径（诚实登记，不吹数）：
//   - 分类依据 = 工具名的静态归属（精确名单 + 前缀规则），未登记的名字归 'plugin'（外部来源）；
//   - 「内置工具」= 随 core 静态注册的工具（builtinTools 6 个）；browser/memory/skill/subagent
//     由装配层按配置决定是否注册（可能缺席），mcp/plugin 的名字在装配期才知道；
//   - 本模块只做只读盘点：不注册、不执行、不改 registry。
//
// H-30 的「可单独启禁」不在这里实现（见 selection.ts），本模块只回答「有哪些工具、各属哪类」。
import type { ToolRegistry } from './registry.js';
import type { ToolDefinition } from './types.js';

/** 工具分类（面向用户的能力面切分） */
export type ToolCategory =
  | 'file' // 读写文件
  | 'search' // 目录/全文检索
  | 'execute' // 进程执行
  | 'script' // 脚本内 RPC 编排（H-43）
  | 'network' // 浏览器/网络
  | 'memory' // 长期记忆
  | 'skill' // 技能加载
  | 'session' // 会话操作
  | 'schedule' // 定时/调度
  | 'subagent' // 子代理
  | 'mcp' // MCP 服务器工具（mcp__<server>__<tool>）
  | 'plugin' // 插件/外部来源（含未登记名字）
  | 'other';

/** 分类全集（声明顺序 = 展示顺序） */
export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  'file',
  'search',
  'execute',
  'script',
  'network',
  'memory',
  'skill',
  'session',
  'schedule',
  'subagent',
  'mcp',
  'plugin',
  'other',
];

/** 工具来源（谁把它注册进注册表） */
export type ToolSource = 'builtin' | 'browser' | 'memory' | 'skill' | 'subagent' | 'script' | 'mcp' | 'plugin';

/** 静态分类表：精确工具名 → { 分类, 来源 }。动态名字（mcp__/插件）由前缀规则兜底。 */
const STATIC_TOOL_META: Readonly<Record<string, { category: ToolCategory; source: ToolSource }>> = {
  bash: { category: 'execute', source: 'builtin' },
  read: { category: 'file', source: 'builtin' },
  write: { category: 'file', source: 'builtin' },
  edit: { category: 'file', source: 'builtin' },
  glob: { category: 'search', source: 'builtin' },
  grep: { category: 'search', source: 'builtin' },
  memory: { category: 'memory', source: 'memory' },
  skill: { category: 'skill', source: 'skill' },
  // P2-1：经验造技能（skills/authoring.ts）此前未登记 → 被兜底成 plugin 来源（误报）。
  // 它属技能面（只提案、不落盘），归既有类目 'skill' / 来源 'skill'。
  skill_author: { category: 'skill', source: 'skill' },
  subagent_start: { category: 'subagent', source: 'subagent' },
  subagent_continue: { category: 'subagent', source: 'subagent' },
  subagent_fanout: { category: 'subagent', source: 'subagent' },
  run_script: { category: 'script', source: 'script' },
};

/** browser_* 前缀（createBrowserTools 的 6 个工具；前缀兜底避免逐个登记漂移） */
const BROWSER_PREFIX = 'browser_';
/** MCP 工具名前缀（mcp__<server>__<tool>） */
const MCP_PREFIX = 'mcp__';

/** 分类一个工具名（未登记 → 'plugin'；mcp__/browser_ 前缀优先） */
export function classifyTool(name: string): ToolCategory {
  if (name.startsWith(MCP_PREFIX)) return 'mcp';
  if (name.startsWith(BROWSER_PREFIX)) return 'network';
  return STATIC_TOOL_META[name]?.category ?? 'plugin';
}

/** 工具来源（未登记 → 'plugin'） */
export function toolSource(name: string): ToolSource {
  if (name.startsWith(MCP_PREFIX)) return 'mcp';
  if (name.startsWith(BROWSER_PREFIX)) return 'browser';
  return STATIC_TOOL_META[name]?.source ?? 'plugin';
}

/** 单条盘点记录 */
export interface ToolInventoryEntry {
  name: string;
  category: ToolCategory;
  source: ToolSource;
  description: string;
  /** true = 可与其它调用并行（工具自带并发声明） */
  concurrencySafe: boolean;
}

/** 工具面盘点结果（total 与 entries 同源，byCategory 是视图） */
export interface ToolInventory {
  total: number;
  entries: readonly ToolInventoryEntry[];
  /** 分类 → 工具名（保持注册顺序） */
  byCategory: Readonly<Record<ToolCategory, readonly string[]>>;
  /** 来源 → 数量（用于报告里区分「内置静态」与「装配期动态」） */
  bySource: Readonly<Record<ToolSource, number>>;
}

/** 盘点一个工具注册表（只读；注册顺序即 entries 顺序） */
export function buildToolInventory(registry: ToolRegistry): ToolInventory {
  const entries: ToolInventoryEntry[] = registry.list().map((def: ToolDefinition) => ({
    name: def.name,
    category: classifyTool(def.name),
    source: toolSource(def.name),
    description: def.description,
    concurrencySafe: def.concurrencySafe === true,
  }));
  const byCategory = Object.fromEntries(TOOL_CATEGORIES.map((c) => [c, [] as string[]])) as Record<
    ToolCategory,
    string[]
  >;
  const bySource: Record<ToolSource, number> = {
    builtin: 0,
    browser: 0,
    memory: 0,
    skill: 0,
    subagent: 0,
    script: 0,
    mcp: 0,
    plugin: 0,
  };
  for (const e of entries) {
    byCategory[e.category].push(e.name);
    bySource[e.source] += 1;
  }
  return { total: entries.length, entries, byCategory, bySource };
}
