// A22 代码索引命令面：`/codeindex`（建索引 / 查符号定义 / 查引用 / 查看状态）。
//
// 走**既有能力面**（D02 命令注册开放化）：`registerCoreCommand` 注册为 source='extension' 的
// 扩展命令，随即进入 findCoreCommand / runCoreCommand 分发面与 describeCapabilities().commands
// ——CLI 与桌面经同一份能力面即可看到（GUI 渲染留后续批次）。与 A11 `/team`、A14 `/workflow` 同一缝。
// 不用内建目录（catalog.ts）：内建命令是各壳测试钉死的固定集合（34=29+5），扩展命令是
// core 既有的加性注册缝。
import { registerCoreCommand, unregisterCoreCommand } from '../commands/registry.js';
import type { CoreCommandContext } from '../commands/types.js';
import { symbolKindLabel } from './parser.js';
import { CodeIndexStore, MAX_QUERY_RESULTS, type CodeIndexOptions } from './store.js';
import type {
  DefinitionHit,
  IndexBuildStats,
  IndexStatus,
  IndexUpdateStats,
  QueryOptions,
  ReferenceHit,
} from './types.js';

/** 命令名（`/codeindex`） */
export const CODEINDEX_COMMAND_ID = 'codeindex';

/** 查询类子命令的选项（在 QueryOptions 上附加索引根）。 */
export interface CodeIndexQueryOptions extends QueryOptions {
  /** 索引根（缺省运行时 cwd） */
  root?: string;
}

/** 命令面运行时缝（宿主装配提供；缺省实现 = createCodeIndexRuntime，全走 core 真实索引）。 */
export interface CodeIndexRuntime {
  /** 全量重建指定根的索引 */
  rebuild(root?: string): IndexBuildStats;
  /** 增量更新指定根的索引 */
  update(root?: string): IndexUpdateStats;
  findDefinitions(name: string, opts?: CodeIndexQueryOptions): DefinitionHit[];
  findReferences(name: string, opts?: CodeIndexQueryOptions): ReferenceHit[];
  status(root?: string): IndexStatus;
}

/** 运行时构造选项。 */
export interface CodeIndexRuntimeOptions {
  /** 默认索引根（缺省 process.cwd()） */
  cwd?: string;
  /** 数据根（缺省 ~/.harness2 所在 home；测试注入） */
  home?: string;
  /** 按 root 推导索引文件路径（测试注入；缺省走全局数据根约定） */
  indexPathFor?: (root: string) => string;
  /** 单文件大小上限 */
  maxFileBytes?: number;
}

/** 创建 core 内置运行时（按 root 记忆 store；同一进程内懒加载 + 增量）。 */
export function createCodeIndexRuntime(options: CodeIndexRuntimeOptions = {}): CodeIndexRuntime {
  const cwd = options.cwd ?? process.cwd();
  const stores = new Map<string, CodeIndexStore>();
  const store = (root?: string): CodeIndexStore => {
    const absRoot = root !== undefined ? root : cwd;
    const key = absRoot;
    let existing = stores.get(key);
    if (existing === undefined) {
      const base: CodeIndexOptions = {
        root: absRoot,
        cwd,
        ...(options.home !== undefined ? { home: options.home } : {}),
      };
      if (options.maxFileBytes !== undefined) base.maxFileBytes = options.maxFileBytes;
      if (options.indexPathFor !== undefined) base.indexPath = options.indexPathFor(absRoot);
      existing = new CodeIndexStore(base);
      stores.set(key, existing);
    }
    return existing;
  };
  return {
    rebuild: (root) => store(root).rebuild(),
    update: (root) => store(root).update(),
    findDefinitions: (name, opts) => store(opts?.root).findDefinitions(name, opts),
    findReferences: (name, opts) => store(opts?.root).findReferences(name, opts),
    status: (root) => store(root).status(),
  };
}

const USAGE =
  '用法：/codeindex <rebuild|update|status|def <名称>|ref <名称>> [--root <路径>] [--limit N] [--prefix|--substring] [--case]';

/** 解析出的命令行选项。 */
interface ParsedArgs {
  sub: string;
  name?: string;
  root?: string;
  query: QueryOptions;
  error?: string;
}

function parseArgs(rest: string): ParsedArgs {
  const words = rest
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const sub = words[0] ?? 'status';
  const out: ParsedArgs = { sub, query: {} };
  const positional: string[] = [];
  let i = 1;
  while (i < words.length) {
    const w = words[i];
    if (w === '--root') {
      const v = words[i + 1];
      if (v === undefined) return { ...out, error: '--root 缺少路径参数' };
      out.root = v;
      i += 2;
      continue;
    }
    if (w === '--limit') {
      const v = words[i + 1];
      const n = v !== undefined ? Number(v) : NaN;
      if (!Number.isFinite(n) || n <= 0) return { ...out, error: '--limit 需要正整数值' };
      out.query.limit = Math.floor(n);
      i += 2;
      continue;
    }
    if (w === '--prefix') {
      out.query.match = 'prefix';
      i++;
      continue;
    }
    if (w === '--substring' || w === '--fuzzy') {
      out.query.match = 'substring';
      i++;
      continue;
    }
    if (w === '--case') {
      out.query.caseSensitive = true;
      i++;
      continue;
    }
    positional.push(w ?? '');
    i++;
  }
  if (sub === 'def' || sub === 'ref') {
    if (positional.length === 0) return { ...out, error: `${sub} 需要符号名称` };
    out.name = positional[0];
  }
  return out;
}

