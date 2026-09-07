// B8 @file 引用：纯函数单测（协议与终端轨道 T9 一致）。
// 覆盖：extractFileRefs 正则各情形；resolveFileRefs 命中/未找到/64KB 截断/空 cwd 不解析；
// 拼接顺序（块在原始文本前，未找到提示在末尾）。
import { describe, expect, it, vi } from 'vitest';
import {
  FILE_REF_MAX_LEN,
  FILE_REF_NOT_FOUND_SUFFIX,
  FILE_REF_TOKEN_RE,
  FILE_REF_TRUNCATED_SUFFIX,
  extractFileRefs,
  resolveFileRefs,
  type FileRefReader,
} from '../src/shared/file-ref.js';

const okReader = (content: string, truncated = false): FileRefReader =>
  vi.fn(async () => ({ ok: true, content, ...(truncated ? { truncated: true } : {}) }));

describe('extractFileRefs / 正则各情形', () => {
  it('多个 tokens 依次提取', () => {
    expect(extractFileRefs('@a.md 和 @b.txt 的内容')).toEqual(['a.md', 'b.txt']);
  });

  it('重复 token 去重（保留首次顺序）', () => {
    expect(extractFileRefs('@a.md @b.txt @a.md')).toEqual(['a.md', 'b.txt']);
  });

  it('@ 后紧跟空白不触发', () => {
    expect(extractFileRefs('这里的 @ 单独出现')).toEqual([]);
  });

  it('路径遇英文双引号截断 token', () => {
    expect(extractFileRefs('@a"b')).toEqual(['a']);
  });

  it('路径遇英文单引号截断 token', () => {
    expect(extractFileRefs("@a'b")).toEqual(['a']);
  });

  it('无 @ 返回空', () => {
    expect(extractFileRefs('你好，没有引用')).toEqual([]);
  });

  it('空串 / 只有 @ 符号', () => {
    expect(extractFileRefs('')).toEqual([]);
    expect(extractFileRefs('@')).toEqual([]);
  });
});

describe('resolveFileRefs / 拼接顺序与命中', () => {
  it('无 @：finalText 为原文，不触发 readRef', async () => {
    const readRef = vi.fn(async () => ({ ok: true, content: 'x' }));
    const r = await resolveFileRefs('普通消息', undefined, readRef);
    expect(r.finalText).toBe('普通消息');
    expect(r.blocks).toEqual([]);
    expect(r.notFound).toEqual([]);
    expect(readRef).not.toHaveBeenCalled();
  });

  it('cwd 为空：按无 @ 处理，不读文件', async () => {
    const readRef = vi.fn(async () => ({ ok: true, content: 'x' }));
    const r = await resolveFileRefs('@a.md', '', readRef);
    expect(r.finalText).toBe('@a.md');
    expect(r.blocks).toEqual([]);
    expect(readRef).not.toHaveBeenCalled();
  });

  it('命中：代码块拼在原始文本最前，且以 token 作为 cwd 传入', async () => {
    const readRef = okReader('这是文件内容');
    const r = await resolveFileRefs('@README.md 总结一下', 'C:/proj', readRef);
    expect(readRef).toHaveBeenCalledWith('README.md', 'C:/proj');
    expect(r.notFound).toEqual([]);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]).toContain('这是文件内容');
    // 块在原文前
    expect(r.finalText.startsWith(r.blocks[0]!)).toBe(true);
    expect(r.finalText.endsWith('@README.md 总结一下')).toBe(true);
  });

  it('命中内容中不含换行也包成 ``` 代码块', async () => {
    const readRef = okReader('hello');
    const r = await resolveFileRefs('@a.md hi', 'cwd', readRef);
    expect(r.finalText).toContain('```');
  });
});

describe('resolveFileRefs / 未找到与提示', () => {
  it('未找到：跳过 + 消息末尾追加 [@x 未找到，已忽略]', async () => {
    const readRef = vi.fn(async () => ({ ok: false, error: '未找到' }));
    const r = await resolveFileRefs('@missing.txt 请读', 'cwd', readRef);
    expect(r.notFound).toEqual(['missing.txt']);
    expect(r.blocks).toEqual([]);
    expect(r.finalText.endsWith(FILE_REF_NOT_FOUND_SUFFIX.replace('@x', 'missing.txt'))).toBe(true);
    expect(r.finalText).toContain('@missing.txt 请读');
  });

  it('部分命中部分未找到：块在前、原文居中、提示在末尾', async () => {
    const readRef = vi.fn(async (p: string) =>
      p === 'ok.md' ? { ok: true, content: '好的' } : { ok: false, error: '未找到' },
    );
    const r = await resolveFileRefs('@ok.md 和 @bad.md', 'cwd', readRef);
    expect(r.blocks).toHaveLength(1);
    expect(r.notFound).toEqual(['bad.md']);
    expect(r.finalText.startsWith(r.blocks[0]!)).toBe(true);
    expect(r.finalText.endsWith(FILE_REF_NOT_FOUND_SUFFIX.replace('@x', 'bad.md'))).toBe(true);
  });
});

describe('resolveFileRefs / 64KB 截断', () => {
  it('truncated 标记：取前 64KB 并追加截断提示', async () => {
    const long = 'a'.repeat(FILE_REF_MAX_LEN + 1000);
    const readRef = okReader(long, true);
    const r = await resolveFileRefs('@big.md', 'cwd', readRef);
    expect(r.blocks).toHaveLength(1);
    const block = r.blocks[0]!;
    // block 形态：\n```\n<内容>\n```\n → 内容即去掉首尾 ``` 与包裹换行
    const content = block.slice(block.indexOf('```') + 3, block.lastIndexOf('```')).slice(1, -1);
    // 前缀是 64KB 的 'a'，末尾是截断提示
    expect(content.slice(0, FILE_REF_MAX_LEN)).toBe('a'.repeat(FILE_REF_MAX_LEN));
    expect(content.slice(FILE_REF_MAX_LEN)).toBe(FILE_REF_TRUNCATED_SUFFIX.replace('@x', 'big.md'));
  });

  it('未超 64KB：不追加截断提示', async () => {
    const readRef = okReader('短内容');
    const r = await resolveFileRefs('@small.md', 'cwd', readRef);
    expect(r.blocks[0]).not.toContain('截断');
  });
});
