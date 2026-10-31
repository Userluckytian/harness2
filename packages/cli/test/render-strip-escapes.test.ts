// stripEscapes 单测（审查 P2-3 回归锚）：CSI SGR 参数白名单收紧。
// 基线语义（安全修复 #308）不变：合法 SGR 颜色序列保留、OSC/危险 CSI/C0/C1 剥离。
// P2-3 收紧：参数字节只认 数字(0x30-0x39)/分号(0x3b)/冒号(0x3a)——`?`/`>` 等私有参数
// 字节的序列（`\x1b[?1049m` 备用屏切换、`\x1b[>4;2m` 私有 SGR 变体）不得再借 'm' 终结
// 伪装成颜色序列被保留。
import { describe, expect, it } from 'vitest';
import { stripEscapes } from '../src/render.js';

describe('stripEscapes：SGR 参数白名单（P2-3 收紧后）', () => {
  it('合法 SGR 颜色序列保留（数字/分号/冒号参数）', () => {
    expect(stripEscapes('a\x1b[31mb')).toBe('a\x1b[31mb'); // 单数字参数
    expect(stripEscapes('a\x1b[1;32mb')).toBe('a\x1b[1;32mb'); // 多参数分号
    expect(stripEscapes('a\x1b[38;5;196mb')).toBe('a\x1b[38;5;196mb'); // 256 色
    expect(stripEscapes('a\x1b[38:5:196mb')).toBe('a\x1b[38:5:196mb'); // 冒号参数（ITU T.416 形态）
    expect(stripEscapes('\x1b[0m')).toBe('\x1b[0m'); // reset
    expect(stripEscapes('\x1b[m')).toBe('\x1b[m'); // 空参数 reset
  });

  it('私有参数字节（? > = <）的 m 终结序列剥离（不得伪装成颜色序列）', () => {
    expect(stripEscapes('\x1b[?1049m')).toBe(''); // DECSET 备用屏缓冲（? 前缀）
    expect(stripEscapes('\x1b[?25l')).toBe(''); // 光标隐藏（h/l 终结，非 m；基线语义）
    expect(stripEscapes('\x1b[>4;2m')).toBe(''); // 私有 SGR 变体（> 前缀，kitty 键盘协议）
    expect(stripEscapes('\x1b[=1m')).toBe(''); // = 私有参数
    expect(stripEscapes('\x1b[<0m')).toBe(''); // < 私有参数
    expect(stripEscapes('x\x1b[?1049my')).toBe('xy'); // 剥离不吞正文
  });

  it('中间字节（0x20-0x2f）不再放行进 m 终结序列', () => {
    // `\x1b[1 m`（参数与终结符间带空格中间字节）：旧口径按「形状合法 SGR」保留，收紧后剥离
    expect(stripEscapes('a\x1b[1 mb')).toBe('ab');
  });

  it('非 SGR 的危险 CSI 与 OSC 照旧剥离（#308 基线不回退）', () => {
    expect(stripEscapes('\x1b[2Jclear')).toBe('clear'); // 清屏
    expect(stripEscapes('\x1b[?1049h')).toBe(''); // 备用屏（h 终结，非 m）
    expect(stripEscapes('\x1b]52;c;aGJj\x07')).toBe(''); // OSC52 剪贴板劫持
    expect(stripEscapes('\x1b]8;;http://evil\x07link\x1b]8;;\x07')).toBe('link'); // OSC8 钓鱼
    expect(stripEscapes('a\x07b\x00c')).toBe('abc'); // C0 控制字符
  });
});