/** 单行定义/引用格式化（供命令面与后续 GUI 复用同一口径）。 */
export function formatDefinitionHit(hit: DefinitionHit): string {
  return `${hit.name}（${symbolKindLabel(hit.kind)}）${hit.file}:${hit.line}:${hit.column} — ${hit.text}`;
}

export function formatReferenceHit(hit: ReferenceHit): string {
  const mark = hit.isDefinition ? '[定义]' : '      ';
  return `${mark} ${hit.name} @ ${hit.file}:${hit.line}:${hit.column} — ${hit.text}`;
}

export function formatIndexStatus(status: IndexStatus): string[] {
  return [
    `索引根：${status.root}`,
    `索引文件：${status.indexPath}${status.exists ? '' : '（不存在）'}`,
    `已索引文件：${status.files}｜定义：${status.definitions}｜引用名称：${status.referenceNames}`,
    `构建时间：${status.builtAt || '（无）'}`,
  ];
}

/**
 * 执行 `/codeindex` 子命令（纯文本输出，错误行以 'error: ' 开头）。
 * 导出便于宿主自行分发时复用同一文案；`registerCodeIndexCommand` 内部亦调用它。
 */
export function runCodeIndexCommand(
  ctx: Pick<CoreCommandContext, 'print' | 'cwd'>,
  args: { rest: string },
  runtime: CodeIndexRuntime,
): void {
  const parsed = parseArgs(args.rest);
  if (parsed.error !== undefined) {
    ctx.print(`error: ${parsed.error}。${USAGE}`);
    return;
  }

  if (parsed.sub === 'rebuild') {
    const stats = runtime.rebuild(parsed.root);
    ctx.print(
      `重建完成：扫描 ${stats.scanned} 文件（解析 ${stats.parsed}，跳过 ${stats.skipped}），定义 ${stats.definitions}`,
    );
    ctx.print(`索引文件：${stats.indexPath}`);
    return;
  }

  if (parsed.sub === 'update') {
    const stats = runtime.update(parsed.root);
    ctx.print(
      `更新完成：新增 ${stats.added}，变更 ${stats.changed}，删除 ${stats.removed}，复用 ${stats.reused}（跳过 ${stats.skipped}），定义 ${stats.definitions}`,
    );
    ctx.print(`索引文件：${stats.indexPath}`);
    return;
  }

  if (parsed.sub === 'status') {
    for (const line of formatIndexStatus(runtime.status(parsed.root))) ctx.print(line);
    return;
  }

  if (parsed.sub === 'def') {
    const hits = runtime.findDefinitions(parsed.name ?? '', {
      ...parsed.query,
      ...(parsed.root !== undefined ? { root: parsed.root } : {}),
    });
    if (hits.length === 0) {
      ctx.print(`（未找到定义：${parsed.name ?? ''}）`);
      return;
    }
    for (const hit of hits) ctx.print(formatDefinitionHit(hit));
    maybeNoteTruncated(ctx, hits.length, parsed.query.limit ?? MAX_QUERY_RESULTS);
    return;
  }

  if (parsed.sub === 'ref') {
    const hits = runtime.findReferences(parsed.name ?? '', {
      ...parsed.query,
      ...(parsed.root !== undefined ? { root: parsed.root } : {}),
    });
    if (hits.length === 0) {
      ctx.print(`（未找到引用：${parsed.name ?? ''}）`);
      return;
    }
    for (const hit of hits) ctx.print(formatReferenceHit(hit));
    maybeNoteTruncated(ctx, hits.length, parsed.query.limit ?? MAX_QUERY_RESULTS);
    return;
  }

  ctx.print(`error: 未知子命令 ${parsed.sub}。${USAGE}`);
}

/** 结果数达到上限时提示可能被截断（缺省上限 = MAX_QUERY_RESULTS）。 */
function maybeNoteTruncated(ctx: Pick<CoreCommandContext, 'print'>, count: number, limit: number): void {
  if (count >= limit) ctx.print(`（已达上限 ${limit}，结果可能被截断）`);
}

/**
 * 注册 `/codeindex` 扩展命令（source='extension'），返回卸载 disposer。
 * 重复注册同名命令由命令注册表 fail-closed 抛错（不静默覆盖）。
 */
export function registerCodeIndexCommand(runtime: CodeIndexRuntime): () => void {
  registerCoreCommand({
    id: CODEINDEX_COMMAND_ID,
    group: '通用',
    summary: '代码符号索引（建索引/查定义/查引用/状态）',
    argsSpec:
      '<rebuild|update|status|def <名称>|ref <名称>> [--root <路径>] [--limit N] [--prefix|--substring] [--case]',
    run: (ctx, args) => runCodeIndexCommand(ctx, args, runtime),
  });
  return () => {
    unregisterCoreCommand(CODEINDEX_COMMAND_ID);
  };
}

/** 便捷：用 core 内置运行时（真实索引）注册命令，返回卸载 disposer。 */
export function registerDefaultCodeIndexCommand(options: CodeIndexRuntimeOptions = {}): () => void {
  const runtime = createCodeIndexRuntime(options);
  return registerCodeIndexCommand(runtime);
}
