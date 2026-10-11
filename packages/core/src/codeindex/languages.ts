// A22 语言感知的轻量解析规格（无 tree-sitter；按扩展名分派 + 正则/行扫描）。
//
// 覆盖语言（按扩展名分派，报告同步登记清单）：
//   - TypeScript 系：.ts .tsx .mts .cts（含 .d.ts，扩展名归一为 .ts）
//   - JavaScript 系：.js .jsx .mjs .cjs
//   - Python：.py .pyi
//   - Go：.go
//   - Rust：.rs
//   - Java：.java
//   - C / C++：.c .h .cc .cpp .cxx .hpp .hh .hxx
//   - C#：.cs
// 未覆盖语言（如实声明，报告登记）：Ruby/PHP/Shell/HTML/CSS/JSON/YAML/Markdown 等——
// 不被索引（文件级跳过），也不做向量/语义（后置）。
//
// 每条 DefRule 的正则**恰好一个命名捕获组**（nameGroup，缺省 1）= 符号名，跑在
// 「注释/字符串已掩码」的文本上（parser.ts）。所有 `^` 规则配合 `m` 旗标 =
// 行首零缩进（顶层声明），用于排除函数体内的局部变量；方法规则显式要求行首缩进。
import type { SymbolKind } from './types.js';

/** 字符串定界符规格（掩码用）。 */
export interface StringDelim {
  open: string;
  close: string;
  /** true = 可跨行（需匹配到 close；false 时遇换行即视为未闭合结束） */
  multiline: boolean;
  /** true = 反斜杠转义 */
  escape: boolean;
}

/** 定义提取规则。 */
export interface DefRule {
  kind: SymbolKind;
  re: RegExp;
  /** 符号名所在的捕获组序号（1 基；缺省 1） */
  nameGroup?: number;
  /**
   * 是否按语句关键字过滤名称（缺省 false）。仅对「无返回类型约束」的 TS/JS 方法行规则
   * 需要——`if (x) {` 之类会命中方法形态；有返回类型约束的语言（Java/C#/Go/Rust/C）
   * 天然不会把控制流误当定义，无需过滤（也避免误伤 `new` 等合法符号名）。
   */
  filterControl?: boolean;
}

/** 单语言解析规格。 */
export interface LanguageSpec {
  /** 语言 id（索引条目记录） */
  id: string;
  /** 文件扩展名（含点，小写） */
  extensions: readonly string[];
  /** 行注释起始符（如 `//`、`#`） */
  lineComments: readonly string[];
  /** 块注释定界符（[open, close]） */
  blockComments: readonly (readonly [string, string])[];
  /** 字符串定界符（长定界符优先匹配，parser 会排序） */
  strings: readonly StringDelim[];
  /** 语言关键字（引用分词时过滤，避免把它们当符号引用） */
  keywords: ReadonlySet<string>;
  /** 定义规则 */
  defRules: readonly DefRule[];
  /** 标识符正则（引用分词；全局旗标由 parser 补） */
  identifier?: RegExp;
  /** 单个文件最多收录的引用出现数（防爆；超出即截断并如实计数） */
  maxReferences?: number;
}

const s = (arr: readonly string[]): ReadonlySet<string> => new Set(arr);

// —— 关键字表（引用过滤用；含各语言保留字，宽进严出） ——

const JS_KEYWORDS = s([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'async',
  'await',
  'of',
  'as',
  'from',
  'interface',
  'type',
  'implements',
  'package',
  'private',
  'protected',
  'public',
  'declare',
  'abstract',
  'readonly',
  'namespace',
  'module',
  'keyof',
  'infer',
  'is',
  'asserts',
  'satisfies',
  'override',
  'get',
  'set',
]);

const PY_KEYWORDS = s([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
  'match',
  'case',
  'self',
  'cls',
  'print',
  'len',
  'range',
  'int',
  'str',
  'float',
  'bool',
  'list',
  'dict',
  'set',
  'tuple',
]);

const GO_KEYWORDS = s([
  'break',
  'case',
  'chan',
  'const',
  'continue',
  'default',
  'defer',
  'else',
  'fallthrough',
  'for',
  'func',
  'go',
  'goto',
  'if',
  'import',
  'interface',
  'map',
  'package',
  'range',
  'return',
  'select',
  'struct',
  'switch',
  'type',
  'var',
  'nil',
  'true',
  'false',
  'iota',
  'string',
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'float32',
  'float64',
  'bool',
  'byte',
  'rune',
  'error',
  'any',
  'make',
  'new',
  'len',
  'cap',
  'append',
  'copy',
  'delete',
  'panic',
  'recover',
]);

