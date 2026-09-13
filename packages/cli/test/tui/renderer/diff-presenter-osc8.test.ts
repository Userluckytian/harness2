// P4-1 diff-presenter OSC8 run 包裹单测：连续同 linkId 单元格 run 用 OSC8 包裹，
// linkId=0 不包裹；空 diff 零输出不变；HARNESS2_OSC8=0 完全旁路。
// 重点推演：同 linkId 跨帧部分重写时序列闭合正确（每个变化段独立 open+close，必平衡）。
// 红绿流程：先于实现落盘（红），实现后转绿（日志存 Temp/p4a-evidence）。
import { afterEach, describe, expect, it } from 'vitest';
import { CellBuffer } from '../../../src/tui/renderer/cell-buffer.js';
import { DiffPresenter } from '../../../src/tui/renderer/diff-presenter.js';
import { OSC8_CLOSE, osc8Open } from '../../../src/tui/renderer/osc.js';

class MemOut {
  buffer = '';
  write(s: string): unknown {
    this.buffer += s;
    return s.length;
  }
}

const URL_A = 'https://a.io';
const OPEN_A = osc8Open(URL_A);

function countOf(s: string, sub: string): number {
  return s.split(sub).length - 1;
}

/** 在 [from,to) 列区间标记 linkId（测试辅助；URL 注册表下标 1 = URL_A） */
function linkCols(buf: CellBuffer, y: number, from: number, to: number, id: number): void {
  for (let x = from; x < to; x += 1) buf.setLinkId(x, y, id);
}

function makeLinkedRow(cols = 40): CellBuffer {
  const buf = new CellBuffer(cols, 1);
  // 'see https://a.io end'：URL 占列 [4,16)
  buf.writeText(0, 'see https://a.io end');
  const id = buf.registerLink(URL_A);
  linkCols(buf, 0, 4, 16, id);
  return buf;
}

afterEach(() => {
  delete process.env.HARNESS2_OSC8;
});

