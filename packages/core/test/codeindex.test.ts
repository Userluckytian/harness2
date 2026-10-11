// A22 语义代码索引 —— 存储/增量/查询/命令面测试（Z6 批次7-A）。
//
// 全部用**临时目录自造 fixture**，不依赖仓库真实源码，也不触真实 ~/.harness2（home/indexPath 注入）。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  CODE_INDEX_FILE,
  CODEINDEX_COMMAND_ID,
  CodeIndexStore,
  HARD_QUERY_LIMIT,
  MAX_QUERY_RESULTS,
  codeIndexFilePath,
  createCodeIndexRuntime,
  defaultCodeIndexRoot,
  encodeCwd,
  findCoreCommand,
  loadCodeIndex,
  nameMatches,
  parseCoreCommand,
  registerCodeIndexCommand,
  resetCoreCommands,
  runCoreCommand,
  type CoreCommandContext,
} from '../src/index.js';

const dirs: string[] = [];

function tmpDir(prefix = 'h2-codeindex-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function put(root: string, rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** 默认索引文件放在 root 内（.json 非支持语言，且被显式忽略，不参与索引）。 */
function mkStore(root: string, extra: Record<string, unknown> = {}): CodeIndexStore {
  return new CodeIndexStore({ root, indexPath: join(root, 'code.index.json'), ...extra });
}

function makeCtx(cwd: string): CoreCommandContext & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    print: (text: string) => lines.push(text),
    manager: {} as never,
    cwd,
    current: () => null,
    switchSession: () => {},
    requestExit: () => {},
    snapshots: () => undefined,
  };
}

afterEach(() => {
  resetCoreCommands();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('A22 索引构建与忽略规则', () => {
  it('只索引支持语言的普通文件；node_modules/.git/隐藏目录被忽略', () => {
    const root = tmpDir();
    put(root, 'src/a.ts', 'export function shared() { return 1; }\n');
    put(root, 'lib/b.py', 'def pyfunc():\n    return 1\n');
    put(root, 'node_modules/pkg/c.ts', 'export function vendored() {}\n');
    put(root, '.git/d.ts', 'export function gitOnly() {}\n');
    put(root, '.hidden/e.ts', 'export function hiddenOnly() {}\n');
    put(root, 'README.md', '# not indexed\n');

    const store = mkStore(root);
    const stats = store.rebuild();
    expect(stats.scanned).toBe(2); // 仅 src/a.ts + lib/b.py
    expect(stats.parsed).toBe(2);
    expect(store.status().files).toBe(2);
    expect(store.findDefinitions('shared').map((h) => h.file)).toEqual(['src/a.ts']);
    expect(store.findDefinitions('pyfunc').map((h) => h.file)).toEqual(['lib/b.py']);
    for (const ghost of ['vendored', 'gitOnly', 'hiddenOnly']) {
      expect(store.findDefinitions(ghost)).toEqual([]);
    }
  });

  it('定义命中含 文件/1基行/1基列/种类/所在行文本', () => {
    const root = tmpDir();
    put(root, 'src/a.ts', 'export function shared(): number { return 1; }\n');
    const store = mkStore(root);
    store.rebuild();
    const hits = store.findDefinitions('shared');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      name: 'shared',
      kind: 'function',
      language: 'typescript',
      file: 'src/a.ts',
      line: 1,
      column: 17,
      text: 'export function shared(): number { return 1; }',
    });
  });

  it('索引可从磁盘重新加载（新实例读同一索引文件）', () => {
    const root = tmpDir();
    put(root, 'src/a.ts', 'export const A = 1;\n');
    mkStore(root).rebuild();
    const fresh = mkStore(root);
    expect(fresh.findDefinitions('A').map((h) => h.kind)).toEqual(['constant']);
  });
});

describe('A22 引用查询', () => {
  it('跨文件引用：定义位点 isDefinition=true，使用处 false，且带行文本', () => {
    const root = tmpDir();
    put(root, 'src/a.ts', 'export function shared(): number { return 1; }\n');
    put(root, 'src/b.ts', "import { shared } from './a.js';\nexport const v = shared();\n");
    const store = mkStore(root);
    store.rebuild();

    const refs = store.findReferences('shared');
    expect(refs).toHaveLength(3);
    const defSite = refs.find((r) => r.file === 'src/a.ts');
    expect(defSite).toMatchObject({ line: 1, column: 17, isDefinition: true });
    const uses = refs.filter((r) => r.file === 'src/b.ts');
    expect(uses.map((r) => r.line).sort()).toEqual([1, 2]);
    expect(uses.every((r) => r.isDefinition === false)).toBe(true);
    expect(uses.find((r) => r.line === 2)?.text).toBe('export const v = shared();');
  });

  it('字符串/注释里的同名标识符不计入引用（掩码生效）', () => {
    const root = tmpDir();
    put(root, 'src/a.ts', 'export function shared() {}\n// shared\nconst s = "shared";\n');
    const store = mkStore(root);
    store.rebuild();
    const refs = store.findReferences('shared');
    // 仅定义位点一处；注释与字符串里的 shared 被掩码
    expect(refs).toHaveLength(1);
    expect(refs[0]?.isDefinition).toBe(true);
  });
});

