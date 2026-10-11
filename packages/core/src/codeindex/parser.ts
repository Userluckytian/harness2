// A22 轻量解析器：注释/字符串掩码 → 定义提取 + 引用分词。
//
// 核心质量点（测试钉死）：**注释与字符串里的假符号不得误报**。
// 做法：先把源码扫描成「同长度掩码文本」——注释、字符串（含 Python 三引号 docstring、
// Go 反引号原始串、JS 模板串）内部的字符一律替换为空格，但**保留换行**，于是行号/列号
// 与原文逐一对应；定义正则与引用分词全部跑在掩码文本上，注释/字符串内的 `function fake`
// 或 `foo()` 天然不参与匹配。
//
// 已知边界（如实声明，报告登记）：
//   - 除法 `a / b` 与正则字面量误判：`//`、`/*` 一律按注释处理（正则字面量内含这些序列
//     时可能少量误掩码）；
//   - 字符串前缀（Python f/r/b、Rust r、C# 逐字 @ 由定界符覆盖）中未覆盖的前缀字母
//     会作为标识符进入引用索引（噪声，非定义误报）；
//   - Rust 块注释嵌套、JSX 文本内容不特殊处理。
import type { LanguageSpec } from './languages.js';
import { CONTROL_KEYWORDS } from './languages.js';
import type { IndexedDefinition, IndexedReference, SymbolKind } from './types.js';

/** 单文件最多收录的引用出现数（防爆；等于 spec.maxReferences 缺省值）。 */
export const DEFAULT_MAX_REFS_PER_FILE = 20000;

/** 单文件解析结果。 */
export interface ParsedFile {
  definitions: IndexedDefinition[];
  references: Record<string, IndexedReference[]>;
  /** 引用是否因达到每文件上限而被截断 */
  referencesTruncated: boolean;
}

/** 位置（1 基行、1 基列）。 */
export interface Position {
  line: number;
  column: number;
}

/** 行首偏移表：lineStarts[i] = 第 i+1 行起始字符偏移。 */
export function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** 字符偏移 → 1 基行/列（二分查找行首表）。 */
export function positionAt(lineStarts: readonly number[], index: number): Position {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const start = lineStarts[mid];
    if (start !== undefined && start <= index) lo = mid;
    else hi = mid - 1;
  }
  const start = lineStarts[lo] ?? 0;
  return { line: lo + 1, column: index - start + 1 };
}

/** 引用分词用的标识符正则（补全局旗标）。 */
function identifierRegex(spec: LanguageSpec): RegExp {
  const src = spec.identifier?.source ?? '[A-Za-z_]\\w*';
  return new RegExp(src, 'g');
}

/**
 * 掩码源码：注释/字符串内部（含定界符）替换为空格，换行保留。
 * 返回与输入等长（归一化后）的字符串。
 */
