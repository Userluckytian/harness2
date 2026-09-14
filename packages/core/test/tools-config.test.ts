// H-30 工具面 + H-31 工具集系统测试（P7-C）。
//
// 覆盖：
//   - 工具盘点（数量/分类/来源，可复核）；
//   - 逐工具启禁（tools.enable）与工具集（tools.toolset）的组合语义——「谁覆盖谁」逐条钉死；
//   - `harness2 tools list/show/select` 命令面（含 JSONC 保注释落盘）；
//   - config.tools 段的 schema 校验（加性字段：缺省不出现，非法值报错）。
//
// 测试用的宿主注册表刻意用**哑工具定义**补齐 memory/skill/browser_*/subagent_*/mcp__ 名字，
// 不 import 记忆/技能模块——那两处归并行棒次，本文件只依赖 tools/** 与 config/schema。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { runTurn } from '../src/agent/loop.js';
import { parseConfig } from '../src/config/schema.js';
import { MockProvider } from '../src/provider/mock.js';
import { SessionManager } from '../src/session/manager.js';
import { loadSession } from '../src/session/reader.js';
import { buildToolInventory, classifyTool, toolSource, TOOL_CATEGORIES } from '../src/tools/inventory.js';
import { TOOLS_COMMAND_USAGE, runToolsCommand, writeToolsetToConfigFile } from '../src/tools/manage.js';
import { registerBuiltinTools } from '../src/tools/predefined/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { applyToolSelection, resolveEnabledToolNames, selectTools } from '../src/tools/selection.js';
import type { ToolDefinition } from '../src/tools/types.js';
import {
  TOOLSETS,
  TOOLSET_NAMES,
  getToolset,
  missingToolsetEntries,
  resolveToolsetNames,
} from '../src/tools/toolsets.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-tools-cfg-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 哑工具（只提供名字与描述，用于把工具面补全到"全来源"形态） */
function dummy(name: string): ToolDefinition {
  return {
    name,
    description: `dummy ${name}`,
    parameters: { type: 'object', properties: {} },
    execute: () => ({ output: `${name}-ok` }),
  };
}

/** 全来源宿主注册表：builtin 6 + memory/skill/skill_author + browser_* 6 + subagent 2 + fanout + script + mcp + 插件 */
function fullRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  for (const name of [
    'memory',
    'skill',
    'skill_author',
    'subagent_start',
    'subagent_continue',
    'subagent_fanout',
    'run_script',
    'mcp__demo__ping',
    'third_party_tool',
  ]) {
    registry.register(dummy(name));
  }
  for (const name of [
    'browser_navigate',
    'browser_click',
    'browser_type',
    'browser_snapshot',
    'browser_screenshot',
    'browser_close',
  ]) {
    registry.register(dummy(name));
  }
  return registry;
}

/** 只含内置六件套的最小注册表（工具集求交用例用） */
function builtinRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  return registry;
}

