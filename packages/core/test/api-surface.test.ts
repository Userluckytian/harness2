// 公开导出面快照测试（阶段 12 Task 1）：把 @harness2/core 主入口（src/index.ts → 构建产物
// dist/index.d.ts）的导出清单钉死为基线 fixture——加性变更（新增导出）不红，删除/改名/
// 声明种类变更红，失败消息指引「走 major 或经批准更新基线快照」。政策全文见 docs/API-STABILITY.md。
//
// 快照口径（计划风险缓解的宽松匹配）：只钉 **导出名 + 声明种类**（function/class/const/
// interface/type/enum/namespace）——参数/返回类型级别的签名变化不在捕获范围（防抖动），
// 依赖 code review 与测试保障。快照只覆盖主入口导出；internal 深路径不承诺（API-STABILITY.md）。
//
// 更新基线：`pnpm build && H2_UPDATE_API_SNAPSHOT=1 pnpm --filter @harness2/core exec vitest run test/api-surface.test.ts`
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(TEST_DIR, '..', 'dist');
const BASELINE_FIXTURE = resolve(TEST_DIR, 'fixtures', 'api-surface-baseline.json');

/** 声明种类 = 签名摘要的粒度（宽松匹配：种类不变即不红） */
type Kind = 'class' | 'function' | 'const' | 'interface' | 'type' | 'enum' | 'namespace';

