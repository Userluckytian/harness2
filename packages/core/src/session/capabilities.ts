// H-11～H-14 的**可发现入口**（三壳可用性的 core 侧半边）。
//
// 为什么单独放这里：本仓铁律 `refs-hermes-agent.md` H-70 —— 斜杠命令分「本地处理」与
// 「下沉内核」两层，壳只拦真正需要 UI 的。H-11～H-14 全是内核能力，命令面必须先落在 core，
// 否则 CLI/桌面/web 三份命令表会分叉。本文件提供：
//   ① SESSION_CAPABILITY_COMMANDS —— 会话域能力命令的元数据 + 核心落点（供壳注册与
//      `/capabilities` 对账；与 commands/catalog.ts 的 CoreCommandMeta 同形态，壳一行映射）；
//   ② runSessionCapability —— 各命令的 core 实现（纯文本输出，与 commands/handlers.ts 同风格，
//      不 import 任何 UI/ANSI/终端概念）。
//
// 分工：命令编排（读取参数、打印、错误行 'error: ' 前缀）在本文件；能力实现留在各自模块
// （searchIndex / layeredCompaction / portability / titles），本文件不含第二套算法。
// 模型调用一律注入（summarizer/refiner）；未注入即按各模块既有口径如实降级。
import { basename } from 'node:path';
import {
  applyLayeredCompaction,
  planLayeredCompaction,
  type CompactionRefiner,
  type LayeredCompactionOptions,
} from './layeredCompaction.js';
import type { SessionManager } from './manager.js';
import { importSession, type ImportSessionOptions } from './portability.js';
import { summarizeSearchResults, type SearchHitSummarizer } from './searchIndex.js';
import { loadSession } from './reader.js';
import type { TitleRefiner } from './titles.js';
import type { SessionAppender } from './writer.js';

/** 会话域能力命令元数据（group 取值与 commands/types.ts CoreCommandGroup 对齐的会话/上下文两组） */
export interface SessionCapabilityCommand {
  /** 命令 id（不含 /） */
  id: string;
  group: '会话' | '上下文';
  summary: string;
  argsSpec?: string;
  /** 对应能力编号（H-1x；对账 refs-hermes-agent.md 用） */
  capability: 'H-11' | 'H-12' | 'H-13' | 'H-14' | 'H-11+H-14';
  /** 核心落点（模块 + 导出名），供文档/审查核对，不参与运行 */
  entry: string;
}

export const SESSION_CAPABILITY_COMMANDS: readonly SessionCapabilityCommand[] = [
  {
    id: 'search',
    group: '会话',
    summary: '索引化全文检索会话（分词命中，默认全部命中）',
    argsSpec: '<查询> [--or] [--limit N]',
    capability: 'H-11',
    entry: 'session/searchIndex.ts#SessionSearchIndex.search',
  },
  {
    id: 'reindex',
    group: '会话',
    summary: '重建会话检索索引（派生物，可随时重建）',
    capability: 'H-11',
    entry: 'session/manager.ts#SessionManager.reindex',
  },
  {
    id: 'import',
    group: '会话',
    summary: '导入会话导出包（zip，含子会话；版本迁移与坏行容错）',
    argsSpec: '<zip 路径> [--overwrite] [--dry-run]',
    capability: 'H-13',
    entry: 'session/portability.ts#importSession',
  },
  {
    id: 'title',
    group: '会话',
    summary: '查看/设置/自动生成会话标题（/title [<标题>|--auto]）',
    argsSpec: '[<标题>|--auto]',
    capability: 'H-14',
    entry: 'session/titles.ts#autoTitleSession',
  },
  {
    id: 'compact-layers',
    group: '上下文',
    summary: '按分层压缩（turn → session）执行一次压缩并展示分层产物',
    argsSpec: '[turn|session]',
    capability: 'H-12',
    entry: 'session/layeredCompaction.ts#applyLayeredCompaction',
  },
];