describe('H-30 工具盘点（数量与分类）', () => {
  it('全来源注册表：数量、分类、来源三者同源且可逐条核对', () => {
    const registry = fullRegistry();
    const inv = buildToolInventory(registry);
    // builtin 6 + dummy 9 + browser 6 = 21
    expect(registry.size).toBe(21);
    expect(inv.total).toBe(21);
    expect(inv.entries.map((e) => e.name)).toEqual(registry.list().map((d) => d.name)); // 顺序 = 注册顺序
    // 分类视图
    expect(inv.byCategory.file).toEqual(['read', 'write', 'edit']);
    expect(inv.byCategory.search).toEqual(['glob', 'grep']);
    expect(inv.byCategory.execute).toEqual(['bash']);
    expect(inv.byCategory.script).toEqual(['run_script']);
    expect(inv.byCategory.memory).toEqual(['memory']);
    expect(inv.byCategory.skill).toEqual(['skill', 'skill_author']);
    expect(inv.byCategory.subagent).toEqual(['subagent_start', 'subagent_continue', 'subagent_fanout']);
    expect(inv.byCategory.network).toEqual([
      'browser_navigate',
      'browser_click',
      'browser_type',
      'browser_snapshot',
      'browser_screenshot',
      'browser_close',
    ]);
    expect(inv.byCategory.mcp).toEqual(['mcp__demo__ping']);
    expect(inv.byCategory.plugin).toEqual(['third_party_tool']);
    // 每个分类都出现在视图里（空分类也要能枚举——报告不靠猜）
    for (const c of TOOL_CATEGORIES) expect(inv.byCategory[c]).toBeDefined();
    // 来源计数
    expect(inv.bySource).toEqual({
      builtin: 6,
      browser: 6,
      memory: 1,
      skill: 2, // skill + skill_author（P2-1 登记后不再误报为 plugin）
      subagent: 3,
      script: 1,
      mcp: 1,
      plugin: 1,
    });
  });

  it('分类/来源的兜底规则：mcp__ 前缀 → mcp；browser_ 前缀 → network/browser；未登记名 → plugin', () => {
    expect(classifyTool('mcp__srv__do')).toBe('mcp');
    expect(classifyTool('browser_type')).toBe('network');
    expect(classifyTool('bash')).toBe('execute');
    expect(classifyTool('nobody_knows')).toBe('plugin');
    expect(toolSource('mcp__srv__do')).toBe('mcp');
    expect(toolSource('browser_type')).toBe('browser');
    expect(toolSource('subagent_fanout')).toBe('subagent');
    expect(toolSource('nobody_knows')).toBe('plugin');
  });

  it('concurrencySafe 透传（工具自带并发声明不被盘点丢失）', () => {
    const registry = new ToolRegistry();
    registry.register({ ...dummy('safe_one'), concurrencySafe: true });
    registry.register(dummy('unsafe_one'));
    const inv = buildToolInventory(registry);
    expect(inv.entries.find((e) => e.name === 'safe_one')?.concurrencySafe).toBe(true);
    expect(inv.entries.find((e) => e.name === 'unsafe_one')?.concurrencySafe).toBe(false);
  });
});

describe('H-30 逐工具启禁的运行时过滤', () => {
  it('缺省（无 tools 段）= 全量启用：行为与 P7 之前一致（零回归）', () => {
    const registry = fullRegistry();
    const result = selectTools(registry);
    expect(result.enabled).toEqual(registry.list().map((d) => d.name));
    expect(result.disabled).toEqual([]);
    expect(result.registry.size).toBe(registry.size);
    expect(result.toolset).toBeUndefined();
  });

  it('enable=false 逐工具禁用：过滤后的注册表取不到（不可被调用），其余工具不受影响', () => {
    const filtered = applyToolSelection(fullRegistry(), { enable: { bash: false, mcp__demo__ping: false } });
    expect(filtered.get('bash')).toBeUndefined();
    expect(filtered.get('mcp__demo__ping')).toBeUndefined();
    expect(filtered.get('read')).toBeDefined();
    expect(filtered.size).toBe(19);
    // 原注册表不被修改（共享注册表可多会话复用）
    const original = fullRegistry();
    expect(original.get('bash')).toBeDefined();
  });

  it('enable 指向未注册工具：禁用静默接受，启用计入 unknownEnable（如实上报不静默）', () => {
    const { unknownEnable } = resolveEnabledToolNames(['read', 'bash'], {
      enable: { read: true, ghost_tool: true, not_registered: false },
    });
    expect(unknownEnable).toEqual(['ghost_tool']);
  });
});

