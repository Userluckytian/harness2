// A22 符号索引存储与查询：全量重建 / 增量更新 / 容错读取 / 定义与引用查询。
//
// 落盘位置（尊重既有数据根约定，与 core 其他持久化同风格）：
//   ~/.harness2/codeindex/<encodeCwd(索引根)>/code.index.json
//   —— 复用 session/sessions 的 encodeCwd 纯字符串映射（跨平台一致）；home 可注入（--home/测试）。
//   索引放**全局数据根**而非项目内：不污染被索引的项目，也天然不被自身遍历（数据根在项目外）。
//   索引文件路径可显式注入（indexPath），测试全用临时目录，不触真实 ~/.harness2。
//
// 增量语义（按内容哈希 mtime/size 预筛）：
//   - stat.mtimeMs + size 与既有条目一致 → 直接复用（不读盘、不重解析）；
//   - 否则读盘算 sha1：哈希一致 → 仅刷新 mtime/size（不重解析）；不一致 → 重新解析；
//   - 磁盘上已消失/被改名的条目 → 从索引移除（改名 = 删 + 增，自动收敛）；
//   - 索引文件损坏/缺失/代际不符 → 回落**全量重建**，绝不抛错（派生索引允许丢弃重来）。
//
// 忽略规则：复用 tools/predefined/ignore.ts 的同一套语义（node_modules/.git 无条件排除 +
// 隐藏项（点开头）不进入），与 glob/grep 工具逐字一致；不解析 .gitignore（与 grep 的
// JS 回退同口径，已知差异见 ignore.ts 头注）。
//
// 查询：只读索引，行文本在查询时现读磁盘（索引不含源码正文，保持轻量）；结果按
// 文件/行/列排序并受上限截断（防爆）。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import fg from 'fast-glob';
import { encodeCwd } from '../session/manager.js';
import { EXCLUDED_GLOBS } from '../tools/predefined/ignore.js';
import { writeAtomic } from '../tools/predefined/common.js';
import { languageForFile, type LanguageSpec } from './languages.js';
import { parseSource } from './parser.js';
import {
  CODE_INDEX_FILE,
  CODE_INDEX_VERSION,
  type CodeIndexData,
  type DefinitionHit,
  type IndexBuildStats,
  type IndexedDefinition,
  type IndexedFile,
  type IndexStatus,
  type IndexUpdateStats,
  type QueryOptions,
  type ReferenceHit,
} from './types.js';

/** ~/.harness2 下的代码索引目录名 */
export const CODEINDEX_DIR_NAME = 'codeindex';

/** 查询结果默认上限（防爆） */
export const MAX_QUERY_RESULTS = 200;
/** 查询结果硬上限（opts.limit 超过即钳制） */
export const HARD_QUERY_LIMIT = 2000;
/** 单文件大小上限（与 grep 的 MAX_FILE_BYTES 对齐：1MB） */
export const MAX_INDEX_FILE_BYTES = 1024 * 1024;
/** 二进制探测窗口（与 grep 对齐：首 8KB 出现 NUL 视为二进制） */
const BINARY_SNIFF_BYTES = 8192;

/** 全局数据根下的代码索引目录 */
export function defaultCodeIndexRoot(home?: string): string {
  return join(home ?? homedir(), '.harness2', CODEINDEX_DIR_NAME);
}

/** 某索引根对应的索引文件路径（全局数据根 + encodeCwd）。 */
export function codeIndexFilePath(root: string, home?: string): string {
  return join(defaultCodeIndexRoot(home), encodeCwd(resolve(root)), CODE_INDEX_FILE);
}

/** 构造选项。 */
export interface CodeIndexOptions {
  /** 索引根目录（相对 cwd 时按 cwd 解析） */
  root: string;
  /** 数据根（缺省 ~/.harness2 所在 home；测试注入） */
  home?: string;
  /** 显式索引文件路径（优先于 root/home 推导；测试注入） */
  indexPath?: string;
  /** 解析相对 root/indexPath 的基点（缺省 process.cwd()） */
  cwd?: string;
  /** 单文件大小上限（缺省 MAX_INDEX_FILE_BYTES） */
  maxFileBytes?: number;
}