const RUST_KEYWORDS = s([
  'as',
  'async',
  'await',
  'break',
  'const',
  'continue',
  'crate',
  'dyn',
  'else',
  'enum',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'type',
  'unsafe',
  'use',
  'where',
  'while',
  'u8',
  'u16',
  'u32',
  'u64',
  'u128',
  'usize',
  'i8',
  'i16',
  'i32',
  'i64',
  'i128',
  'isize',
  'f32',
  'f64',
  'bool',
  'char',
  'str',
  'String',
  'Vec',
  'Option',
  'Result',
  'Some',
  'None',
  'Ok',
  'Err',
  'Box',
]);

const JAVA_KEYWORDS = s([
  'abstract',
  'assert',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extends',
  'final',
  'finally',
  'float',
  'for',
  'goto',
  'if',
  'implements',
  'import',
  'instanceof',
  'int',
  'interface',
  'long',
  'native',
  'new',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'short',
  'static',
  'strictfp',
  'super',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'transient',
  'try',
  'void',
  'volatile',
  'while',
  'true',
  'false',
  'null',
  'var',
  'record',
  'sealed',
  'permits',
  'yield',
]);

const C_KEYWORDS = s([
  'auto',
  'break',
  'case',
  'char',
  'const',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extern',
  'float',
  'for',
  'goto',
  'if',
  'inline',
  'int',
  'long',
  'register',
  'restrict',
  'return',
  'short',
  'signed',
  'sizeof',
  'static',
  'struct',
  'switch',
  'typedef',
  'union',
  'unsigned',
  'void',
  'volatile',
  'while',
  'class',
  'namespace',
  'template',
  'typename',
  'public',
  'private',
  'protected',
  'virtual',
  'override',
  'nullptr',
  'true',
  'false',
  'bool',
  'new',
  'delete',
  'this',
  'using',
  'auto',
]);

const CS_KEYWORDS = s([
  'abstract',
  'as',
  'base',
  'bool',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'checked',
  'class',
  'const',
  'continue',
  'decimal',
  'default',
  'delegate',
  'do',
  'double',
  'else',
  'enum',
  'event',
  'explicit',
  'extern',
  'false',
  'finally',
  'fixed',
  'float',
  'for',
  'foreach',
  'goto',
  'if',
  'implicit',
  'in',
  'int',
  'interface',
  'internal',
  'is',
  'lock',
  'long',
  'namespace',
  'new',
  'null',
  'object',
  'operator',
  'out',
  'override',
  'params',
  'private',
  'protected',
  'public',
  'readonly',
  'ref',
  'return',
  'sbyte',
  'sealed',
  'short',
  'sizeof',
  'stackalloc',
  'static',
  'string',
  'struct',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'uint',
  'ulong',
  'unchecked',
  'unsafe',
  'ushort',
  'using',
  'var',
  'virtual',
  'void',
  'volatile',
  'while',
]);

// —— 语句关键字：仅 TS/JS 方法行规则的误捕过滤（`if (x) {` 等） ——
// 只保留真正可能「以 `(` 起头并以 `{` 收尾」的语句头；刻意不含 new/return/function 等，
// 以免误伤合法符号名（例如 Rust 的 `fn new`）。

const CONTROL_NAMES = s(['if', 'for', 'while', 'switch', 'catch']);

/** 标识符正则：TS/JS 允许 `$`；其余语言缺省（parser 用 `[A-Za-z_]\w*`，本字段留空即用缺省） */
const IDENT_JS = /[$A-Za-z_][\w$]*/g;

// —— 各语言定义规则 ——