describe('H-31 工具集（成套分发）', () => {
  it('工具集定义完备：名称唯一、每个都有说明与成员', () => {
    const names = TOOLSETS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...TOOLSET_NAMES]);
    for (const t of TOOLSETS) {
      expect(t.summary.length).toBeGreaterThan(0);
      expect(t.tools.length).toBeGreaterThan(0);
    }
  });

  it('read-only 工具集：只留只读工具；写/执行/子代理全被剔除', () => {
    const registry = fullRegistry();
    // read-only 需要 browser_snapshot/screenshot 在场才命中，这里全来源注册表包含它们
    const filtered = applyToolSelection(registry, { toolset: 'read-only' });
    const names = filtered.list().map((d) => d.name);
    expect(names).toEqual(['read', 'glob', 'grep', 'skill', 'browser_snapshot', 'browser_screenshot']);
    for (const forbidden of ['bash', 'write', 'edit', 'subagent_start', 'subagent_fanout', 'run_script', 'memory']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('工具集按「已注册名」求交：缺席成员不报错，但可查询（missingToolsetEntries）', () => {
    const available = builtinRegistry()
      .list()
      .map((d) => d.name);
    // coding 里的 skill/skill_author/run_script 未注册 → 只命中 builtin 部分（顺序 = 注册顺序）
    expect(resolveToolsetNames('coding', available)).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep']);
    expect(missingToolsetEntries('coding', available)).toEqual(['skill', 'skill_author', 'run_script']);
    expect(missingToolsetEntries('read-only', available)).toEqual(['skill', 'browser_snapshot', 'browser_screenshot']);
  });

  // P2-1：skill_author 曾不在任何工具集 → 选具体工具集被静默剔除（且来源误报 plugin）
  it('P2-1 skill_author：分类/来源正确，且 coding/research 工具集保留它（read-only 仍剔除）', () => {
    expect(classifyTool('skill_author')).toBe('skill');
    expect(toolSource('skill_author')).toBe('skill');
    const available = fullRegistry()
      .list()
      .map((d) => d.name);
    expect(resolveToolsetNames('coding', available)).toContain('skill_author');
    expect(resolveToolsetNames('research', available)).toContain('skill_author');
    expect(resolveToolsetNames('read-only', available)).not.toContain('skill_author');
    expect(resolveToolsetNames('ops', available)).not.toContain('skill_author');
    // 分类视图也把它记在 skill 类（不再是 plugin）
    const inv = buildToolInventory(fullRegistry());
    expect(inv.byCategory.skill).toContain('skill_author');
    expect(inv.byCategory.plugin).not.toContain('skill_author');
  });

  it('research 工具集含子代理与记忆；ops 工具集含浏览器与脚本（按已注册名求交）', () => {
    const available = fullRegistry()
      .list()
      .map((d) => d.name);
    const research = resolveToolsetNames('research', available);
    expect(research).toContain('memory');
    expect(research).toContain('subagent_fanout');
    expect(research).toContain('browser_navigate');
    expect(research).toContain('skill_author'); // P2-1：经验造技能属调研场景
    expect(research).not.toContain('bash');
    const ops = resolveToolsetNames('ops', available);
    expect(ops).toContain('bash');
    expect(ops).toContain('run_script');
    expect(ops).toContain('browser_close');
  });

  it('all 工具集 = 全量放行（含 MCP/插件工具）', () => {
    const registry = fullRegistry();
    const filtered = applyToolSelection(registry, { toolset: 'all' });
    expect(filtered.size).toBe(registry.size);
    expect(filtered.get('mcp__demo__ping')).toBeDefined();
    expect(filtered.get('third_party_tool')).toBeDefined();
  });

  it('未知工具集名：配置层报错用 TOOLSET_NAMES 提示；直接调用快速失败', () => {
    expect(() => resolveToolsetNames('nope', ['read'])).toThrow(/unknown toolset/);
    expect(getToolset('nope')).toBeUndefined();
    expect(getToolset('read-only')?.name).toBe('read-only');
  });
});

describe('H-31 组合语义（谁覆盖谁）', () => {
  it('enable=true 覆盖 toolset：工具集没选的工具被加回来', () => {
    const result = selectTools(fullRegistry(), { toolset: 'read-only', enable: { bash: true } });
    expect(result.enabled).toContain('bash');
    expect(result.enabled).toContain('read');
    expect(result.enabled).not.toContain('write');
    expect(result.toolset).toBe('read-only');
  });

  it('enable=false 覆盖 toolset（含 all）：即使 all 选中也剔除', () => {
    const result = selectTools(fullRegistry(), { toolset: 'all', enable: { bash: false, third_party_tool: false } });
    expect(result.enabled).not.toContain('bash');
    expect(result.enabled).not.toContain('third_party_tool');
    expect(result.enabled).toContain('read');
    expect(result.disabled).toEqual(['bash', 'third_party_tool']);
  });

  it('逐工具 > 工具集 > 缺省全量：同一张表逐条钉死优先级', () => {
    const registry = fullRegistry();
    const available = registry.list().map((d) => d.name);
    // 1) 无配置 → 全量
    expect(resolveEnabledToolNames(available, {}).enabled).toEqual(available);
    // 2) 只给 toolset → 工具集子集
    const setOnly = resolveEnabledToolNames(available, { toolset: 'coding' });
    expect(setOnly.disabled).toContain('subagent_start');
    // 3) toolset + enable → enable 赢
    const both = resolveEnabledToolNames(available, {
      toolset: 'coding',
      enable: { subagent_start: true, edit: false },
    });
    expect(both.enabled).toContain('subagent_start');
    expect(both.enabled).not.toContain('edit');
  });

  it('过滤后的注册表就是模型可见工具面（顺序保持注册顺序）', () => {
    const registry = fullRegistry();
    const filtered = applyToolSelection(registry, { toolset: 'read-only', enable: { bash: true } });
    expect(filtered.list().map((d) => d.name)).toEqual([
      'bash',
      'read',
      'glob',
      'grep',
      'skill',
      'browser_snapshot',
      'browser_screenshot',
    ]);
  });
});

describe('H-31 `harness2 tools` 命令（list/show/select）', () => {
  it('list：输出工具数量、逐工具启禁标记与工具集清单', () => {
    const io = { registry: fullRegistry(), current: { toolset: 'read-only' as const, enable: { bash: true } } };
    const r = runToolsCommand(['list'], io);
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('list');
    expect(r.output).toContain('工具 21 个');
    expect(r.output).toContain('启用 7 / 禁用 14');
    expect(r.output).toContain('工具集 read-only');
    expect(r.output).toContain('文件: read [on]  write [off]  edit [off]');
    expect(r.output).toContain('bash [on]');
    expect(r.output).toContain('工具集 5 个:');
    for (const name of TOOLSET_NAMES) expect(r.output).toContain(name);
  });

  it('list --json：机器可读（数量/启禁/分类/来源/工具集全在）', () => {
    const r = runToolsCommand(['list', '--json'], { registry: builtinRegistry() });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.output) as {
      total: number;
      enabled: string[];
      byCategory: Record<string, string[]>;
      bySource: Record<string, number>;
      toolsets: unknown[];
    };
    expect(parsed.total).toBe(6);
    expect(parsed.enabled).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep']);
    expect(parsed.byCategory['file']).toEqual(['read', 'write', 'edit']);
    expect(parsed.bySource['builtin']).toBe(6);
    expect(parsed.toolsets).toHaveLength(TOOLSETS.length);
  });

  it('show：单个工具详情与工具集成员/缺席视图；未知名退出码 1', () => {
    const registry = fullRegistry();
    const tool = runToolsCommand(['show', 'bash'], { registry });
    expect(tool.exitCode).toBe(0);
    expect(tool.output).toContain('工具 bash');
    expect(tool.output).toContain('分类: 执行（execute）');
    expect(tool.output).toContain('来源: builtin');
    expect(tool.output).toContain('当前状态: 启用');

    const set = runToolsCommand(['show', 'read-only'], { registry });
    expect(set.exitCode).toBe(0);
    expect(set.output).toContain('工具集 read-only');
    expect(set.output).toContain('当前命中 (6): read, glob, grep, skill, browser_snapshot, browser_screenshot');

    const missing = runToolsCommand(['show', 'coding'], { registry: builtinRegistry() });
    expect(missing.output).toContain('当前缺席 (3): skill, skill_author, run_script');

    const unknown = runToolsCommand(['show', 'nope'], { registry });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.output).toContain('未找到工具或工具集');
  });

  it('select --dry-run：不落盘，只打印片段；未知工具集/缺参数退出码 1', () => {
    const r = runToolsCommand(['select', 'ops', '--dry-run'], { registry: fullRegistry() });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('select');
    expect(r.selection).toEqual({ toolset: 'ops' });
    expect(r.output).toContain('"toolset": "ops"');
    expect(r.output).toContain('--dry-run');
    expect(runToolsCommand(['select', 'nope'], { registry: fullRegistry() }).exitCode).toBe(1);
    expect(runToolsCommand(['select'], { registry: fullRegistry() }).exitCode).toBe(1);
    expect(runToolsCommand(['nope'], { registry: fullRegistry() }).output).toBe(
      `未知子命令 "nope"\n\n${TOOLS_COMMAND_USAGE}`,
    );
  });

  it('select 落盘：JSONC 保注释改写 tools.toolset，parseConfig 能吃下结果', () => {
    const dir = tmpDir();
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      [
        '// harness2 配置（注释必须被保留）',
        '{',
        '  "providers": { "a": { "protocol": "openai", "baseUrl": "https://x" } },',
        '  "roles": { "main": { "channel": "a", "model": "m" } },',
        '  "memory": { "mode": "off", "nudgeInterval": 10 }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const r = runToolsCommand(['select', 'read-only'], { registry: fullRegistry(), configPath });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(`已写入 ${configPath}`);
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('// harness2 配置（注释必须被保留）');
    expect(text).toContain('"read-only"');
    // 结果必须仍是合法配置：tools.toolset 生效（JSONC 解析，注释已在上面单独断言保留）
    const parsed = parseConfig(parseJsonc(text, [], { allowTrailingComma: true }));
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.tools).toEqual({ toolset: 'read-only' });
    // 幂等：再选一次值不变
    const again = runToolsCommand(['select', 'read-only'], { registry: fullRegistry(), configPath });
    expect(again.exitCode).toBe(0);
    expect(readFileSync(configPath, 'utf8')).toBe(text);
  });

  it('writeToolsetToConfigFile：文件不存在 → 明确报错（不凭空造配置）', () => {
    const dir = tmpDir();
    expect(() => writeToolsetToConfigFile(join(dir, 'none.json'), 'all')).toThrow(/配置文件不存在/);
    expect(existsSync(join(dir, 'none.json'))).toBe(false);
  });
});

