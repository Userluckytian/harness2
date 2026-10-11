// A22 语义代码索引 —— 解析器/语言分派/误报控制测试（Z6 批次7-A）。
//
// 关键质量点（本文件钉死）：**注释与字符串里的假符号绝不误报**——
// 覆盖 TS 行/块注释与字符串、JS 模板串、Python docstring/字符串、Go 原始串、Rust/Java 注释。
import { describe, expect, it } from 'vitest';
import { languageForFile, parseSource, symbolKindLabel, type IndexedDefinition } from '../src/index.js';

function parse(src: string, file = 'x.ts') {
  const spec = languageForFile(file);
  if (spec === undefined) throw new Error(`no language for ${file}`);
  return parseSource(src, spec);
}

function keys(src: string, file = 'x.ts'): string[] {
  return parse(src, file).definitions.map((d: IndexedDefinition) => `${d.kind}:${d.name}`);
}

function find(defs: IndexedDefinition[], name: string): IndexedDefinition | undefined {
  return defs.find((d) => d.name === name);
}

describe('A22 语言分派（按扩展名）', () => {
  it('常见扩展名分派到语言；未知扩展名返回 undefined（文件级跳过）', () => {
    expect(languageForFile('a.ts')?.id).toBe('typescript');
    expect(languageForFile('a.tsx')?.id).toBe('typescript');
    expect(languageForFile('types.d.ts')?.id).toBe('typescript');
    expect(languageForFile('DIR\\sub\\a.JS')?.id).toBe('javascript');
    expect(languageForFile('a.py')?.id).toBe('python');
    expect(languageForFile('a.go')?.id).toBe('go');
    expect(languageForFile('a.rs')?.id).toBe('rust');
    expect(languageForFile('a.java')?.id).toBe('java');
    expect(languageForFile('a.cpp')?.id).toBe('c');
    expect(languageForFile('a.cs')?.id).toBe('csharp');
    expect(languageForFile('README.md')).toBeUndefined();
    expect(languageForFile('.env')).toBeUndefined();
    expect(languageForFile('Makefile')).toBeUndefined();
  });
});

describe('A22 TypeScript/JavaScript 定义提取', () => {
  const TS = [
    'export interface User {',
    '  id: number;',
    '}',
    'export type UserId = string;',
    'export enum Color { Red }',
    'export const MAX_USERS = 10;',
    'let counter = 0;',
    'export function createUser(name: string): User {',
    '  return { id: 1 };',
    '}',
    'export class UserService {',
    '  private cache = new Map();',
    '  async findUser(id: number): Promise<User | undefined> {',
    '    return undefined;',
    '  }',
    '}',
    'const helper = (x: number) => x + 1;',
  ].join('\n');

  it('提取 接口/类型/枚举/常量/变量/函数/类/方法 九类键（恰好 9 个）', () => {
    expect(keys(TS).sort()).toEqual(
      [
        'class:UserService',
        'constant:MAX_USERS',
        'constant:helper',
        'enum:Color',
        'function:createUser',
        'interface:User',
        'method:findUser',
        'type:UserId',
        'variable:counter',
      ].sort(),
    );
  });

  it('行列精确（name 捕获组偏移，非匹配起点）：createUser 在第 8 行第 17 列', () => {
    const def = find(parse(TS).definitions, 'createUser');
    expect(def).toMatchObject({ line: 8, column: 17, kind: 'function' });
    const iface = find(parse(TS).definitions, 'User');
    expect(iface).toMatchObject({ line: 1, column: 18, kind: 'interface' });
  });

  it('方法规则不误捕属性赋值（private cache = new Map()）与控制流', () => {
    const src = ['class A {', '  private cache = new Map();', '  if (x) {', '  }', '}'].join('\n');
    expect(keys(src)).toEqual(['class:A']);
  });

  it('JS/JSX 不启用 interface/type 规则，但函数/类/常量可用', () => {
    const src = ['function f() {}', 'const g = 1;', 'class C {}'].join('\n');
    expect(keys(src, 'a.js').sort()).toEqual(['class:C', 'constant:g', 'function:f'].sort());
    // interface/type 关键词在 JS 中不会被当定义（无对应规则）
    expect(keys('type X = 1;', 'a.js')).toEqual([]);
  });
});

describe('A22 Python 定义提取', () => {
  const PY = [
    'import os',
    '',
    '# def fake_def(): pass',
    'MAX_SIZE = 100',
    '',
    'def real_def():',
    '    """def doc_def(): pass"""',
    '    x = "def str_def(): pass"',
    '    return x',
    '',
    'class RealClass:',
    '    def method(self):',
    '        return 1',
  ].join('\n');

  it('提取 常量/函数/类/方法；顶层零缩进常量规则不误收局部变量', () => {
    expect(keys(PY, 'a.py').sort()).toEqual(
      ['class:RealClass', 'constant:MAX_SIZE', 'function:real_def', 'method:method'].sort(),
    );
  });

  it('docstring 与字符串内的 def 不误报；注释内 def 不误报', () => {
    const defs = parse(PY, 'a.py').definitions.map((d) => d.name);
    expect(defs).not.toContain('fake_def');
    expect(defs).not.toContain('doc_def');
    expect(defs).not.toContain('str_def');
  });
});

