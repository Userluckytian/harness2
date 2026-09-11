// T2 粘贴内核纯函数单测（无 ink/react 依赖）：
// CRLF/CR → LF 归一、单行 inline vs 多行/超大 chip、UTF-8 字节计数、1MB 限额边界、
// chip 全文保真（绝不截断）、chip 标签人类可读渲染。
import { describe, expect, it } from 'vitest';
import {
  PASTE_INLINE_MAX_BYTES,
  PASTE_MAX_BYTES,
  classifyPaste,
  normalizePaste,
  renderChipLabel,
  type PasteChip,
} from '../../src/tui/paste.js';

describe('paste.ts normalizePaste：换行归一', () => {
  it('CRLF → LF', () => {
    expect(normalizePaste('a\r\nb')).toBe('a\nb');
  });

  it('孤立 CR → LF（老式 Mac / 逐片粘贴）', () => {
    expect(normalizePaste('a\rb')).toBe('a\nb');
  });

  it('已经是 LF 的文本保持不变', () => {
    expect(normalizePaste('a\nb')).toBe('a\nb');
  });

  it('CRLF / CR / LF 混排全部归一', () => {
    expect(normalizePaste('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('单个行尾换行保留（不丢内容，也不额外新增）', () => {
    // 设计决策：单行尾换行视为正文的一部分保留，避免静默改写用户粘贴内容。
    expect(normalizePaste('line\r\n')).toBe('line\n');
    expect(normalizePaste('line\r')).toBe('line\n');
  });

  it('空串', () => {
    expect(normalizePaste('')).toBe('');
  });
});

describe('paste.ts classifyPaste：inline / chip / rejected', () => {
  it('短单行 → inline（原文归一后返回）', () => {
    const r = classifyPaste('hello', 1);
    expect(r).toEqual({ kind: 'inline', text: 'hello' });
  });

  it('多行 → chip，行数与文本正确', () => {
    const r = classifyPaste('a\r\nb', 2);
    expect(r.kind).toBe('chip');
    if (r.kind !== 'chip') throw new Error('unreachable');
    expect(r.chip.id).toBe('2');
    expect(r.chip.text).toBe('a\nb');
    expect(r.chip.lines).toBe(2);
    expect(r.chip.bytes).toBe(3);
  });

  it('超长单行（> inline 上限）→ chip', () => {
    const raw = 'x'.repeat(PASTE_INLINE_MAX_BYTES + 1);
    const r = classifyPaste(raw, 3);
    expect(r.kind).toBe('chip');
    if (r.kind !== 'chip') throw new Error('unreachable');
    expect(r.chip.text).toBe(raw);
    expect(r.chip.lines).toBe(1);
  });

  it('恰好 1MiB 不被拒绝（边界内 → chip）', () => {
    const raw = 'a'.repeat(PASTE_MAX_BYTES);
    const r = classifyPaste(raw, 4);
    expect(PASTE_MAX_BYTES).toBe(1024 * 1024);
    expect(r.kind).toBe('chip');
    if (r.kind !== 'chip') throw new Error('unreachable');
    expect(r.chip.bytes).toBe(PASTE_MAX_BYTES);
  });

  it('超过 1MiB 一个字节 → rejected，含可读原因', () => {
    const raw = 'a'.repeat(PASTE_MAX_BYTES + 1);
    const r = classifyPaste(raw, 5);
    expect(r.kind).toBe('rejected');
    if (r.kind !== 'rejected') throw new Error('unreachable');
    expect(r.reason).toContain('1MB');
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('UTF-8 多字节按字节计数（不是 JS length）', () => {
    // '中' = 3 UTF-8 字节、1 UTF-16 码元：349525 个 = 1048575 字节（< 1MiB）
    const justUnder = '中'.repeat(349_525);
    const under = classifyPaste(justUnder, 6);
    expect(under.kind).toBe('chip');
    if (under.kind !== 'chip') throw new Error('unreachable');
    expect(under.chip.bytes).toBe(1_048_575);
    expect(justUnder.length).toBe(349_525); // JS length 明显小于字节数
    // 再多一个 '中' = 1048578 字节（> 1MiB）→ 拒绝
    const justOver = '中'.repeat(349_526);
    expect(classifyPaste(justOver, 7).kind).toBe('rejected');
  });

  it('归一化后的 CRLF 按 LF 计字节（归一是真实发生的）', () => {
    const r = classifyPaste('a\r\nb', 8);
    if (r.kind !== 'chip') throw new Error('unreachable');
    expect(r.chip.bytes).toBe(3); // 'a\nb' = 3 字节，而非 'a\r\nb' 的 4 字节
  });
});

describe('paste.ts chip 标签与全文保真', () => {
  it('renderChipLabel 产出人类可读标签（#、行数、字节单位）', () => {
    const chip: PasteChip = { id: '1', text: '', lines: 12, bytes: 3481 };
    expect(renderChipLabel(chip)).toBe('[粘贴 #1 · 12 行 · 3.4KB]');
  });

  it('renderChipLabel 小于 1KB 用 B', () => {
    const chip: PasteChip = { id: '2', text: '', lines: 1, bytes: 11 };
    expect(renderChipLabel(chip)).toBe('[粘贴 #2 · 1 行 · 11B]');
  });

  it('chip 保存归一后的完整原文（含全部行，绝不截断）', () => {
    const raw = 'l1\r\nl2\r\nl3';
    const r = classifyPaste(raw, 9);
    if (r.kind !== 'chip') throw new Error('unreachable');
    expect(r.chip.text.split('\n')).toEqual(['l1', 'l2', 'l3']);
    expect(r.chip.bytes).toBe(Buffer.byteLength('l1\nl2\nl3', 'utf8'));
    expect(r.chip.lines).toBe(3);
  });
});