describe('config.tools 段（加性字段）', () => {
  const BASE = {
    providers: { a: { protocol: 'openai', baseUrl: 'https://x' } },
    roles: { main: { channel: 'a', model: 'm' } },
  };

  it('缺省：config 上不出现 tools（旧字面量/快照零变化）', () => {
    const r = parseConfig({ ...BASE });
    expect(r.errors).toEqual([]);
    expect(r.config?.tools).toBeUndefined();
    expect(Object.hasOwn(r.config ?? {}, 'tools')).toBe(false);
  });

  it('合法段：toolset + enable 解析进 config.tools', () => {
    const r = parseConfig({ ...BASE, tools: { toolset: 'coding', enable: { bash: false, mcp__x__y: true } } });
    expect(r.errors).toEqual([]);
    expect(r.config?.tools).toEqual({ toolset: 'coding', enable: { bash: false, mcp__x__y: true } });
  });

  it('非法值报错：未知工具集名 / 非法工具名 / 非布尔值 / 非对象', () => {
    const bad1 = parseConfig({ ...BASE, tools: { toolset: 'nope' } });
    expect(bad1.config).toBeNull();
    expect(bad1.errors.some((e) => e.includes('tools.toolset 必须是'))).toBe(true);

    const bad2 = parseConfig({ ...BASE, tools: { enable: { 'Bad-Name': true } } });
    expect(bad2.errors.some((e) => e.includes('必须是合法工具名'))).toBe(true);

    const bad3 = parseConfig({ ...BASE, tools: { enable: { bash: 'yes' } } });
    expect(bad3.errors.some((e) => e.includes('tools.enable.bash 必须是布尔值'))).toBe(true);

    const bad4 = parseConfig({ ...BASE, tools: 'coding' });
    expect(bad4.errors).toContain('config.tools 必须是对象');
  });

  it('未知子键告警但不致命（与 config 其余段的未知字段口径一致）', () => {
    const r = parseConfig({ ...BASE, tools: { toolset: 'all', wat: 1 } });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes('tools: 未知字段 "wat"'))).toBe(true);
  });

  it('端到端：config.tools → selectTools 的真过滤结果（配置驱动，行为可复核）', () => {
    const registry = fullRegistry();
    const parsed = parseConfig({
      ...BASE,
      tools: { toolset: 'read-only', enable: { bash: true, read: false } },
    });
    expect(parsed.errors).toEqual([]);
    const result = selectTools(registry, parsed.config?.tools ?? {});
    expect(result.enabled).toEqual(['bash', 'glob', 'grep', 'skill', 'browser_snapshot', 'browser_screenshot']);
    expect(result.disabled).toContain('read');
  });

  it('tools 段与 approval.tools 各管一摊（一个管"能不能调"，一个管"要不要问"）', () => {
    const r = parseConfig({
      ...BASE,
      approval: { mode: 'default', tools: { bash: 'ask' } },
      tools: { enable: { bash: false } },
    });
    expect(r.errors).toEqual([]);
    expect(r.config?.approval.tools).toEqual({ bash: 'ask' });
    expect(r.config?.tools).toEqual({ enable: { bash: false } });
  });
});

