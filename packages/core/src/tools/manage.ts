// H-31 工具集管理命令（P7-C）：`harness2 tools <list|show|select>` 的 core 侧实现。
//
// 分层（H-70 两层分层）：core 只做「数据 + 决策 + 落盘」，壳只做「参数解析 + 打印」。
// 本模块不依赖 commander/yargs，也不需要 TTY：输入是 argv 数组，输出是纯文本 + 退出码，
// 因此 CLI / 桌面 IPC / web 都能直接复用同一份实现（壳各自薄接线一行）。
//
// 子命令：
//   tools list              —— 工具清单（分类、启用/禁用、来源）+ 工具集清单
//   tools show <name|set>   —— 单个工具详情，或某个工具集的成员/缺席条目
//   tools select <set>      —— 把 tools.toolset 写进 config.json（JSONC 保注释改写）；
//                              --dry-run 只打印将要写入的片段，不落盘
//
// 落盘走 jsonc-parser 的 modify/applyEdits：只改 `tools.toolset` 这一个位置，
// 文件其余内容（含注释、缩进、尾逗号）逐字节保留；不重排、不重写整份配置。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser';
import type { CoreCommandMeta } from '../commands/catalog.js';
import { buildToolInventory, type ToolCategory } from './inventory.js';
import type { ToolRegistry } from './registry.js';
import { selectTools, type ToolSelectionConfig } from './selection.js';
import { TOOLSETS, getToolset, missingToolsetEntries, resolveToolsetNames } from './toolsets.js';

/** 命令依赖（壳注入；全部只读或由壳决定副作用边界） */
export interface ToolsCommandIo {
  /** 当前运行时工具注册表（真实工具面；缺省 = 空表，列表会如实为空） */
  registry: ToolRegistry;
  /** 当前生效的选择配置（config.tools；缺省 = 全量启用） */
  current?: ToolSelectionConfig;
  /** config.json 路径（select 落盘目标）；缺省 = 不落盘，只打印片段（只读/干跑） */
  configPath?: string;
}

/** 命令结果：退出码 + 纯文本输出 + 结构化动作（壳可分支/机器可读） */
export interface ToolsCommandResult {
  exitCode: number;
  output: string;
  action?: 'list' | 'show' | 'select';
  /** select 生效后的配置段（dry-run 与实际写入都返回） */
  selection?: ToolSelectionConfig;
}

/** 用法文本（未知子命令/`--help` 输出） */
export const TOOLS_COMMAND_USAGE = [
  '用法: harness2 tools <list|show|select>',
  '',
  '  list                    列出工具（分类/启用状态/来源）与可用工具集',
  '  show <工具名|工具集名>   查看单个工具详情，或工具集成员与缺席条目',
  '  select <工具集名>        把 tools.toolset 写入项目 config.json（--dry-run 只看不写）',
  '',
  `可用工具集: ${TOOLSETS.map((t) => t.name).join(' / ')}`,
].join('\n');

/**
 * 命令面元数据（H-70 两层分层：core 出元数据 + 执行体，壳出参数解析与展示）。
 * 接线（本棒受目录约束未做，登记为交接项）：
 *   1. `src/commands/catalog.ts` 的 CORE_COMMAND_META 加本条目；
 *   2. `src/commands/registry.ts` 的 RUNS 表加 `tools: (ctx, a) => { const r = runToolsCommand(split(a.rest), io); ctx.print(r.output); }`
 *      （io 由壳提供 registry/configPath；不登记 RUNS 会在模块加载时抛 missing run）。
 *   3. CLI 侧 `harness2 tools` 子命令同样只是一行转调 runToolsCommand。
 */
export const TOOLS_COMMAND_META: CoreCommandMeta = {
  id: 'tools',
  group: '通用',
  summary: '查看/切换工具面（工具清单、工具集 list/show/select）',
  argsSpec: '<list|show|select> [参数]',
};

/** 分类中文标签（展示用；未知分类回落原值） */
const CATEGORY_LABELS: Readonly<Record<ToolCategory, string>> = {
  file: '文件',
  search: '检索',
  execute: '执行',
  script: '脚本',
  network: '网络',
  memory: '记忆',
  skill: '技能',
  session: '会话',
  schedule: '调度',
  subagent: '子代理',
  mcp: 'MCP',
  plugin: '插件',
  other: '其它',
};