const TS_RULES: readonly DefRule[] = [
  {
    kind: 'function',
    re: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
  },
  {
    kind: 'class',
    re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:declare\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
  },
  { kind: 'interface', re: /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'type', re: /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/gm },
  { kind: 'enum', re: /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'constant', re: /^(?:export\s+)?(?:declare\s+)?const\s+(?!enum\b)([A-Za-z_$][\w$]*)/gm },
  { kind: 'variable', re: /^(?:export\s+)?(?:declare\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)/gm },
  {
    kind: 'method',
    filterControl: true,
    re: /^[ \t]+(?:(?:public|private|protected|static|async|abstract|readonly|override|declare|get|set)\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*(?:<[^<>{}]*>)?\s*\([^(){}]*\)\s*(?::[^;{}]*)?\{\s*$/gm,
  },
];

const PY_RULES: readonly DefRule[] = [
  { kind: 'function', re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm },
  { kind: 'method', re: /^[ \t]+(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm },
  { kind: 'class', re: /^[ \t]*class\s+([A-Za-z_]\w*)\b/gm },
  { kind: 'constant', re: /^([A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=(?!=)/gm },
];

const GO_RULES: readonly DefRule[] = [
  { kind: 'function', re: /^func\s+([A-Za-z_]\w*)\s*\(/gm },
  // 方法：`func (r *T) Name(`；接收者类型/名各一个标识符 token，取方法名
  { kind: 'method', re: /^func\s*\(\s*[A-Za-z_]\w*\s+\*?[A-Za-z_]\w*\s*\)\s*([A-Za-z_]\w*)\s*\(/gm },
  { kind: 'struct', re: /^type\s+([A-Za-z_]\w*)\s+struct\b/gm },
  { kind: 'interface', re: /^type\s+([A-Za-z_]\w*)\s+interface\b/gm },
  { kind: 'type', re: /^type\s+([A-Za-z_]\w*)\s*=/gm },
  { kind: 'constant', re: /^const\s+([A-Za-z_]\w*)/gm },
  { kind: 'variable', re: /^var\s+([A-Za-z_]\w*)/gm },
];

const RUST_RULES: readonly DefRule[] = [
  {
    kind: 'function',
    re: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/gm,
  },
  { kind: 'method', re: /^[ \t]+(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/gm },
  { kind: 'struct', re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/gm },
  { kind: 'enum', re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/gm },
  { kind: 'trait', re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/gm },
  { kind: 'type', re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)\s*[=<]/gm },
  {
    kind: 'constant',
    re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?!fn\b)([A-Za-z_]\w*)/gm,
  },
];

const JAVA_RULES: readonly DefRule[] = [
  {
    kind: 'class',
    re: /^[ \t]*(?:(?:public|private|protected|abstract|final|static|strictfp|sealed|non-sealed)\s+)*class\s+([A-Za-z_$][\w$]*)/gm,
  },
  {
    kind: 'interface',
    re: /^[ \t]*(?:(?:public|private|protected|abstract|static|sealed|non-sealed)\s+)*interface\s+([A-Za-z_$][\w$]*)/gm,
  },
  { kind: 'enum', re: /^[ \t]*(?:(?:public|private|protected|static)\s+)*enum\s+([A-Za-z_$][\w$]*)/gm },
  {
    kind: 'method',
    // 行首缩进的「返回类型 + 方法名(...)  {」单行形态；构造器（无返回类型）不覆盖（登记为已知缺口）
    re: /^[ \t]+(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:[A-Za-z_$][\w$.<>]*\s*\[\s*\]\s*)*[A-Za-z_$][\w$.<>]*\s+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws\s+[^{;]+)?\{\s*$/gm,
  },
];

const C_RULES: readonly DefRule[] = [
  { kind: 'struct', re: /^[ \t]*(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/gm },
  { kind: 'class', re: /^[ \t]*(?:typedef\s+)?class\s+([A-Za-z_]\w*)/gm },
  { kind: 'enum', re: /^[ \t]*(?:typedef\s+)?enum(?:\s+class)?\s+([A-Za-z_]\w*)/gm },
  {
    kind: 'function',
    re: /^[A-Za-z_][\w:\s*&<>]*?\s+\*?([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?\{\s*$/gm,
  },
];

const CS_RULES: readonly DefRule[] = [
  {
    kind: 'class',
    re: /^[ \t]*(?:(?:public|private|protected|internal|abstract|sealed|static|partial)\s+)*class\s+([A-Za-z_]\w*)/gm,
  },
  {
    kind: 'interface',
    re: /^[ \t]*(?:(?:public|private|protected|internal|partial)\s+)*interface\s+([A-Za-z_]\w*)/gm,
  },
  {
    kind: 'struct',
    re: /^[ \t]*(?:(?:public|private|protected|internal|readonly|partial|ref)\s+)*struct\s+([A-Za-z_]\w*)/gm,
  },
  { kind: 'enum', re: /^[ \t]*(?:(?:public|private|protected|internal)\s+)*enum\s+([A-Za-z_]\w*)/gm },
  {
    kind: 'method',
    re: /^[ \t]+(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|new)\s+)*(?:[A-Za-z_][\w.<>\[\],\s]*?)\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{\s*$/gm,
  },
];

// —— 全部语言规格（按 id；扩展名分派用 EXT_TO_LANGUAGE） ——
const SPEC_LIST: readonly LanguageSpec[] = [
  {
    id: 'typescript',
    extensions: ['.ts', '.tsx', '.mts', '.cts'],
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [
      { open: '`', close: '`', multiline: true, escape: true },
      { open: '"', close: '"', multiline: false, escape: true },
      { open: "'", close: "'", multiline: false, escape: true },
    ],
    keywords: JS_KEYWORDS,
    defRules: TS_RULES,
    identifier: IDENT_JS,
  },
  {
    id: 'javascript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [
      { open: '`', close: '`', multiline: true, escape: true },
      { open: '"', close: '"', multiline: false, escape: true },
      { open: "'", close: "'", multiline: false, escape: true },
    ],
    keywords: JS_KEYWORDS,
    // JS 无类型声明；剔除 type/interface 规则（避免 `type Foo =` 以外的误报）
    defRules: TS_RULES.filter((r) => r.kind !== 'type' && r.kind !== 'interface'),
    identifier: IDENT_JS,
  },
  {
    id: 'python',
    extensions: ['.py', '.pyi'],
    lineComments: ['#'],
    blockComments: [],
    strings: [
      { open: '"""', close: '"""', multiline: true, escape: true },
      { open: "'''", close: "'''", multiline: true, escape: true },
      { open: '"', close: '"', multiline: false, escape: true },
      { open: "'", close: "'", multiline: false, escape: true },
    ],
    keywords: PY_KEYWORDS,
    defRules: PY_RULES,
  },
  {
    id: 'go',
    extensions: ['.go'],
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [
      { open: '`', close: '`', multiline: true, escape: false },
      { open: '"', close: '"', multiline: false, escape: true },
      { open: "'", close: "'", multiline: false, escape: true },
    ],
    keywords: GO_KEYWORDS,
    defRules: GO_RULES,
  },
  {
    id: 'rust',
    extensions: ['.rs'],
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [
      { open: '"', close: '"', multiline: false, escape: true },
      { open: "'", close: "'", multiline: false, escape: true },
    ],
    keywords: RUST_KEYWORDS,
    defRules: RUST_RULES,
  },
  {
    id: 'java',
    extensions: ['.java'],
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [
      { open: '"""', close: '"""', multiline: true, escape: true },
      { open: '"', close: '"', multiline: false, escape: true },
      { open: "'", close: "'", multiline: false, escape: true },
    ],
    keywords: JAVA_KEYWORDS,
    defRules: JAVA_RULES,
  },
  {
    id: 'c',
    extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'],
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [
      { open: '"', close: '"', multiline: false, escape: true },
      { open: "'", close: "'", multiline: false, escape: true },
    ],
    keywords: C_KEYWORDS,
    defRules: C_RULES,
  },
  {
    id: 'csharp',
    extensions: ['.cs'],
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [
      { open: '@"', close: '"', multiline: true, escape: false },
      { open: '"', close: '"', multiline: false, escape: true },
      { open: "'", close: "'", multiline: false, escape: true },
    ],
    keywords: CS_KEYWORDS,
    defRules: CS_RULES,
  },
];

export const LANGUAGE_SPECS: ReadonlyMap<string, LanguageSpec> = new Map(SPEC_LIST.map((spec) => [spec.id, spec]));

/** 扩展名（小写，含点）→ 语言规格。 */
const EXT_TO_LANGUAGE: ReadonlyMap<string, LanguageSpec> = (() => {
  const map = new Map<string, LanguageSpec>();
  for (const spec of SPEC_LIST) {
    for (const ext of spec.extensions) map.set(ext, spec);
  }
  return map;
})();

/** 全部被索引的文件扩展名（报告/文档用）。 */
export const INDEXED_EXTENSIONS: readonly string[] = [...EXT_TO_LANGUAGE.keys()].sort();

/**
 * 按文件路径分派语言规格；未覆盖返回 undefined（文件级跳过）。
 * 只取 basename 的最后一个扩展名（`foo.d.ts` → `.ts`，与 TS 同规格）。
 */
export function languageForFile(path: string): LanguageSpec | undefined {
  const base = path.slice(path.replace(/\\/g, '/').lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined; // 无扩展名或隐藏文件（.env）不索引
  return EXT_TO_LANGUAGE.get(base.slice(dot).toLowerCase());
}

/** 控制关键字（方法规则误捕行首词时按名过滤）。 */
export const CONTROL_KEYWORDS: ReadonlySet<string> = CONTROL_NAMES;

/** 控制关键字过滤（导出供测试/命令展示口径一致）。 */
export function isControlName(name: string): boolean {
  return CONTROL_NAMES.has(name);
}