describe('A22 Go 定义提取', () => {
  const GO = [
    'package main',
    '',
    '// func fakeGo() {}',
    'func realGo() int { return 1 }',
    '',
    'type Point struct {',
    '\tX int',
    '}',
    '',
    'func (p Point) Move(dx int) int {',
    '\treturn p.X + dx',
    '}',
    '',
    'const MaxN = 10',
  ].join('\n');

  it('提取 函数/结构体/方法/常量', () => {
    expect(keys(GO, 'a.go').sort()).toEqual(['constant:MaxN', 'function:realGo', 'method:Move', 'struct:Point'].sort());
  });

  it('注释里的 func 不误报；结构体字段不误当定义', () => {
    const defs = parse(GO, 'a.go').definitions.map((d) => d.name);
    expect(defs).not.toContain('fakeGo');
    expect(defs).not.toContain('X');
  });
});

describe('A22 Rust 定义提取', () => {
  const RS = [
    '// fn fakeRust() {}',
    'pub struct Config {',
    '    pub name: String,',
    '}',
    '',
    'impl Config {',
    '    pub fn new() -> Config {',
    '        Config { name: String::new() }',
    '    }',
    '    fn hidden(&self) {}',
    '}',
    '',
    'pub fn parse(input: &str) -> Config {',
    '    todo!()',
    '}',
    '',
    'pub const MAX: usize = 10;',
    '',
    'pub enum Mode { Fast, Slow }',
  ].join('\n');

  it('提取 结构体/方法/函数/常量/枚举（含 impl 内缩进 fn 记方法）', () => {
    expect(keys(RS, 'a.rs').sort()).toEqual(
      ['struct:Config', 'method:new', 'method:hidden', 'function:parse', 'constant:MAX', 'enum:Mode'].sort(),
    );
    expect(parse(RS, 'a.rs').definitions.map((d) => d.name)).not.toContain('fakeRust');
  });
});

describe('A22 Java 定义提取', () => {
  const JAVA = [
    '// class FakeJava {}',
    'public class Calculator {',
    '    private int total;',
    '',
    '    public int add(int a, int b) {',
    '        return a + b;',
    '    }',
    '',
    '    public interface Inner {',
    '        void run();',
    '    }',
    '}',
  ].join('\n');

  it('提取 类/方法/嵌套接口；字段与接口方法签名（登记缺口）不提取', () => {
    expect(keys(JAVA, 'a.java').sort()).toEqual(['class:Calculator', 'interface:Inner', 'method:add'].sort());
    const names = parse(JAVA, 'a.java').definitions.map((d) => d.name);
    expect(names).not.toContain('FakeJava');
    expect(names).not.toContain('total');
    expect(names).not.toContain('run');
  });
});

describe('A22 误报控制（注释/字符串掩码）', () => {
  it('TS：行注释/块注释/字符串/模板串中的函数与类不产生定义，也不进引用', () => {
    const src = [
      '// export function fakeFn() {}',
      '/* class FakeClass {} */',
      'export const realThing = 1;',
      'const text = "export function stringFn() {}";',
      'const tpl = `function tplFn() {}`;',
    ].join('\n');
    const parsed = parse(src);
    expect(parsed.definitions.map((d) => d.name).sort()).toEqual(['realThing', 'text', 'tpl'].sort());
    for (const ghost of ['fakeFn', 'FakeClass', 'stringFn', 'tplFn']) {
      expect(Object.keys(parsed.references)).not.toContain(ghost);
    }
  });

  it('引用分词屏蔽注释/字符串内标识符，但保留真实标识符', () => {
    const parsed = parse(['// ghostToken', 'const realToken = 1;'].join('\n'));
    expect(Object.keys(parsed.references)).not.toContain('ghostToken');
    expect(Object.keys(parsed.references)).toContain('realToken');
  });

  it('掩码保留换行：定位行号不因多行注释/字符串偏移', () => {
    const src = ['/*', ' multi', ' line', '*/', 'export function after() {}'].join('\n');
    const def = find(parse(src).definitions, 'after');
    expect(def?.line).toBe(5);
  });

  it('symbolKindLabel 覆盖全部种类（展示口径）', () => {
    expect(symbolKindLabel('function')).toBe('函数');
    expect(symbolKindLabel('method')).toBe('方法');
    expect(symbolKindLabel('struct')).toBe('结构体');
    expect(symbolKindLabel('trait')).toBe('trait');
  });
});
