// T2 门控接线测试：shouldUseInk 基于纯决策函数实现，
// 覆盖 HARNESS2_NO_TUI=1 / --no-tui / HARNESS2_TUI=1 / 非 TTY / Windows 四场景。
import { describe, expect, it } from 'vitest';
import { shouldUseInk } from '../../src/tui/runInkChat.js';

const WIN = 'win32' as NodeJS.Platform;
const LINUX = 'linux' as NodeJS.Platform;

describe('shouldUseInk：门控接线', () => {
  it('HARNESS2_NO_TUI=1 → false', () => {
    expect(shouldUseInk([], { HARNESS2_NO_TUI: '1' }, true, LINUX)).toBe(false);
  });

  it('--no-tui → false', () => {
    expect(shouldUseInk(['--no-tui'], {}, true, LINUX)).toBe(false);
  });

  it('HARNESS2_TUI=1 显式覆盖（即使非 TTY）→ true', () => {
    expect(shouldUseInk([], { HARNESS2_TUI: '1' }, false, WIN)).toBe(true);
  });

  it('HARNESS2_NO_TUI=1 优先于 HARNESS2_TUI=1 → false', () => {
    expect(shouldUseInk([], { HARNESS2_NO_TUI: '1', HARNESS2_TUI: '1' }, true, LINUX)).toBe(false);
  });

  it('非 TTY 且无覆盖 → false', () => {
    expect(shouldUseInk([], { TERM: 'xterm' }, false, LINUX)).toBe(false);
  });

  it('非 Windows TTY → true', () => {
    expect(shouldUseInk([], { TERM: 'xterm-256color' }, true, LINUX)).toBe(true);
  });

  it('Windows 现代终端标记（WT_SESSION / TERM_PROGRAM）→ true', () => {
    expect(shouldUseInk([], { WT_SESSION: 'x' }, true, WIN)).toBe(true);
    expect(shouldUseInk([], { TERM_PROGRAM: 'vscode' }, true, WIN)).toBe(true);
  });

  it('Windows 传统控制台（cmd.exe / PowerShell 5.1 无标记）→ false', () => {
    expect(shouldUseInk([], {}, true, WIN)).toBe(false);
    expect(shouldUseInk([], { TERM: undefined }, true, WIN)).toBe(false);
  });
});