/** 启用/禁用标记（纯 ASCII，避免终端编码差异） */
const ON = '[on]';
const OFF = '[off]';

/**
 * 执行 `harness2 tools` 命令。纯函数式（除 `select` 落盘外无副作用）；从不抛错。
 * args 不含命令词 `tools` 本身（壳解析后传入剩余参数）。
 */
export function runToolsCommand(args: readonly string[], io: ToolsCommandIo): ToolsCommandResult {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    return { exitCode: sub === undefined ? 1 : 0, output: TOOLS_COMMAND_USAGE };
  }
  if (sub === 'list') return runList(io, rest.includes('--json'));
  if (sub === 'show')
    return runShow(
      io,
      rest.filter((a) => a !== '--json'),
      rest.includes('--json'),
    );
  if (sub === 'select') return runSelect(io, rest);
  return { exitCode: 1, output: `未知子命令 "${sub}"\n\n${TOOLS_COMMAND_USAGE}` };
}

/** 当前选择结果（list/show 共用；诊断字段与过滤后的注册表同源） */
function currentSelection(io: ToolsCommandIo) {
  return selectTools(io.registry, io.current ?? {});
}

function runList(io: ToolsCommandIo, json: boolean): ToolsCommandResult {
  const inventory = buildToolInventory(io.registry);
  const selection = currentSelection(io);
  const enabled = new Set(selection.enabled);
  if (json) {
    return {
      exitCode: 0,
      action: 'list',
      output: JSON.stringify(
        {
          total: inventory.total,
          enabled: selection.enabled,
          disabled: selection.disabled,
          unknownEnable: selection.unknownEnable,
          toolset: selection.toolset ?? null,
          byCategory: inventory.byCategory,
          bySource: inventory.bySource,
          toolsets: TOOLSETS.map((t) => ({ name: t.name, summary: t.summary, tools: t.tools })),
          entries: inventory.entries,
        },
        null,
        2,
      ),
    };
  }
  const lines: string[] = [];
  lines.push(
    `工具 ${inventory.total} 个（启用 ${selection.enabled.length} / 禁用 ${selection.disabled.length}` +
      `${selection.toolset !== undefined ? `；工具集 ${selection.toolset}` : '；未指定工具集（全量）'}）`,
  );
  const byCat = inventory.byCategory;
  for (const [category, names] of Object.entries(byCat)) {
    if (names.length === 0) continue;
    const label = CATEGORY_LABELS[category as ToolCategory] ?? category;
    lines.push(`  ${label}: ${names.map((n) => `${n} ${enabled.has(n) ? ON : OFF}`).join('  ')}`);
  }
  if (selection.unknownEnable.length > 0) {
    lines.push(`  警告: tools.enable 声明的工具当前未注册: ${selection.unknownEnable.join(', ')}`);
  }
  lines.push(`工具集 ${TOOLSETS.length} 个:`);
  for (const t of TOOLSETS) {
    lines.push(`  ${t.name} — ${t.summary}`);
  }
  return { exitCode: 0, action: 'list', output: lines.join('\n') };
}