describe('工具集 × 会话装配的接线缝（core 侧可用性）', () => {
  it('applyToolSelection 返回新注册表：可用于替换装配层的 tools 入参', () => {
    const registry = fullRegistry();
    const filtered = applyToolSelection(registry, { toolset: 'coding' });
    expect(filtered).not.toBe(registry);
    expect(registry.get('edit')).toBeDefined(); // 原表不动
    expect(filtered.get('edit')).toBeDefined();
    expect(filtered.get('write')).toBeDefined();
    expect(filtered.get('subagent_start')).toBeUndefined();
  });

  it('端到端运行时：禁用的工具不进 ChatRequest.tools，且模型硬调也执行不了（unknown tool）', async () => {
    const root = tmpDir();
    const manager = new SessionManager(join(root, 'sessions'));
    const registry = new ToolRegistry();
    registerBuiltinTools(registry); // bash 在列
    const filtered = applyToolSelection(registry, { enable: { bash: false } });
    const provider = new MockProvider([
      // 模型无视工具表，硬调被禁的 bash
      { toolCalls: [{ id: 'c1', name: 'bash', arguments: '{"command":"echo hi"}' }] },
      { text: 'done' },
    ]);
    const session = manager.create(root, { fsync: false });
    const result = await runTurn(session.writer, {
      provider,
      tools: filtered,
      cwd: root,
      userText: 'go',
      maxSteps: 4,
    });
    session.writer.close();
    expect(result.stopReason).toBe('end_turn');
    // ① 模型可见工具面：没有 bash，其余内置工具在
    const names = (provider.requests[0]?.tools ?? []).map((t) => t.name);
    expect(names).not.toContain('bash');
    expect(names).toContain('read');
    // ② 调用面：被禁工具查不到 → unknown tool（不可被调用）
    const tr = loadSession(session.dir).events.find((e) => e.event.type === 'tool/result')!;
    expect(tr.event.payload).toMatchObject({ tool: 'bash', ok: false });
    expect((tr.event.payload as { error: string }).error).toContain('unknown tool: bash');
  });
});