/** 形状校验（容错读取用；任一不符即视为损坏）。 */
function isValidIndex(value: unknown): value is CodeIndexData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['v'] !== CODE_INDEX_VERSION) return false;
  if (typeof v['root'] !== 'string') return false;
  if (typeof v['builtAt'] !== 'string') return false;
  const files = v['files'];
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return false;
  for (const entry of Object.values(files as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) return false;
    const f = entry as Record<string, unknown>;
    if (typeof f['language'] !== 'string' || typeof f['hash'] !== 'string') return false;
    if (!Array.isArray(f['definitions']) || typeof f['references'] !== 'object' || f['references'] === null) {
      return false;
    }
  }
  return true;
}

/** 容错读取索引：文件不存在/解析失败/代际不符/形状损坏一律返回 null（读取侧不抛）。 */
export function loadCodeIndex(indexPath: string): CodeIndexData | null {
  if (!existsSync(indexPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(indexPath, 'utf8'));
    return isValidIndex(parsed) ? parsed : null;
  } catch {
    return null; // 损坏/权限/编码问题 → 回落重建
  }
}

/** 原子写索引（父目录自动创建；失败抛出由调用侧决定——写侧错误不静默）。 */
export function saveCodeIndex(indexPath: string, data: CodeIndexData): void {
  writeAtomic(indexPath, `${JSON.stringify(data, null, 2)}\n`);
}

/** 单文件解析产物（内存态，未落盘）。 */
interface ParsedEntry {
  hash: string;
  mtimeMs: number;
  size: number;
  definitions: IndexedDefinition[];
  references: IndexedFile['references'];
}

function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** 读盘 + 解析单文件；二进制/超限/读失败返回 null（不抛）。 */
function readParse(absPath: string, spec: LanguageSpec, maxBytes: number): ParsedEntry | null {
  let buf: Buffer;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(absPath);
    if (!st.isFile() || st.size > maxBytes) return null;
    buf = readFileSync(absPath);
  } catch {
    return null;
  }
  if (isBinary(buf)) return null;
  const parsed = parseSource(buf.toString('utf8'), spec);
  return {
    hash: sha1(buf),
    mtimeMs: st.mtimeMs,
    size: st.size,
    definitions: parsed.definitions,
    references: parsed.references,
  };
}

/** 索引统计：定义总数 + 引用名称（不同标识符）总数。 */
function entriesSummary(files: Record<string, IndexedFile>): { definitions: number; referenceNames: number } {
  let definitions = 0;
  const names = new Set<string>();
  for (const file of Object.values(files)) {
    definitions += file.definitions.length;
    for (const name of Object.keys(file.references)) names.add(name);
  }
  return { definitions, referenceNames: names.size };
}

/**
 * A22 符号索引存储：有状态门面（懒加载 + 增量 + 查询）。
 * 所有方法同步（CLI 命令一次调用即可完成；解析为 CPU 密集但纯内存/短 IO，符合 core 既有风格）。
 */
export class CodeIndexStore {
  readonly root: string;
  readonly indexPath: string;
  private readonly maxFileBytes: number;
  private data: CodeIndexData | null = null;
  private loaded = false;
  /** 查询时按文件缓存行数组（避免同一文件多次读盘） */
  private readonly lineCache = new Map<string, string[] | null>();

  constructor(options: CodeIndexOptions) {
    const cwd = options.cwd ?? process.cwd();
    this.root = resolve(cwd, options.root);
    this.indexPath =
      options.indexPath !== undefined ? resolve(cwd, options.indexPath) : codeIndexFilePath(this.root, options.home);
    this.maxFileBytes = options.maxFileBytes ?? MAX_INDEX_FILE_BYTES;
  }

  /** 懒加载：损坏/缺失 → data=null（随后 update 会回落全量重建）。 */
  private ensureLoaded(): CodeIndexData | null {
    if (!this.loaded) {
      const disk = loadCodeIndex(this.indexPath);
      this.data = disk !== null && disk.root === this.root ? disk : null;
      this.loaded = true;
    }
    return this.data;
  }

