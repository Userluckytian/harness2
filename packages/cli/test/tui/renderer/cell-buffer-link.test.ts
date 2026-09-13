// P4-1 CellBuffer 单元格模型扩展单测：linkId 并行数组（Uint16Array，0=无链接）+ linkId→URL 注册表。
// 方案取舍（钉死）：并行 typed array 而非单元格对象——保持 chars/widths/fg 既有结构、
// diff 逐格比较仍为平坦数组访问（cache 友好、零逐格对象分配）；选择高亮走 fg 换色不加 bg 位。
// 红绿流程：先于实现落盘（红），实现后转绿（日志存 Temp/p4a-evidence）。
import { describe, expect, it } from 'vitest';
import { CellBuffer } from '../../../src/tui/renderer/cell-buffer.js';

describe('CellBuffer linkId 并行数组', () => {
  it('新 buffer：全部单元格 linkId = 0（无链接）', () => {
    const buf = new CellBuffer(10, 3);
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 10; x += 1) expect(buf.linkIdAt(x, y)).toBe(0);
    }
  });

  it('setLinkId / linkIdAt：逐格写入与读取', () => {
    const buf = new CellBuffer(10, 3);
    buf.setLinkId(2, 1, 7);
    expect(buf.linkIdAt(2, 1)).toBe(7);
    expect(buf.linkIdAt(3, 1)).toBe(0); // 邻格不受影响
  });

  it('setLinkId 越界静默忽略（不抛错）', () => {
    const buf = new CellBuffer(5, 2);
    expect(() => buf.setLinkId(-1, 0, 1)).not.toThrow();
    expect(() => buf.setLinkId(5, 0, 1)).not.toThrow();
    expect(() => buf.setLinkId(0, 2, 1)).not.toThrow();
  });

  it('registerLink：id 从 1 递增，linkUrl(id) 反查 URL', () => {
    const buf = new CellBuffer(5, 2);
    const a = buf.registerLink('https://a.dev');
    const b = buf.registerLink('https://b.dev');
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(buf.linkUrl(1)).toBe('https://a.dev');
    expect(buf.linkUrl(2)).toBe('https://b.dev');
    expect(buf.linkUrl(0)).toBeUndefined(); // 0 = 无链接哨兵
    expect(buf.linkUrl(3)).toBeUndefined();
  });

  it('clear()：linkId 全归零 + 注册表重置（新帧 id 重新从 1 分配）', () => {
    const buf = new CellBuffer(5, 2);
    buf.setLinkId(0, 0, buf.registerLink('https://a.dev'));
    buf.clear();
    expect(buf.linkIdAt(0, 0)).toBe(0);
    const id = buf.registerLink('https://b.dev');
    expect(id).toBe(1); // 注册表已清空，重新从 1 开始
    expect(buf.linkUrl(1)).toBe('https://b.dev');
  });

  it('resize()：左上重叠区域的 linkId 保留', () => {
    const buf = new CellBuffer(6, 3);
    buf.setLinkId(1, 1, 5);
    buf.setLinkId(4, 2, 9);
    buf.resize(4, 2);
    expect(buf.linkIdAt(1, 1)).toBe(5);
    expect(buf.linkIdAt(4, 2)).toBe(0); // 超出新尺寸的格子不保留
  });

  it('宽字符续列格：linkId 可独立标记（首列与续列分开管理）', () => {
    const buf = new CellBuffer(6, 2);
    buf.setCell(0, 0, '中', 2, 0xff0000); // 首列 + 续列
    buf.setLinkId(0, 0, 3);
    buf.setLinkId(1, 0, 3);
    expect(buf.linkIdAt(0, 0)).toBe(3);
    expect(buf.linkIdAt(1, 0)).toBe(3);
  });

  it('linkId 写入不影响既有三元组（char/width/fg 原样）', () => {
    const buf = new CellBuffer(6, 2);
    buf.setCell(2, 0, 'A', 1, 0x00ff00);
    buf.setLinkId(2, 0, 4);
    expect(buf.chars[2]).toBe('A');
    expect(buf.widths[2]).toBe(1);
    expect(buf.fg[2]).toBe(0x00ff00);
  });
});
