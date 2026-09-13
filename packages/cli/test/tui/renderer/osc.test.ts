// P4-1 OSC 序列构造单测：OSC8 超链接开/闭与 OSC52 剪贴板复制（零依赖，Node 内置 Buffer）。
// 红绿流程：先于实现落盘（红），实现后转绿（日志存 Temp/p4a-evidence）。
import { describe, expect, it } from 'vitest';
import { OSC8_CLOSE, osc52Copy, osc8Open } from '../../../src/tui/renderer/osc.js';

describe('OSC8 超链接序列', () => {
  it('osc8Open：\\x1b]8;;URL\\x1b\\\\ 包裹（空 params 形式）', () => {
    expect(osc8Open('https://example.com/a')).toBe('\x1b]8;;https://example.com/a\x1b\\');
  });

  it('OSC8_CLOSE：空 URL 的关闭序列', () => {
    expect(OSC8_CLOSE).toBe('\x1b]8;;\x1b\\');
  });
});

describe('OSC52 剪贴板复制序列', () => {
  it('ASCII 文本：base64(selection) 编码进 \\x1b]52;c;…\\x1b\\\\', () => {
    const text = 'hello selection';
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    expect(osc52Copy(text)).toBe(`\x1b]52;c;${b64}\x1b\\`);
  });

  it('非 ASCII（CJK）文本：按 UTF-8 编码 base64', () => {
    const text = '中文选择';
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    expect(osc52Copy(text)).toBe(`\x1b]52;c;${b64}\x1b\\`);
  });

  it('空文本：合法的空 payload 序列（不抛错）', () => {
    expect(osc52Copy('')).toBe('\x1b]52;c;\x1b\\');
  });
});