describe('A22 名称匹配口径', () => {
  it('默认不区分大小写精确匹配；caseSensitive/prefix/substring 可切', () => {
    const root = tmpDir();
    put(root, 'src/a.ts', 'export const Alpha = 1;\nexport const alphabet = 2;\nexport const Beta = 3;\n');
    const store = mkStore(root);
    store.rebuild();

    expect(store.findDefinitions('alpha').map((h) => h.name)).toEqual(['Alpha']);
    expect(store.findDefinitions('alpha', { caseSensitive: true })).toEqual([]);
    expect(store.findDefinitions('Alpha', { caseSensitive: true }).map((h) => h.name)).toEqual(['Alpha']);
    expect(
      store
        .findDefinitions('alph', { match: 'prefix' })
        .map((h) => h.name)
        .sort(),
    ).toEqual(['Alpha', 'alphabet']);
    expect(store.findDefinitions('phab', { match: 'substring' }).map((h) => h.name)).toEqual(['alphabet']);
    expect(nameMatches('Alpha', 'alpha')).toBe(true);
    expect(nameMatches('Alpha', 'alpha', { caseSensitive: true })).toBe(false);
  });
});

describe('A22 结果上限截断', () => {
  it('默认上限 MAX_QUERY_RESULTS；显式 limit 生效；超硬上限钳制', () => {
    const root = tmpDir();
    const lines: string[] = [];
    for (let i = 0; i < 250; i++) lines.push(`export const sym${i} = ${i};`);
    put(root, 'src/many.ts', `${lines.join('\n')}\n`);
    const store = mkStore(root);
    store.rebuild();

    expect(store.findDefinitions('sym', { match: 'substring' })).toHaveLength(MAX_QUERY_RESULTS);
    expect(store.findDefinitions('sym', { match: 'substring', limit: 5 })).toHaveLength(5);
    // 只有 250 个匹配，即便 limit 超硬上限也只返回实际匹配数
    expect(store.findDefinitions('sym', { match: 'substring', limit: HARD_QUERY_LIMIT + 999 })).toHaveLength(250);
  });
});

describe('A22 增量更新', () => {
  it('复用 → 变更 → 新增 → 删除 → mtime 抖动复用（哈希判定）', () => {
    const root = tmpDir();
    put(root, 'src/a.ts', 'export const A = 1;\n');
    const store = mkStore(root);
    store.rebuild();

    // 无变化：全部复用
    const noop = store.update();
    expect(noop).toMatchObject({ reused: 1, added: 0, changed: 0, removed: 0, definitions: 1 });

    // 内容变更（长度变化 → 哈希变化 → 重新解析）
    put(root, 'src/a.ts', 'export const A = 2;\nexport const B = 3;\n');
    const changed = store.update();
    expect(changed).toMatchObject({ reused: 0, added: 0, changed: 1, removed: 0, definitions: 2 });
    expect(store.findDefinitions('B')).toHaveLength(1);

    // 新增文件
    put(root, 'src/c.ts', 'export function C() {}\n');
    const added = store.update();
    expect(added).toMatchObject({ reused: 1, added: 1, changed: 0, removed: 0, definitions: 3 });

    // 删除文件（含改名语义：改名 = 删 + 增）
    rmSync(join(root, 'src/a.ts'));
    const removed = store.update();
    expect(removed).toMatchObject({ added: 0, changed: 0, removed: 1 });
    expect(store.findDefinitions('A')).toEqual([]);
    expect(store.findDefinitions('C')).toHaveLength(1);

    // mtime 抖动但内容不变 → 哈希一致 → 复用（不重解析）
    const cPath = join(root, 'src/c.ts');
    const future = new Date(Date.now() + 5000);
    utimesSync(cPath, future, future);
    const touched = store.update();
    expect(touched).toMatchObject({ reused: 1, added: 0, changed: 0, removed: 0 });
  });
});

