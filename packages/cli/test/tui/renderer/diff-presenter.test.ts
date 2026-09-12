// T2-2 差量刷新单测：双 buffer diff → 只重写变化段；宽字符续列回退首列；
// resize 全量重绘；present() 返回字节数；空 diff 零输出。全部接内存流，headless 可跑。
import { describe, expect, it } from 'vitest';
import { CellBuffer, fgToCode } from '../../../src/tui/renderer/cell-buffer.js';
import { DiffPresenter } from '../../../src/tui/renderer/diff-presenter.js';

class MemOut {
  private chunks: string[] = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  get text(): string {
    return this.chunks.join('');
  }
  get bytes(): number {
    return Buffer.byteLength(this.chunks.join(''));
  }
  clear(): void {
    this.chunks = [];
  }
}

describe('DiffPresenter 差量输出', () => {
  it('首帧全量绘制：包含 CUP 与内容', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const buf = new CellBuffer(10, 3);
    buf.writeText(0, 'hello');
    const n = p.present(buf);
    expect(n).toBeGreaterThan(0);
    expect(out.text).toContain('\x1b[1;1H');
    expect(out.text).toContain('hello');
  });

  it('空 diff 零输出，返回 0 字节', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const buf = new CellBuffer(10, 3);
    buf.writeText(0, 'hello');
    p.present(buf);
    out.clear();
    expect(p.present(buf)).toBe(0);
    expect(out.text).toBe('');
  });

  it('局部变化只重写变化行，不重复输出未变内容', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const buf = new CellBuffer(20, 3);
    buf.writeText(0, 'aaaa');
    buf.writeText(1, 'bbbb');
    p.present(buf);
    out.clear();
    buf.writeText(2, 'cccc');
    const n = p.present(buf);
    expect(n).toBeGreaterThan(0);
    expect(out.text).toContain('cccc');
    expect(out.text).not.toContain('aaaa');
    expect(out.text).not.toContain('bbbb');
    expect(out.text).toContain('\x1b[3;1H'); // 第 3 行（1-based）
  });

  it('变化段起点落在宽字符续列时回退到首列，完整输出宽字符', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const front = new CellBuffer(6, 1);
    // 手工构造：col1..2 为宽字符，col3 变化 → 变化段起点 col3 不在续列；
    // 再让 col2（续列）单独变化：先呈现 front
    front.setCell(0, 0, 'a', 1, 0);
    front.setCell(1, 0, '中', 2, 0);
    front.setCell(3, 0, 'b', 1, 0);
    p.present(front);
    out.clear();
    const next = new CellBuffer(6, 1);
    next.setCell(0, 0, 'a', 1, 0);
    next.setCell(1, 0, '中', 2, 0);
    next.setCell(2, 0, 'x', 1, 0); // 原续列位置变为独立半宽字符
    next.setCell(3, 0, 'b', 1, 0);
    p.present(next);
    // 段起点 col2 是上一帧宽字符的续列 → 回退到 col1（首列），重写 "中x"
    expect(out.text).toContain('\x1b[1;2H'); // (x=1,y=0) → 1-based 列 2
    expect(out.text).toContain('中x');
  });

  it('宽字符首列变化时连带续列，输出一个宽字符且光标前进 2 列', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const front = new CellBuffer(6, 1);
    front.writeText(0, '中b');
    p.present(front);
    out.clear();
    const next = new CellBuffer(6, 1);
    next.writeText(0, '文b');
    p.present(next);
    expect(out.text).toContain('\x1b[1;1H');
    expect(out.text).toContain('文');
    // 呈现后 front 已同步，再 present 应零输出（证明续列连带同步正确）
    out.clear();
    expect(p.present(next)).toBe(0);
  });

  it('颜色变化发射 SGR truecolor 序列，段尾复位', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const buf = new CellBuffer(8, 1);
    buf.writeText(0, 'hi', fgToCode('#ff0000'));
    p.present(buf);
    expect(out.text).toContain('\x1b[38;2;255;0;0m');
    expect(out.text).toContain('\x1b[0m');
  });

  it('跨段颜色切换：每段独立发射颜色', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const buf = new CellBuffer(8, 1);
    buf.writeText(0, 'a', fgToCode('#ff0000'));
    buf.setCell(1, 0, 'b', 1, fgToCode('#00ff00'));
    p.present(buf);
    expect(out.text).toContain('\x1b[38;2;255;0;0m');
    expect(out.text).toContain('\x1b[38;2;0;255;0m');
    expect(out.text).toContain('\x1b[38;2;255;0;0ma');
    expect(out.text).toContain('\x1b[38;2;0;255;0mb');
  });

  it('尺寸变化：全量重绘（先清屏）', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const buf = new CellBuffer(10, 3);
    buf.writeText(0, 'hello');
    p.present(buf);
    out.clear();
    const buf2 = new CellBuffer(8, 4);
    buf2.writeText(0, 'world');
    p.present(buf2);
    expect(out.text).toContain('\x1b[2J');
    expect(out.text).toContain('world');
  });

  it('多行变化：输出多个 CUP 定位', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const buf = new CellBuffer(10, 4);
    buf.writeText(0, 'aaa');
    p.present(buf);
    out.clear();
    buf.writeText(1, 'bbb');
    buf.writeText(3, 'ddd');
    p.present(buf);
    expect(out.text).toContain('\x1b[2;1H');
    expect(out.text).toContain('\x1b[4;1H');
  });

  it('字节数与实际写入一致（含 CJK 多字节）', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const buf = new CellBuffer(10, 2);
    buf.writeText(0, '中文');
    const n = p.present(buf);
    expect(n).toBe(out.bytes);
    expect(n).toBeGreaterThan('中文'.length); // UTF-8 字节数 > 字符数
  });
});
