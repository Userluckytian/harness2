// context-ref 单测：@file/@dir 引用语法（纯函数）——cwd/root 解析顺序、读写失败忽略、
// 64KB 截断、目录列直接子项、无引用不追加。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandContextRefs, hasContextRefs } from '../src/context-ref.js';

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('context-ref：@file/@dir 引用语法', () => {
  it('相对 cwd 的文件：解析出引用块并保留原文', () => {
    const cwd = tmpDir('h2-ref-cwd-');
    writeFileSync(join(cwd, 'README.md'), 'harness2 是什么项目？', 'utf8');
    const out = expandContextRefs('@README.md 请读一下', { cwd, root: cwd });
    expect(out.hasRefs).toBe(true);
    expect(out.header).toContain('[@README.md →');
    expect(out.header).toContain('harness2 是什么项目？');
  });

  it('cwd 找不到时回退 root（root 命中）', () => {
    const cwd = tmpDir('h2-ref-cwd2-');
    const root = tmpDir('h2-ref-root-');
    writeFileSync(join(root, 'note.txt'), 'root 里的文件', 'utf8');
    const out = expandContextRefs('@note.txt 介绍一下', { cwd, root });
    expect(out.hasRefs).toBe(true);
    expect(out.header).toContain('root 里的文件');
  });

  it('目录：列出直接子项（不递归）', () => {
    const cwd = tmpDir('h2-ref-dir-');
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'a.ts'), 'a', 'utf8');
    writeFileSync(join(cwd, 'src', 'b.ts'), 'b', 'utf8');
    const out = expandContextRefs('看 @src 目录', { cwd, root: cwd });
    expect(out.hasRefs).toBe(true);
    expect(out.header).toContain('目录，直接子项');
    expect(out.header).toContain('a.ts');
    expect(out.header).toContain('b.ts');
  });

  it('不存在路径：不报错、追加忽略提示、hasRefs 仍为 true', () => {
    const cwd = tmpDir('h2-ref-missing-');
    const out = expandContextRefs('读 @不存在的文件.md', { cwd, root: cwd });
    expect(out.hasRefs).toBe(true);
    expect(out.header).toContain('@不存在的文件.md');
    expect(out.header).toContain('未找到，已忽略');
  });

  it('单文件超 64KB：截断并含提示', () => {
    const cwd = tmpDir('h2-ref-big-');
    writeFileSync(join(cwd, 'big.txt'), 'x'.repeat(70 * 1024), 'utf8');
    const out = expandContextRefs('@big.txt', { cwd, root: cwd });
    expect(out.hasRefs).toBe(true);
    expect(out.header.length).toBeLessThan(64 * 1024 + 200);
    expect(out.header).toContain('截断');
  });

  it('无引用 token：header 空、hasRefs false', () => {
    const cwd = tmpDir('h2-ref-none-');
    const out = expandContextRefs('没有引用的普通问题', { cwd, root: cwd });
    expect(out.hasRefs).toBe(false);
    expect(out.header).toBe('');
    expect(hasContextRefs('普通问题')).toBe(false);
  });
});