describe('A22 容错（红线：损坏索引不抛，回落重建）', () => {
  it('索引文件损坏：loadCodeIndex 返回 null；status 如实为空；update 回落全量重建', () => {
    const root = tmpDir();
    put(root, 'src/a.ts', 'export const A = 1;\n');
    const store = mkStore(root);
    store.rebuild();
    const indexPath = join(root, 'code.index.json');

    writeFileSync(indexPath, '{ this is not json');
    expect(loadCodeIndex(indexPath)).toBeNull();
    expect(loadCodeIndex(join(root, 'missing.json'))).toBeNull();

    const fresh = mkStore(root);
    expect(fresh.status()).toMatchObject({ files: 0, exists: true, builtAt: '' });
    const recovered = fresh.update(); // 回落全量重建
    expect(recovered).toMatchObject({ added: 1, reused: 0, changed: 0, removed: 0 });
    expect(fresh.findDefinitions('A')).toHaveLength(1);
    expect(fresh.status().files).toBe(1);
  });

  it('代际不符（v 非当前）也回落重建', () => {
    const root = tmpDir();
    put(root, 'src/a.ts', 'export const A = 1;\n');
    mkStore(root).rebuild();
    const indexPath = join(root, 'code.index.json');
    const data = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
    data['v'] = 999;
    writeFileSync(indexPath, JSON.stringify(data));
    expect(loadCodeIndex(indexPath)).toBeNull();
    const fresh = mkStore(root);
    expect(fresh.update()).toMatchObject({ added: 1 });
  });
});

describe('A22 落盘位置遵循数据根约定', () => {
  it('默认路径 = <home>/.harness2/codeindex/<encodeCwd(root)>/code.index.json', () => {
    const home = tmpDir();
    const root = tmpDir();
    expect(defaultCodeIndexRoot(home)).toBe(join(home, '.harness2', 'codeindex'));
    expect(codeIndexFilePath(root, home)).toBe(
      join(home, '.harness2', 'codeindex', encodeCwd(resolve(root)), CODE_INDEX_FILE),
    );

    put(root, 'src/a.ts', 'export function f() {}\n');
    const store = new CodeIndexStore({ root, home }); // 不显式注入 indexPath → 走约定
    store.rebuild();
    const expected = codeIndexFilePath(root, home);
    expect(existsSync(expected)).toBe(true);
    expect(store.indexPath).toBe(expected);
  });
});

describe('A22 `/codeindex` 命令面（扩展命令缝）', () => {
  it('注册为 extension 命令；rebuild/status/def/ref 输出可用；未知子命令报错', () => {
    const root = tmpDir();
    const idxDir = tmpDir();
    put(root, 'src/a.ts', 'export function hello() { return hello; }\n');
    const runtime = createCodeIndexRuntime({ cwd: root, indexPathFor: () => join(idxDir, 'code.index.json') });
    const dispose = registerCodeIndexCommand(runtime);

    const cmd = findCoreCommand(CODEINDEX_COMMAND_ID);
    expect(cmd?.source).toBe('extension');
    expect(cmd?.group).toBe('通用');

    const ctx = makeCtx(root);
    const run = (line: string): void => {
      const parsed = parseCoreCommand(line);
      expect(parsed).not.toBeNull();
      if (parsed !== null) void runCoreCommand(parsed, ctx);
    };

    run('/codeindex rebuild');
    expect(ctx.lines.join('\n')).toContain('重建完成');
    ctx.lines.length = 0;

    run('/codeindex status');
    expect(ctx.lines.join('\n')).toContain('已索引文件：1');
    ctx.lines.length = 0;

    run('/codeindex def hello');
    expect(ctx.lines.some((l) => l.includes('hello（函数）') && l.includes('src/a.ts:1:17'))).toBe(true);
    ctx.lines.length = 0;

    run('/codeindex ref hello');
    expect(ctx.lines.some((l) => l.includes('[定义]'))).toBe(true);
    ctx.lines.length = 0;

    run('/codeindex bogus');
    expect(ctx.lines[0]).toContain('error: 未知子命令');

    dispose();
    expect(findCoreCommand(CODEINDEX_COMMAND_ID)).toBeUndefined();
  });

  it('重建后增量更新命令可用（update 输出复用计数）', () => {
    const root = tmpDir();
    const idxDir = tmpDir();
    put(root, 'src/a.ts', 'export const A = 1;\n');
    const runtime = createCodeIndexRuntime({ cwd: root, indexPathFor: () => join(idxDir, 'code.index.json') });
    const dispose = registerCodeIndexCommand(runtime);
    const ctx = makeCtx(root);
    void runCoreCommand(parseCoreCommand('/codeindex rebuild')!, ctx);
    ctx.lines.length = 0;
    void runCoreCommand(parseCoreCommand('/codeindex update')!, ctx);
    expect(ctx.lines.join('\n')).toContain('复用 1');
    dispose();
  });
});