describe('DiffPresenter OSC8 run 包裹', () => {
  it('首帧行内链接：open 在链接文本前、close 在其后；非链接前后缀不包裹', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const bytes = p.present(makeLinkedRow());
    const s = out.buffer;
    expect(s).toContain(OPEN_A);
    expect(s).toContain(OSC8_CLOSE);
    expect(s.indexOf('see ')).toBeGreaterThanOrEqual(0);
    expect(s.indexOf('see ')).toBeLessThan(s.indexOf(OPEN_A)); // 前缀在 open 之前
    expect(s.indexOf(OSC8_CLOSE)).toBeLessThan(s.indexOf(' end')); // close 在后缀之前
    expect(bytes).toBe(Buffer.byteLength(s)); // 字节数含 OSC8 序列
    expect(bytes).toBeGreaterThan(0);
  });

  it('linkId=0 的纯文本行：零 OSC8 输出（默认行为不变）', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const buf = new CellBuffer(20, 1);
    buf.writeText(0, 'plain text only');
    p.present(buf);
    expect(out.buffer).not.toContain('\x1b]8;;');
  });

  it('一行两个分离链接：两组 open/close，中间非链接文本在 close 之后', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const buf = new CellBuffer(40, 1);
    // 'x https://a.io y https://b.dev z'：URL1 列 [2,14)，URL2 列 [16,28)
    buf.writeText(0, 'x https://a.io y https://b.dev z');
    const idA = buf.registerLink('https://a.io');
    buf.registerLink('https://b.dev');
    linkCols(buf, 0, 2, 14, idA);
    linkCols(buf, 0, 16, 28, idA + 1);
    p.present(buf);
    expect(countOf(out.buffer, OPEN_A)).toBe(1);
    expect(countOf(out.buffer, osc8Open('https://b.dev'))).toBe(1);
    expect(countOf(out.buffer, OSC8_CLOSE)).toBe(2);
  });

  it('链接 run 内前景色变化：SGR 切换不断开 OSC8（1 组 open/close）', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const buf = new CellBuffer(10, 1);
    buf.setCell(0, 0, 'a', 1, 0xff0000);
    buf.setCell(1, 0, 'b', 1, 0xff0000);
    buf.setCell(2, 0, 'c', 1, 0x00ff00);
    buf.setCell(3, 0, 'd', 1, 0x00ff00);
    const id = buf.registerLink(URL_A);
    linkCols(buf, 0, 0, 4, id);
    p.present(buf);
    expect(countOf(out.buffer, OPEN_A)).toBe(1);
    expect(countOf(out.buffer, OSC8_CLOSE)).toBe(1);
    expect(out.buffer).toContain('\x1b[38;2;255;0;0m');
    expect(out.buffer).toContain('\x1b[38;2;0;255;0m');
    // open 先于首个 SGR
    expect(out.buffer.indexOf(OPEN_A)).toBeLessThan(out.buffer.indexOf('\x1b[38;2;255;0;0m'));
  });

  it('空 diff 零输出：第二帧无变化 → present 返回 0 且零 OSC8 重发', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const buf = makeLinkedRow();
    p.present(buf);
    const before = out.buffer.length;
    const bytes = p.present(buf);
    expect(bytes).toBe(0);
    expect(out.buffer.length).toBe(before);
  });

  it('跨帧部分重写：同 linkId 行中间 2 格变化 → 该段独立 open+close（平衡）', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const buf = makeLinkedRow();
    p.present(buf);
    out.buffer = '';
    buf.setCell(6, 0, 'X', 1, 0); // URL run 内部两格改写（linkId 保持 1）
    buf.setCell(7, 0, 'Y', 1, 0);
    p.present(buf);
    expect(out.buffer).toContain('XY');
    expect(countOf(out.buffer, OPEN_A)).toBe(1);
    expect(countOf(out.buffer, OSC8_CLOSE)).toBe(1);
    // open 在文本前、close 在文本后（序列闭合完整）
    expect(out.buffer.indexOf(OPEN_A)).toBeLessThan(out.buffer.indexOf('XY'));
    expect(out.buffer.indexOf(OSC8_CLOSE)).toBeGreaterThan(out.buffer.indexOf('XY'));
  });

  it('链接移除：文本不变、linkId 1→0 → 全段重写且无 OSC8（front 比较纳入 linkId）', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const buf = makeLinkedRow();
    p.present(buf);
    out.buffer = '';
    linkCols(buf, 0, 4, 16, 0); // 链接清除
    p.present(buf);
    expect(out.buffer).not.toContain('\x1b]8;;');
    expect(out.buffer).toContain('https://a.io'); // 文本被重写（无包裹）
  });

  it('加链接：文本不变、linkId 0→1 → 判定为变化并包裹（防链接静默丢失）', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    const buf = new CellBuffer(40, 1);
    buf.writeText(0, 'see https://a.io end');
    p.present(buf);
    out.buffer = '';
    const id = buf.registerLink(URL_A);
    linkCols(buf, 0, 4, 16, id);
    p.present(buf);
    expect(out.buffer).toContain(OPEN_A);
    expect(countOf(out.buffer, OSC8_CLOSE)).toBe(1);
  });

  it('HARNESS2_OSC8=0（构造前）：有 linkId 也零 OSC8 输出（完全旁路）', () => {
    process.env.HARNESS2_OSC8 = '0';
    const out = new MemOut();
    const p = new DiffPresenter(out);
    p.present(makeLinkedRow());
    expect(out.buffer).not.toContain('\x1b]8;;');
    expect(out.buffer).toContain('https://a.io'); // 正文照常输出
  });

  it('osc8Enabled 运行时置 false：同样旁路（开关可编程控制）', () => {
    const out = new MemOut();
    const p = new DiffPresenter(out);
    p.osc8Enabled = false;
    p.present(makeLinkedRow());
    expect(out.buffer).not.toContain('\x1b]8;;');
  });

  it('默认开启（未设置 env）：osc8Enabled = true', () => {
    const p = new DiffPresenter(new MemOut());
    expect(p.osc8Enabled).toBe(true);
  });
});