/** 命令执行缝（壳注入；与 commands/types.ts CoreCommandContext 同构的最小子集） */
export interface SessionCapabilityContext {
  manager: SessionManager;
  /** 会话分组/检索的 cwd */
  cwd: string;
  /** 输出一行纯文本（error 行以 'error: ' 开头） */
  print(text: string): void;
  /** 当前活动会话（无则 null） */
  current(): { id: string; writer: SessionAppender } | null;
  /** 检索结果摘要注入（H-11 的 LLM 摘要半边；未注入 = 原文片段降级） */
  summarizeSearch?: SearchHitSummarizer;
  /** 标题精炼注入（H-14；未注入 = 启发式） */
  refineTitle?: TitleRefiner;
  /** 压缩精炼注入（H-12 第 2 层；未注入 = 确定性摘要） */
  refineCompaction?: CompactionRefiner;
  /** 当前上下文占用（0..1，唯一算法 getContextUsage）；/compact-layers 阈值判定用 */
  contextUsage?(): number | undefined;
}

/** 解析 `--flag` 布尔与 `--key value` 取值（未知 flag 忽略并如实登记） */
function parseFlags(rest: string): { positional: string[]; flags: Set<string>; values: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const parts = rest.split(/\s+/).filter((s) => s.length > 0);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part.startsWith('--')) {
      positional.push(part);
      continue;
    }
    const name = part.slice(2);
    const next = parts[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(name, next);
      i += 1;
    } else {
      flags.add(name);
    }
  }
  return { positional, flags, values };
}