  /** 枚举当前应索引的文件（相对路径，`/` 分隔，排序稳定）。 */
  private scanFiles(): string[] {
    // 若索引文件本身位于 root 内，显式排除（防自索引）；默认在全局数据根，通常不命中。
    const ignore = [...EXCLUDED_GLOBS];
    const relIndex = relative(this.root, this.indexPath).split(sep).join('/');
    if (relIndex.length > 0 && !relIndex.startsWith('..') && !relIndex.includes(':')) ignore.push(relIndex);
    const entries = fg.sync('**/*', {
      cwd: this.root,
      dot: false, // 隐藏项（含 .env* / .harness2）不进入——与 grep 回退同源语义
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore,
    });
    const out: string[] = [];
    for (const raw of entries) {
      const path = raw.replace(/\\/g, '/');
      if (languageForFile(path) !== undefined) out.push(path);
    }
    out.sort();
    return out;
  }

  /** 全量重建（覆盖索引文件）。 */
  rebuild(): IndexBuildStats {
    const paths = this.scanFiles();
    const files: Record<string, IndexedFile> = {};
    let parsed = 0;
    let skipped = 0;
    let definitions = 0;
    for (const path of paths) {
      const spec = languageForFile(path);
      if (spec === undefined) continue;
      const entry = readParse(join(this.root, path), spec, this.maxFileBytes);
      if (entry === null) {
        skipped++;
        continue;
      }
      parsed++;
      definitions += entry.definitions.length;
      files[path] = {
        path,
        language: spec.id,
        hash: entry.hash,
        mtimeMs: entry.mtimeMs,
        size: entry.size,
        definitions: entry.definitions,
        references: entry.references,
      };
    }
    const data: CodeIndexData = {
      v: CODE_INDEX_VERSION,
      root: this.root,
      builtAt: new Date().toISOString(),
      files,
    };
    this.data = data;
    this.loaded = true;
    this.lineCache.clear();
    saveCodeIndex(this.indexPath, data);
    return {
      root: this.root,
      scanned: paths.length,
      parsed,
      skipped,
      definitions,
      indexPath: this.indexPath,
    };
  }

  /** 增量更新（新增/变更/删除 + mtime 预筛 + 哈希复用）。索引损坏时回落全量重建。 */
  update(): IndexUpdateStats {
    const previous = this.ensureLoaded();
    if (previous === null) {
      const full = this.rebuild();
      return { ...full, reused: 0, added: full.parsed, changed: 0, removed: 0 };
    }

    const paths = this.scanFiles();
    const previousFiles = previous.files;
    const files: Record<string, IndexedFile> = {};
    let reused = 0;
    let added = 0;
    let changed = 0;
    let skipped = 0;
    let definitions = 0;
    let dirty = false;

    for (const path of paths) {
      const spec = languageForFile(path);
      if (spec === undefined) continue;
      const absPath = join(this.root, path);
      const prior = previousFiles[path];
      // 廉价预筛：mtime + size 一致即复用，不读盘
      let st: ReturnType<typeof statSync> | null = null;
      try {
        st = statSync(absPath);
      } catch {
        st = null;
      }
      if (prior !== undefined && st !== null && st.isFile() && st.mtimeMs === prior.mtimeMs && st.size === prior.size) {
        files[path] = prior;
        reused++;
        definitions += prior.definitions.length;
        continue;
      }
      const entry = readParse(absPath, spec, this.maxFileBytes);
      if (entry === null) {
        skipped++;
        // 无法读取：若此前有索引，视为失去事实依据 → 移除（不保留陈旧项）
        if (prior !== undefined) dirty = true;
        continue;
      }
      if (prior !== undefined && prior.hash === entry.hash) {
        // 内容未变（mtime 抖动）：复用解析结果，仅刷新 mtime/size 使预筛继续生效
        files[path] = { ...prior, mtimeMs: entry.mtimeMs, size: entry.size };
        reused++;
        definitions += prior.definitions.length;
        dirty = true; // mtime/size 变了也要落盘
        continue;
      }
      files[path] = {
        path,
        language: spec.id,
        hash: entry.hash,
        mtimeMs: entry.mtimeMs,
        size: entry.size,
        definitions: entry.definitions,
        references: entry.references,
      };
      definitions += entry.definitions.length;
      if (prior === undefined) added++;
      else changed++;
      dirty = true;
    }

    // 磁盘上消失的条目（被删/改名）
    let removed = 0;
    for (const path of Object.keys(previousFiles)) {
      if (!(path in files)) {
        removed++;
        dirty = true;
      }
    }

    const data: CodeIndexData = {
      v: CODE_INDEX_VERSION,
      root: this.root,
      builtAt: new Date().toISOString(),
      files,
    };
    this.data = data;
    this.lineCache.clear();
    if (dirty) saveCodeIndex(this.indexPath, data);
    return {
      root: this.root,
      scanned: paths.length,
      parsed: added + changed,
      skipped,
      definitions,
      indexPath: this.indexPath,
      reused,
      added,
      changed,
      removed,
    };
  }