const DECLARATION_PATTERNS: ReadonlyArray<[RegExp, Kind]> = [
  [/^export\s+declare\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^export\s+declare\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
  [/^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
  [/^export\s+declare\s+(?:const|var|let)\s+([A-Za-z_$][\w$]*)/, 'const'],
  [/^export\s+(?:const|var|let)\s+([A-Za-z_$][\w$]*)/, 'const'],
  [/^export\s+declare\s+enum\s+([A-Za-z_$][\w$]*)/, 'enum'],
  [/^export\s+enum\s+([A-Za-z_$][\w$]*)/, 'enum'],
  [/^export\s+declare\s+namespace\s+([A-Za-z_$][\w$]*)/, 'namespace'],
  [/^export\s+interface\s+([A-Za-z_$][\w$]*)/, 'interface'],
  [/^export\s+type\s+([A-Za-z_$][\w$]*)(?=[\s<])/, 'type'],
];

const STAR_RE = /^export\s+\*\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm;
// export { A, B as C } [from './x.js']; —— 单行与多行块都覆盖（[\s\S]*? 惰性到首个闭括号）
const NAMED_BLOCK_RE = /^export\s*\{([\s\S]*?)\}\s*(?:from\s*['"]([^'"]+)['"])?\s*;?\s*$/gm;
const IMPORT_NAMED_RE = /^import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/gm;

interface ParsedModule {
  declared: Record<string, Kind>;
  starFrom: string[];
  namedFrom: Array<{ orig: string; exported: string; from: string }>;
  localNamed: Array<{ orig: string; exported: string }>;
  imports: Record<string, { orig: string; from: string }>;
}

function parseNamesClause(clause: string): Array<{ orig: string; exported: string }> {
  return clause
    .split(',')
    .map((s) => s.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((item) => {
      const asMatch = item.match(/^(.+?)\s+as\s+(.+)$/);
      return asMatch
        ? { orig: asMatch[1].trim(), exported: asMatch[2].trim() }
        : { orig: item, exported: item };
    });
}

function parseDtsModule(content: string): ParsedModule {
  const declared: Record<string, Kind> = {};
  for (const line of content.split('\n')) {
    for (const [re, kind] of DECLARATION_PATTERNS) {
      const m = line.match(re);
      if (m) {
        if (!(m[1] in declared)) declared[m[1]] = kind;
        break;
      }
    }
  }
  const starFrom: string[] = [];
  for (const m of content.matchAll(STAR_RE)) starFrom.push(m[1]);

  const namedFrom: ParsedModule['namedFrom'] = [];
  const localNamed: ParsedModule['localNamed'] = [];
  for (const m of content.matchAll(NAMED_BLOCK_RE)) {
    const names = parseNamesClause(m[1]);
    if (m[2]) for (const n of names) namedFrom.push({ ...n, from: m[2] });
    else for (const n of names) localNamed.push(n);
  }

  const imports: ParsedModule['imports'] = {};
  for (const m of content.matchAll(IMPORT_NAMED_RE)) {
    for (const n of parseNamesClause(m[1])) imports[n.exported] = { orig: n.orig, from: m[2] };
  }
  return { declared, starFrom, namedFrom, localNamed, imports };
}

/** './x.js' → importerDir/x.d.ts；非相对引用返回 null（dist d.ts 内均为相对引用） */
function resolveDts(fromSpec: string, importerDir: string): string | null {
  if (!fromSpec.startsWith('.')) return null;
  return join(importerDir, fromSpec.replace(/\.js$/, '.d.ts'));
}

/**
 * 递归解析 dist 主入口 d.ts 的完整导出面（名字 → 声明种类）。
 * 模块结果按文件记忆化；`export *` 合并（先到先得，TS 对重名 star 本就判歧义剔除）；
 * named 重导出（含 as 别名）与「import 后裸 export {}」都解析到真实声明处取种类。
 */
export function extractApiSurface(distDir: string): Record<string, Kind> {
  const memo = new Map<string, Record<string, Kind>>();
  const inProgress = new Set<string>();

  const exportsOf = (file: string): Record<string, Kind> => {
    const key = file.replace(/\\/g, '/');
    if (memo.has(key)) return memo.get(key)!;
    if (inProgress.has(key)) return {}; // 环保护
    inProgress.add(key);
    const parsed = parseDtsModule(readFileSync(file, 'utf8'));
    const out: Record<string, Kind> = { ...parsed.declared };
    for (const spec of parsed.starFrom) {
      const target = resolveDts(spec, dirname(file));
      if (!target || !existsSync(target)) continue;
      for (const [name, kind] of Object.entries(exportsOf(target))) {
        if (!(name in out)) out[name] = kind;
      }
    }
    for (const re of parsed.namedFrom) {
      const target = resolveDts(re.from, dirname(file));
      if (!target || !existsSync(target)) continue;
      const kind = exportsOf(target)[re.orig];
      if (kind) out[re.exported] = kind;
    }
    for (const re of parsed.localNamed) {
      const imp = parsed.imports[re.orig];
      if (!imp) continue;
      const target = resolveDts(imp.from, dirname(file));
      if (!target || !existsSync(target)) continue;
      const kind = exportsOf(target)[imp.orig];
      if (kind) out[re.exported] = kind;
    }
    inProgress.delete(key);
    memo.set(key, out);
    return out;
  };

  const surface = exportsOf(join(distDir, 'index.d.ts'));
  const sortedNames = Object.keys(surface).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(sortedNames.map((n) => [n, surface[n]]));
}

export interface SurfaceDiff {
  added: string[];
  removed: string[];
  kindChanged: Array<{ name: string; from: Kind; to: Kind }>;
}

export function compareSurface(
  current: Record<string, Kind>,
  baseline: Record<string, Kind>,
): SurfaceDiff {
  const added = Object.keys(current).filter((n) => !(n in baseline));
  const removed = Object.keys(baseline).filter((n) => !(n in current));
  const kindChanged = Object.keys(current)
    .filter((n) => n in baseline && current[n] !== baseline[n])
    .map((name) => ({ name, from: baseline[name], to: current[name] }));
  return { added, removed, kindChanged };
}

/** breaking 判定 + 失败消息（指引走 major 或经批准更新快照的决策） */
export function describeBreaking(diff: SurfaceDiff): string | null {
  const problems: string[] = [];
  if (diff.removed.length > 0) {
    problems.push(`删除/改名的导出（breaking）：${diff.removed.sort().join(', ')}`);
  }
  if (diff.kindChanged.length > 0) {
    problems.push(
      `声明种类变更（breaking）：${diff.kindChanged.map((c) => `${c.name} (${c.from} → ${c.to})`).join(', ')}`,
    );
  }
  if (problems.length === 0) return null;
  return [
    '公开导出面与基线快照不一致（docs/API-STABILITY.md）：',
    ...problems,
    `加性新增（不红，随 minor 更新基线即可）：${diff.added.sort().join(', ') || '（无）'}`,
    '决策：① 恢复导出（保持 1.x 兼容）；或 ② 接受 breaking → 版本走 major；',
    '或 ③ 确属误报/已批准变更 → 更新基线：',
    '  pnpm build && H2_UPDATE_API_SNAPSHOT=1 pnpm --filter @harness2/core exec vitest run test/api-surface.test.ts',
  ].join('\n');
}

function readBaseline(): Record<string, Kind> {
  const fixture = JSON.parse(readFileSync(BASELINE_FIXTURE, 'utf8')) as {
    exports: Record<string, Kind>;
  };
  return fixture.exports;
}

function sortKeysDeep(value: Record<string, Kind>): Record<string, Kind> {
  return Object.fromEntries(
    Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => [k, value[k]]),
  );
}

describe('公开导出面快照（@harness2/core 主入口）', () => {
  it('当前导出面与基线 fixture 一致（删除/改名/种类变更即红，加性不红）', () => {
    const indexDts = join(DIST_DIR, 'index.d.ts');
    if (!existsSync(indexDts)) {
      throw new Error('dist/index.d.ts 不存在——先跑 pnpm build（根脚本 pnpm test 已含 build）');
    }
    const current = extractApiSurface(DIST_DIR);
    // 基线量级护栏：导出面应有数百个名字，若解析器坏掉（≈0）立刻暴露
    expect(Object.keys(current).length).toBeGreaterThan(100);

    if (process.env.H2_UPDATE_API_SNAPSHOT === '1') {
      mkdirSync(dirname(BASELINE_FIXTURE), { recursive: true });
      writeFileSync(
        BASELINE_FIXTURE,
        `${JSON.stringify({ exports: sortKeysDeep(current) }, null, 2)}\n`,
      );
      return;
    }
    const baseline = readBaseline();
    const diff = compareSurface(current, baseline);
    const breaking = describeBreaking(diff);
    if (breaking) throw new Error(breaking);
    expect(diff).toEqual({ added: [], removed: [], kindChanged: [] });
  });

  it('防漏报交叉校验：运行时值导出 ⊆ 声明导出面', async () => {
    const mod = (await import('../dist/index.js')) as Record<string, unknown>;
    const surface = extractApiSurface(DIST_DIR);
    const missing = Object.keys(mod).filter((k) => !(k in surface));
    expect(missing).toEqual([]);
  });

  it('比对器：新增导出 → 只记 added，不判 breaking（加性政策）', () => {
    const diff = compareSurface({ a: 'function', b: 'class' }, { a: 'function' });
    expect(diff.added).toEqual(['b']);
    expect(diff.removed).toEqual([]);
    expect(diff.kindChanged).toEqual([]);
    expect(describeBreaking(diff)).toBeNull();
  });

  it('比对器：删除/改名导出 → breaking，失败消息含 major/快照指引', () => {
    const removedDiff = compareSurface({ a: 'function' }, { a: 'function', gone: 'class' });
    expect(removedDiff.removed).toEqual(['gone']);
    const renamedDiff = compareSurface(
      { renamed: 'function' },
      { oldName: 'function' },
    );
    expect(renamedDiff.removed).toEqual(['oldName']);
    expect(renamedDiff.added).toEqual(['renamed']);
    const message = describeBreaking(renamedDiff)!;
    expect(message).toContain('breaking');
    expect(message).toContain('major');
    expect(message).toContain('H2_UPDATE_API_SNAPSHOT');
    expect(describeBreaking(removedDiff)).toContain('gone');
  });

  it('比对器：声明种类变更（签名摘要）→ breaking', () => {
    const diff = compareSurface({ a: 'const' }, { a: 'function' });
    expect(diff.kindChanged).toEqual([{ name: 'a', from: 'function', to: 'const' }]);
    expect(describeBreaking(diff)).toContain('a (function → const)');
  });

  it('提取器：合成 d.ts 图（export * 链 / named 别名重导出 / import 后裸 export）提取正确', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h2-api-surface-'));
    try {
      writeFileSync(
        join(dir, 'index.d.ts'),
        [
          "export * from './a.js';",
          "export { renameMe as renamed } from './b.js';",
          "export { CORE_VERSION } from './version.js';",
          "export * from './c.js';",
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(dir, 'a.d.ts'),
        [
          'export declare function foo(x: number): string;',
          'export interface Bar { x: number }',
          'export type Qux<T> = { v: T };',
          'export declare const CONST_A = 1;',
          'export declare abstract class Klass {}',
          'export enum En { A }',
          '',
        ].join('\n'),
      );
      writeFileSync(join(dir, 'b.d.ts'), 'export declare function renameMe(): void;\n');
      writeFileSync(join(dir, 'version.d.ts'), 'export declare const CORE_VERSION = "1.0.0";\n');
      // import 后裸 export {}（tsc 对 re-export 导入名的常规产物）
      writeFileSync(
        join(dir, 'c.d.ts'),
        ["import type { Impl } from './impl.js';", 'export { Impl };', ''].join('\n'),
      );
      writeFileSync(join(dir, 'impl.d.ts'), 'export interface Impl { run(): void }\n');

      const surface = extractApiSurface(dir);
      expect(surface).toEqual({
        CONST_A: 'const',
        Bar: 'interface',
        CORE_VERSION: 'const',
        En: 'enum',
        Impl: 'interface',
        Klass: 'class',
        Qux: 'type',
        foo: 'function',
        renamed: 'function',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