export function maskSource(source: string, spec: LanguageSpec): string {
  const out = source.split('');
  const n = source.length;
  const lineComments = spec.lineComments;
  // 长定界符优先（`"""` 先于 `"`）——定界符列表在构造期已按规则书写，这里再保险排序
  const strings = [...spec.strings].sort((a, b) => b.open.length - a.open.length);
  const blocks = spec.blockComments;

  let i = 0;
  while (i < n) {
    // 行注释：掩到行尾（不含换行）
    const lc = lineComments.find((t) => t.length > 0 && source.startsWith(t, i));
    if (lc !== undefined) {
      let j = i;
      while (j < n && source.charCodeAt(j) !== 10) {
        out[j] = ' ';
        j++;
      }
      i = j;
      continue;
    }
    // 块注释：掩到闭合定界符（保留换行）
    const bc = blocks.find(([open]) => open.length > 0 && source.startsWith(open, i));
    if (bc !== undefined) {
      const open = bc[0];
      const close = bc[1];
      for (let k = i; k < Math.min(n, i + open.length); k++) out[k] = ' ';
      let j = i + open.length;
      while (j < n && !source.startsWith(close, j)) {
        if (source.charCodeAt(j) !== 10) out[j] = ' ';
        j++;
      }
      for (let k = j; k < Math.min(n, j + close.length); k++) out[k] = ' ';
      i = Math.min(n, j + close.length);
      continue;
    }
    // 字符串：掩到闭合定界符（非跨行串遇换行即止，容忍未闭合）
    const str = strings.find((d) => d.open.length > 0 && source.startsWith(d.open, i));
    if (str !== undefined) {
      for (let k = i; k < Math.min(n, i + str.open.length); k++) out[k] = ' ';
      let j = i + str.open.length;
      while (j < n) {
        if (str.escape && source.charCodeAt(j) === 92 /* \ */) {
          out[j] = ' ';
          if (j + 1 < n && source.charCodeAt(j + 1) !== 10) out[j + 1] = ' ';
          j += 2;
          continue;
        }
        if (source.startsWith(str.close, j)) break;
        if (!str.multiline && source.charCodeAt(j) === 10) break;
        if (source.charCodeAt(j) !== 10) out[j] = ' ';
        j++;
      }
      if (j < n && source.startsWith(str.close, j)) {
        for (let k = j; k < Math.min(n, j + str.close.length); k++) out[k] = ' ';
        j += str.close.length;
      }
      i = j;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** 带 `d` 旗标的匹配（拿到捕获组精确偏移）；规则正则本身不带 `d`，此处补。 */
function withIndices(re: RegExp): RegExp {
  const flags = re.flags.includes('d') ? re.flags : `${re.flags}d`;
  return new RegExp(re.source, flags);
}

interface MatchWithIndices extends RegExpExecArray {
  indices?: RegExpIndicesArray;
}

/**
 * 解析单文件（纯函数，不触盘）：提取定义与引用。
 * @param rawSource 磁盘原文（内部会归一化 CRLF）
 * @param spec      语言规格
 */
export function parseSource(rawSource: string, spec: LanguageSpec): ParsedFile {
  const source = rawSource.replace(/\r\n?/g, '\n');
  const masked = maskSource(source, spec);
  const lineStarts = computeLineStarts(source);

  // —— 定义提取 ——
  const definitions: IndexedDefinition[] = [];
  const seen = new Set<string>(); // `${line}:${col}:${kind}:${name}` 去重
  const defPositions = new Set<string>(); // `${line}:${col}` 定义位点（引用 isDefinition 标记）
  for (const rule of spec.defRules) {
    const nameGroup = rule.nameGroup ?? 1;
    const re = withIndices(rule.re);
    for (const raw of masked.matchAll(re) as Iterable<MatchWithIndices>) {
      const name = raw[nameGroup];
      if (name === undefined || name.length === 0) continue;
      if (rule.filterControl === true && CONTROL_KEYWORDS.has(name)) continue; // `if (x) {` 之类
      const span = raw.indices?.[nameGroup];
      const offset = span !== undefined ? span[0] : raw.index + Math.max(0, raw[0].lastIndexOf(name));
      const pos = positionAt(lineStarts, offset);
      const key = `${pos.line}:${pos.column}:${rule.kind}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      definitions.push({ name, kind: rule.kind, line: pos.line, column: pos.column });
      defPositions.add(`${pos.line}:${pos.column}`);
    }
  }
  definitions.sort(comparePos);

  // —— 引用分词（定义位点也在其中，用 isDefinition 区分） ——
  const references: Record<string, IndexedReference[]> = {};
  const maxRefs = spec.maxReferences ?? DEFAULT_MAX_REFS_PER_FILE;
  let total = 0;
  let truncated = false;
  const idRe = identifierRegex(spec);
  for (const m of masked.matchAll(idRe)) {
    const name = m[0];
    if (spec.keywords.has(name)) continue;
    const pos = positionAt(lineStarts, m.index);
    if (total >= maxRefs) {
      truncated = true;
      break;
    }
    const bucket = references[name] ?? (references[name] = []);
    bucket.push({
      line: pos.line,
      column: pos.column,
      isDefinition: defPositions.has(`${pos.line}:${pos.column}`),
    });
    total++;
  }

  return { definitions, references, referencesTruncated: truncated };
}

/** 1 基位置比较（行 → 列）。 */
function comparePos(a: { line: number; column: number }, b: { line: number; column: number }): number {
  return a.line !== b.line ? a.line - b.line : a.column - b.column;
}

/** 便捷：仅取定义（测试/工具复用）。 */
export function extractDefinitions(rawSource: string, spec: LanguageSpec): IndexedDefinition[] {
  return parseSource(rawSource, spec).definitions;
}

/** 符号种类 → 中文展示名。 */
export function symbolKindLabel(kind: SymbolKind): string {
  switch (kind) {
    case 'function':
      return '函数';
    case 'method':
      return '方法';
    case 'class':
      return '类';
    case 'interface':
      return '接口';
    case 'type':
      return '类型';
    case 'enum':
      return '枚举';
    case 'constant':
      return '常量';
    case 'variable':
      return '变量';
    case 'struct':
      return '结构体';
    case 'trait':
      return 'trait';
  }
}
