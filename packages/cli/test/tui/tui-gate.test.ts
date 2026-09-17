// T2 门控接线测试：shouldUseTui 基于纯决策函数实现（P10-A4 由旧门控函数迁移改名，
// 函数实体移至 tui/terminal-capabilities.ts），
// 覆盖 HARNESS2_NO_TUI=1 / --no-tui / HARNESS2_TUI=1 / 非 TTY / Windows 四场景。
import { describe, expect, it } from 'vitest';
import { shouldUseTui } from '../../src/tui/terminal-capabilities.js';

const WIN = 'win32' as NodeJS.Platform;
const LINUX = 'linux' as NodeJS.Platform;

describe('shouldUseTui：门控接线', () => {
  it('HARNESS2_NO_TUI=1 → false', () => {
    expect(shouldUseTui([], { HARNESS2_NO_TUI: '1' }, true, LINUX)).toBe(false);
  });

  it('--no-tui → false', () => {
    expect(shouldUseTui(['--no-tui'], {}, true, LINUX)).toBe(false);
  });

  it('HARNESS2_TUI=1 显式覆盖（即使非 TTY）→ true', () => {
    expect(shouldUseTui([], { HARNESS2_TUI: '1' }, false, WIN)).toBe(true);
  });

  it('HARNESS2_NO_TUI=1 优先于 HARNESS2_TUI=1 → false', () => {
    expect(shouldUseTui([], { HARNESS2_NO_TUI: '1', HARNESS2_TUI: '1' }, true, LINUX)).toBe(false);
  });

  it('非 TTY 且无覆盖 → false', () => {
    expect(shouldUseTui([], { TERM: 'xterm' }, false, LINUX)).toBe(false);
  });

  it('非 Windows TTY → true', () => {
    expect(shouldUseTui([], { TERM: 'xterm-256color' }, true, LINUX)).toBe(true);
  });

  it('Windows 现代终端标记（WT_SESSION / TERM_PROGRAM）→ true', () => {
    expect(shouldUseTui([], { WT_SESSION: 'x' }, true, WIN)).toBe(true);
    expect(shouldUseTui([], { TERM_PROGRAM: 'vscode' }, true, WIN)).toBe(true);
  });

  it('Windows 传统控制台（cmd.exe / PowerShell 5.1 无标记）→ false', () => {
    expect(shouldUseTui([], {}, true, WIN)).toBe(false);
    expect(shouldUseTui([], { TERM: undefined }, true, WIN)).toBe(false);
  });
});
