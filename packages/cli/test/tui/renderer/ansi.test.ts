// T2-1 ANSI 转义序列工具单测：CUP / SGR / alt-screen / 鼠标上报 / 光标显隐 / 行清除。
import { describe, expect, it } from 'vitest';
import {
  ALT_SCREEN_ENTER,
  ALT_SCREEN_EXIT,
  CLEAR_LINE,
  CLEAR_SCREEN,
  CLEAR_TO_EOL,
  ESC,
  HIDE_CURSOR,
  MOUSE_OFF,
  MOUSE_ON,
  SHOW_CURSOR,
  SGR_RESET,
  cup,
  sgrFg256,
  sgrFgRgb,
} from '../../../src/tui/renderer/ansi.js';

describe('CUP 定位', () => {
  it('cup(0,0) → ESC[1;1H（1-based）', () => {
    expect(cup(0, 0)).toBe('\x1b[1;1H');
  });

  it('cup(x=3,y=2) → 行;列 顺序', () => {
    expect(cup(3, 2)).toBe('\x1b[3;4H');
  });
});

describe('SGR 颜色', () => {
  it('256 色前景', () => {
    expect(sgrFg256(196)).toBe('\x1b[38;5;196m');
  });

  it('truecolor 前景', () => {
    expect(sgrFgRgb(255, 0, 0)).toBe('\x1b[38;2;255;0;0m');
  });

  it('SGR_RESET', () => {
    expect(SGR_RESET).toBe('\x1b[0m');
  });
});

describe('生命周期序列', () => {
  it('alt-screen 进出用 ?1049h / ?1049l', () => {
    expect(ALT_SCREEN_ENTER).toBe('\x1b[?1049h');
    expect(ALT_SCREEN_EXIT).toBe('\x1b[?1049l');
  });

  it('鼠标上报开关合并序列 ?1000;1002;1006h / l', () => {
    expect(MOUSE_ON).toBe('\x1b[?1000;1002;1006h');
    expect(MOUSE_OFF).toBe('\x1b[?1000;1002;1006l');
  });

  it('光标显隐 ?25l / ?25h', () => {
    expect(HIDE_CURSOR).toBe('\x1b[?25l');
    expect(SHOW_CURSOR).toBe('\x1b[?25h');
  });

  it('行清除：整行 / 行尾 / 整屏', () => {
    expect(CLEAR_LINE).toBe('\x1b[2K');
    expect(CLEAR_TO_EOL).toBe('\x1b[K');
    expect(CLEAR_SCREEN).toBe('\x1b[2J');
  });

  it('ESC 常量', () => {
    expect(ESC).toBe('\x1b');
  });
});