  /** 索引状态（只读；索引缺失/损坏时 exists 如实为 false）。 */
  status(): IndexStatus {
    const data = this.ensureLoaded();
    const summary = data !== null ? entriesSummary(data.files) : { definitions: 0, referenceNames: 0 };
    return {
      indexPath: this.indexPath,
      exists: existsSync(this.indexPath),
      files: data !== null ? Object.keys(data.files).length : 0,
      definitions: summary.definitions,
      referenceNames: summary.referenceNames,
      builtAt: data?.builtAt ?? '',
      root: this.root,
    };
  }

  /** 查询定义：默认不区分大小写的精确匹配（见 types.ts QueryOptions 口径）。 */
  findDefinitions(name: string, opts: QueryOptions = {}): DefinitionHit[] {
    const data = this.ensureLoaded();
    if (data === null) return [];
    const limit = clampLimit(opts.limit);
    const hits: DefinitionHit[] = [];
    for (const path of Object.keys(data.files).sort()) {
      const file = data.files[path];
      if (file === undefined) continue;
      for (const def of file.definitions) {
        if (!nameMatches(def.name, name, opts)) continue;
        hits.push({
          name: def.name,
          kind: def.kind,
          language: file.language,
          file: path,
          line: def.line,
          column: def.column,
          text: this.lineText(path, def.line),
        });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  /** 查询引用：默认不区分大小写的精确匹配；定义位点也在结果中（isDefinition 标记）。 */
  findReferences(name: string, opts: QueryOptions = {}): ReferenceHit[] {
    const data = this.ensureLoaded();
    if (data === null) return [];
    const limit = clampLimit(opts.limit);
    const hits: ReferenceHit[] = [];
    for (const path of Object.keys(data.files).sort()) {
      const file = data.files[path];
      if (file === undefined) continue;
      for (const key of Object.keys(file.references).sort()) {
        if (!nameMatches(key, name, opts)) continue;
        const refs = file.references[key];
        if (refs === undefined) continue;
        for (const ref of refs) {
          hits.push({
            name: key,
            language: file.language,
            file: path,
            line: ref.line,
            column: ref.column,
            text: this.lineText(path, ref.line),
            isDefinition: ref.isDefinition,
          });
          if (hits.length >= limit) return hits;
        }
      }
    }
    return hits;
  }

  /** 现读磁盘取 1 基行文本（trim 后）。文件已删/读失败 → 空串（不抛）。 */
  private lineText(path: string, line: number): string {
    let lines = this.lineCache.get(path);
    if (lines === undefined) {
      try {
        lines = readFileSync(join(this.root, path), 'utf8').split(/\r?\n/);
      } catch {
        lines = null;
      }
      this.lineCache.set(path, lines);
    }
    const text = lines?.[line - 1];
    return typeof text === 'string' ? text.trim() : '';
  }
}

/** 上限钳制：缺省 MAX_QUERY_RESULTS；显式 >0 取 min(值, HARD_QUERY_LIMIT)；非正数视为缺省。 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return MAX_QUERY_RESULTS;
  return Math.min(Math.floor(limit), HARD_QUERY_LIMIT);
}

/** 名称匹配（模式 + 大小写，口径见 types.ts QueryOptions）。 */
export function nameMatches(candidate: string, target: string, opts: QueryOptions = {}): boolean {
  const mode = opts.match ?? 'exact';
  const cs = opts.caseSensitive ?? false;
  const a = cs ? candidate : candidate.toLowerCase();
  const b = cs ? target : target.toLowerCase();
  if (mode === 'prefix') return a.startsWith(b);
  if (mode === 'substring') return a.includes(b);
  return a === b;
}