function runShow(io: ToolsCommandIo, rest: readonly string[], json: boolean): ToolsCommandResult {
  const target = rest[0];
  if (target === undefined) {
    return { exitCode: 1, output: `show 需要参数（工具名或工具集名）\n\n${TOOLS_COMMAND_USAGE}` };
  }
  const set = getToolset(target);
  const inventoryEntry = buildToolInventory(io.registry).entries.find((e) => e.name === target);
  if (set !== undefined) {
    const available = io.registry.list().map((d) => d.name);
    const members = resolveToolsetNames(set.name, available);
    const missing = missingToolsetEntries(set.name, available);
    const selection = currentSelection(io);
    if (json) {
      return {
        exitCode: 0,
        action: 'show',
        output: JSON.stringify({ kind: 'toolset', ...set, resolved: members, missing }, null, 2),
      };
    }
    const lines = [
      `工具集 ${set.name}`,
      `  说明: ${set.summary}`,
      `  声明成员: ${set.tools.join(', ')}`,
      `  当前命中 (${members.length}): ${members.length > 0 ? members.join(', ') : '（无）'}`,
      `  当前缺席 (${missing.length}): ${missing.length > 0 ? missing.join(', ') : '（无）'}`,
      `  是否生效: ${selection.toolset === set.name ? '是（config.tools.toolset）' : '否'}`,
    ];
    return { exitCode: 0, action: 'show', output: lines.join('\n') };
  }
  if (inventoryEntry === undefined) {
    return {
      exitCode: 1,
      output: `未找到工具或工具集: ${target}（可用工具集: ${TOOLSETS.map((t) => t.name).join(' / ')}）`,
    };
  }
  if (json) {
    return { exitCode: 0, action: 'show', output: JSON.stringify({ kind: 'tool', ...inventoryEntry }, null, 2) };
  }
  const selection = currentSelection(io);
  const on = selection.enabled.includes(inventoryEntry.name);
  const lines = [
    `工具 ${inventoryEntry.name}`,
    `  分类: ${CATEGORY_LABELS[inventoryEntry.category] ?? inventoryEntry.category}（${inventoryEntry.category}）`,
    `  来源: ${inventoryEntry.source}`,
    `  并发安全: ${inventoryEntry.concurrencySafe ? '是' : '否'}`,
    `  当前状态: ${on ? '启用' : '禁用'}`,
    `  说明: ${inventoryEntry.description}`,
    `  所属工具集: ${toolsetsContaining(inventoryEntry.name).join(', ') || '（无）'}`,
  ];
  return { exitCode: 0, action: 'show', output: lines.join('\n') };
}

/** 一个工具被哪些工具集收录（show 的辅助视图；前缀通配按名字匹配） */
function toolsetsContaining(toolName: string): string[] {
  return TOOLSETS.filter((t) => resolveToolsetNames(t.name, [toolName]).length > 0).map((t) => t.name);
}

function runSelect(io: ToolsCommandIo, rest: readonly string[]): ToolsCommandResult {
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const positional = rest.filter((a) => !a.startsWith('--'));
  const name = positional[0];
  if (name === undefined) {
    return { exitCode: 1, output: `select 需要工具集名\n\n${TOOLS_COMMAND_USAGE}` };
  }
  if (getToolset(name) === undefined) {
    return { exitCode: 1, output: `未知工具集 "${name}"（可用: ${TOOLSETS.map((t) => t.name).join(' / ')}）` };
  }
  const next: ToolSelectionConfig = { ...(io.current ?? {}), toolset: name };
  const configPath = io.configPath;
  const dryRun = flags.has('--dry-run') || configPath === undefined;
  if (dryRun) {
    return {
      exitCode: 0,
      action: 'select',
      selection: next,
      output:
        `工具集 ${name} 已选（未落盘${flags.has('--dry-run') ? ': --dry-run' : ': 未提供 configPath'}）。` +
        `写入 config.json 的片段:\n${JSON.stringify({ tools: { toolset: name } }, null, 2)}`,
    };
  }
  let changed: boolean;
  try {
    changed = writeToolsetToConfigFile(configPath, name);
  } catch (e) {
    return { exitCode: 1, output: `写入配置失败: ${(e as Error)?.message ?? String(e)}` };
  }
  return {
    exitCode: 0,
    action: 'select',
    selection: next,
    output: `工具集 ${name} 已写入 ${configPath}${changed ? '' : '（值未变化）'}；下次装配生效`,
  };
}

/**
 * 把 `tools.toolset` 写入 config.json（JSONC 保注释改写）。
 * 只修改该键所在的文本范围，其余内容逐字节保留；文件不存在 → 抛错（不凭空造配置）。
 */
export function writeToolsetToConfigFile(configPath: string, toolset: string): boolean {
  if (!existsSync(configPath)) {
    throw new Error(`配置文件不存在: ${configPath}（先用 harness2 config 初始化，或手动创建）`);
  }
  const text = readFileSync(configPath, 'utf8');
  const formattingOptions: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };
  const edits = modify(text, ['tools', 'toolset'], toolset, { formattingOptions });
  if (edits.length === 0) return false;
  const updated = applyEdits(text, edits);
  if (updated === text) return false; // 值已相同：jsonc-parser 仍会给一个等价 edit，这里按内容判定
  writeFileSync(configPath, updated, 'utf8');
  return true;
}