/** `/search <查询> [--or] [--limit N]` */
async function runSearch(ctx: SessionCapabilityContext, rest: string): Promise<void> {
  const { positional, flags, values } = parseFlags(rest);
  const query = positional.join(' ');
  if (query.length === 0) {
    ctx.print('error: 用法 /search <查询> [--or] [--limit N]');
    return;
  }
  const limitRaw = values.get('limit');
  const limit = limitRaw !== undefined && /^\d+$/.test(limitRaw) ? Number(limitRaw) : undefined;
  const hits = ctx.manager.searchIndexed(ctx.cwd, query, {
    ...(flags.has('or') ? { mode: 'or' as const } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  if (hits.length === 0) {
    ctx.print(`无命中：${query}`);
    return;
  }
  ctx.print(`命中 ${hits.length} 个会话（查询：${query}）`);
  for (const hit of hits) {
    const label = hit.title !== undefined && hit.title.length > 0 ? `${hit.title}（${hit.id}）` : hit.id;
    ctx.print(`- ${label}`);
    for (const h of hit.hits) ctx.print(`    [${h.role}@${h.seq}] ${h.snippet}`);
  }
  // 摘要行始终输出：注入方产出 → LLM 摘要；未注入/失败 → 如实降级说明（不伪造摘要）
  const summary = await summarizeSearchResults(
    query,
    hits.flatMap((h) => h.hits.map((x) => ({ sessionId: h.id, snippet: x.snippet }))),
    ctx.summarizeSearch !== undefined ? { summarizer: ctx.summarizeSearch } : {},
  );
  if (summary.source === 'llm') ctx.print(`摘要：${summary.summary}`);
  else ctx.print(`摘要：未生成（${summary.fallbackReason ?? '未注入摘要 provider'}），以上为命中原文片段`);
}

/** `/reindex` */
function runReindex(ctx: SessionCapabilityContext): void {
  const report = ctx.manager.reindex(ctx.cwd);
  ctx.print(`索引重建：${report.indexed}/${report.sessions} 个会话，共 ${report.messages} 条消息`);
  for (const failure of report.failures) ctx.print(`  ! ${failure.id}: ${failure.error}`);
}

/** `/import <zip> [--overwrite] [--dry-run]` */
function runImport(ctx: SessionCapabilityContext, rest: string): void {
  const { positional, flags } = parseFlags(rest);
  const zip = positional[0];
  if (zip === undefined) {
    ctx.print('error: 用法 /import <zip 路径> [--overwrite] [--dry-run]');
    return;
  }
  const opts: ImportSessionOptions = {
    targetRoot: ctx.manager.root,
    cwd: ctx.cwd,
    overwrite: flags.has('overwrite'),
    dryRun: flags.has('dry-run'),
  };
  try {
    const report = importSession(zip, opts);
    ctx.print(`导入 ${basename(zip)}：${report.sessions.length} 个会话（包内 ${report.entryCount} 条目）`);
    for (const s of report.sessions) {
      const migrated = s.migrated !== undefined ? ` 迁移 v${s.migrated.from}→v${s.migrated.to}` : '';
      ctx.print(`- ${s.id} [${s.status}] 事件 ${s.events}${s.badLines > 0 ? ` 坏行 ${s.badLines}` : ''}${migrated}`);
      for (const w of s.warnings) ctx.print(`    ! ${w}`);
    }
    for (const w of report.warnings) ctx.print(`! ${w}`);
  } catch (e) {
    ctx.print(`error: 导入失败：${(e as Error | undefined)?.message ?? String(e)}`);
  }
}

/** `/title [<标题>|--auto]` */
async function runTitle(ctx: SessionCapabilityContext, rest: string): Promise<void> {
  const { positional, flags } = parseFlags(rest);
  const current = ctx.current();
  if (current === null) {
    ctx.print('error: 无活动会话');
    return;
  }
  const manual = positional.join(' ').trim();
  try {
    if (manual.length > 0) {
      const written = ctx.manager.rename(current.id, manual, { cwd: ctx.cwd });
      ctx.print(`已设置标题：${written.title}`);
      return;
    }
    if (flags.has('auto')) {
      const result = await ctx.manager.autoTitle(current.id, {
        cwd: ctx.cwd,
        overwrite: true,
        ...(ctx.refineTitle !== undefined ? { refine: ctx.refineTitle } : {}),
      });
      ctx.print(`标题：${result.title.title}（${result.title.source}${result.reused ? '，复用既有' : ''}）`);
      if (result.refineFallbackReason !== undefined) {
        ctx.print(`提示：精炼未生效（${result.refineFallbackReason}），已用启发式标题`);
      }
      return;
    }
    const existing = ctx.manager.titleOf(current.id, { cwd: ctx.cwd });
    ctx.print(
      existing === null
        ? '标题：—（可用 /title --auto 生成或 /title <标题> 设置）'
        : `标题：${existing.title}（${existing.source}）`,
    );
  } catch (e) {
    ctx.print(`error: ${(e as Error | undefined)?.message ?? String(e)}`);
  }
}

/** `/compact-layers [turn|session]` */
async function runCompactLayers(ctx: SessionCapabilityContext, rest: string): Promise<void> {
  const { positional } = parseFlags(rest);
  const current = ctx.current();
  if (current === null) {
    ctx.print('error: 无活动会话');
    return;
  }
  const forced = positional[0];
  if (forced !== undefined && forced !== 'turn' && forced !== 'session') {
    ctx.print('error: 用法 /compact-layers [turn|session]');
    return;
  }
  const dir = current.writer.dir;
  const session = loadSession(dir);
  const usageRatio = ctx.contextUsage?.();
  const planOpts: LayeredCompactionOptions = {
    ...(usageRatio !== undefined ? { usageRatio } : {}),
    ...(forced !== undefined ? { layer: forced } : {}),
  };
  const plan = planLayeredCompaction(session, planOpts);
  if (plan === null) {
    ctx.print('未执行压缩：未达阈值或无可折叠区域（尾部保护优先）');
    return;
  }
  const result = await applyLayeredCompaction(current.writer, session, {
    ...planOpts,
    ...(ctx.refineCompaction !== undefined ? { refine: ctx.refineCompaction } : {}),
  });
  if (result === null) {
    ctx.print('未执行压缩：未达阈值或无可折叠区域（尾部保护优先）');
    return;
  }
  ctx.print(
    `已执行分层压缩（${result.layer} 层）：覆盖 seq ≤ ${result.coveredUpToSeq}，turn 明细 +${result.turnRecords} 条`,
  );
  if (result.refineFallbackReason !== undefined) {
    ctx.print(`提示：精炼未生效（${result.refineFallbackReason}），已用确定性摘要`);
  }
}

/**
 * 执行会话域能力命令；未识别的 id 返回 false（壳转交既有命令表，不抛错）。
 * 输出风格与 commands/handlers.ts 一致：普通行 + `error: ` 前缀错误行。
 */
export async function runSessionCapability(
  id: string,
  args: { rest: string },
  ctx: SessionCapabilityContext,
): Promise<boolean> {
  switch (id) {
    case 'search':
      await runSearch(ctx, args.rest);
      return true;
    case 'reindex':
      runReindex(ctx);
      return true;
    case 'import':
      runImport(ctx, args.rest);
      return true;
    case 'title':
      await runTitle(ctx, args.rest);
      return true;
    case 'compact-layers':
      await runCompactLayers(ctx, args.rest);
      return true;
    default:
      return false;
  }
}
