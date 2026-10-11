// A22 语义代码索引（Z6 批次7-A）—— 公共类型定义。
//
// 定位（计划书 A22 行：等级=补齐，先符号索引、向量后置）：
//   - 本模块是**符号索引**：按语言感知的轻量解析（正则 + 行扫描 + 注释/字符串掩码），
//     从真实磁盘源码提取**定义**（函数/类/接口/类型/方法/常量等）与**引用**（标识符出现）；
//   - **不引 tree-sitter / 任何原生解析器**（新增原生依赖风险大）；解析器为自研纯 TS；
//   - 索引是**派生物**：可随时删除重建，绝不回改事实源（源码只读）；
//   - 向量/语义嵌入、跨语言调用图、LSP（A20）明确**不在本批次**。
//
// 隐私边界：索引只含符号名/位置/相对路径与文件哈希，不含源码正文（行文本查询时现读磁盘）。

/** 符号种类（跨语言归并后的统一口径）。 */
export type SymbolKind =
  'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'constant' | 'variable' | 'struct' | 'trait';

/** 全部符号种类（稳定顺序，供命令/展示遍历）。 */
export const SYMBOL_KINDS: readonly SymbolKind[] = [
  'function',
  'method',
  'class',
  'interface',
  'type',
  'enum',
  'constant',
  'variable',
  'struct',
  'trait',
];

/** 索引中的一处符号定义（相对路径 + 1 基行/列 + 种类）。 */
export interface IndexedDefinition {
  /** 符号名（源码标识符原文） */
  name: string;
  kind: SymbolKind;
  /** 1 基行号 */
  line: number;
  /** 1 基列号（行内字符偏移 +1） */
  column: number;
}

/** 索引中的一处引用（仅存位置，行文本查询时现读磁盘）。 */
export interface IndexedReference {
  /** 1 基行号 */
  line: number;
  /** 1 基列号 */
  column: number;
  /**
   * 该引用是否落在同名定义位点（definition site）。
   * 引用索引收录所有标识符出现；定义位点也是出现，故用本字段区分，
   * 便于 findReferences 调用方按需过滤「声明本身」。
   */
  isDefinition: boolean;
}

/** 单个源文件的索引条目（不含源码正文）。 */
export interface IndexedFile {
  /** 相对索引根的路径（统一 `/` 分隔，排序稳定） */
  path: string;
  /** 语言 id（languages.ts 分派结果） */
  language: string;
  /** 内容 sha1（hex）——增量判定的权威依据 */
  hash: string;
  /** 文件 mtime（ms）——廉价预筛，命中即可跳过读盘与哈希 */
  mtimeMs: number;
  /** 字节大小——同上，配合 mtime 预筛 */
  size: number;
  /** 文件内全部定义（按出现顺序） */
  definitions: IndexedDefinition[];
  /** 引用倒排：标识符 → 出现位置列表（已按 行/列 升序） */
  references: Record<string, IndexedReference[]>;
}

/** 索引文件持久化形状（JSON；字段顺序固定便于 diff）。 */
export interface CodeIndexData {
  /** 索引格式代际（与源码解析器代际解耦：升级即重建） */
  v: typeof CODE_INDEX_VERSION;
  /** 索引根绝对路径（规范化后） */
  root: string;
  /** 构建时间（ISO 字符串） */
  builtAt: string;
  /** 相对路径 → 文件条目 */
  files: Record<string, IndexedFile>;
}

/** 索引格式代际（索引可重建，升级即重建）。 */
export const CODE_INDEX_VERSION = 1;

/** 索引文件名。 */
export const CODE_INDEX_FILE = 'code.index.json';

/** 查询匹配模式。 */
export type MatchMode = 'exact' | 'prefix' | 'substring';

/**
 * 查询选项。
 * 匹配策略（自定义口径，见 query 注释）：
 *   - 默认 `exact` + 不区分大小写（Unicode 无关的简单 `toLowerCase` 比较）；
 *   - `match: 'prefix' | 'substring'` 做名称包含匹配；
 *   - `caseSensitive: true` 切到大小写敏感；
 *   - `limit` 结果上限（防爆），缺省 MAX_QUERY_RESULTS，硬上限 HARD_QUERY_LIMIT。
 */
export interface QueryOptions {
  match?: MatchMode;
  caseSensitive?: boolean;
  limit?: number;
}

/** 定义查询命中（含所在行文本，查询时现读磁盘）。 */
export interface DefinitionHit {
  name: string;
  kind: SymbolKind;
  /** 语言 id */
  language: string;
  /** 相对索引根的路径（`/` 分隔） */
  file: string;
  /** 1 基行号 */
  line: number;
  /** 1 基列号 */
  column: number;
  /** 所在整行原文（trim 后）；文件已删/读失败时为空串 */
  text: string;
}

/** 引用查询命中（含所在行文本，查询时现读磁盘）。 */
export interface ReferenceHit {
  name: string;
  language: string;
  file: string;
  line: number;
  column: number;
  /** 所在整行原文（trim 后）；文件已删/读失败时为空串 */
  text: string;
  /** 是否为定义位点 */
  isDefinition: boolean;
}

/** 索引根的一行统计（status 命令展示用）。 */
export interface IndexStatus {
  /** 索引文件路径（不存在也为该路径） */
  indexPath: string;
  /** 索引文件是否存在 */
  exists: boolean;
  /** 已索引文件数 */
  files: number;
  /** 定义总数 */
  definitions: number;
  /** 引用的「名称」条目总数（不同标识符个数，非出现次数） */
  referenceNames: number;
  /** 构建时间（无索引时为空串） */
  builtAt: string;
  /** 索引根绝对路径 */
  root: string;
}

/** 全量重建统计。 */
export interface IndexBuildStats {
  root: string;
  /** 扫描到的（支持语言的）文件总数 */
  scanned: number;
  /** 本次实际解析的文件数（全量 = scanned；失败跳过另计） */
  parsed: number;
  /** 读盘/解析失败而跳过的文件数（不抛，如实计数） */
  skipped: number;
  /** 定义总数 */
  definitions: number;
  /** 索引文件路径 */
  indexPath: string;
}

/** 增量更新统计。 */
export interface IndexUpdateStats extends IndexBuildStats {
  /** 复用（哈希未变，未重新解析）的文件数 */
  reused: number;
  /** 新增的文件数 */
  added: number;
  /** 内容变更、重新解析的文件数 */
  changed: number;
  /** 磁盘上已消失（被删/被改名）而从索引移除的条目数 */
  removed: number;
}
