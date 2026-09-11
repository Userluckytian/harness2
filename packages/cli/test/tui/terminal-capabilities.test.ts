// T2 终端能力纯决策单测（无 ink/react 依赖）：
// detectTerminalCapabilities（非 TTY / dumb TERM / CI / WT_SESSION / VS Code 等标记）、
// decideTuiMode（forceNoTui、forceTui、非 TTY、非 Windows TTY、Windows 四场景闸门）。
import { describe, expect, it } from 'vitest';
import {
  decideTuiMode,
  detectTerminalCapabilities,
  hasModernTerminalMarker,
  type TerminalCapabilities,
} from '../../src/tui/terminal-capabilities.js';

const WIN = 'win32' as NodeJS.Platform;
const LINUX = 'linux' as NodeJS.Platform;

function caps(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, isTTY: boolean): TerminalCapabilities {
  return detectTerminalCapabilities(env, platform, isTTY);
}

describe('detectTerminalCapabilities：能力探测', () => {
  it('非 TTY：rawMode/altScreen/bracketedPaste/resize 全 false，reason 说明非 TTY', () => {
    const c = caps({ TERM: 'xterm-256color' }, LINUX, false);
    expect(c.isTTY).toBe(false);
    expect(c.rawMode).toBe(false);
    expect(c.altScreen).toBe(false);
    expect(c.bracketedPaste).toBe(false);
    expect(c.resize).toBe(false);
    expect(c.reason).toContain('非 TTY');
  });

  it('TERM=dumb：rawMode true（是 TTY），但 altScreen/bracketedPaste/resize false', () => {
    const c = caps({ TERM: 'dumb' }, LINUX, true);
    expect(c.isTTY).toBe(true);
    expect(c.rawMode).toBe(true);
    expect(c.altScreen).toBe(false);
    expect(c.bracketedPaste).toBe(false);
    expect(c.resize).toBe(false);
    expect(c.reason).toContain('dumb');
  });

  it('CI 环境：altScreen/bracketedPaste false，reason 说明 CI', () => {
    const c = caps({ TERM: 'xterm-256color', CI: 'true' }, LINUX, true);
    expect(c.rawMode).toBe(true);
    expect(c.altScreen).toBe(false);
    expect(c.bracketedPaste).toBe(false);
    expect(c.reason).toContain('CI');
  });

  it('WT_SESSION（Windows Terminal）→ modernTerminal true', () => {
    const c = caps({ WT_SESSION: 'abc' }, WIN, true);
    expect(c.modernTerminal).toBe(true);
    expect(c.altScreen).toBe(true);
  });

  it('VS Code 集成终端（TERM_PROGRAM=vscode）→ modernTerminal true', () => {
    const c = caps({ TERM_PROGRAM: 'vscode' }, WIN, true);
    expect(c.modernTerminal).toBe(true);
  });

  it('ConEmu / ANSICON / TERM=xterm 均视为现代终端标记', () => {
    expect(hasModernTerminalMarker({ ConEmuANSI: 'ON' })).toBe(true);
    expect(hasModernTerminalMarker({ ANSICON: '1' })).toBe(true);
    expect(hasModernTerminalMarker({ TERM: 'xterm-256color' })).toBe(true);
    expect(hasModernTerminalMarker({ TERM: 'screen-256color' })).toBe(true);
    expect(hasModernTerminalMarker({ TERM: 'tmux-256color' })).toBe(true);
    expect(hasModernTerminalMarker({})).toBe(false);
  });

  it('普通 POSIX TTY（xterm）：全能力 true，modernTerminal 由 TERM 标记命中', () => {
    const c = caps({ TERM: 'xterm-256color' }, LINUX, true);
    expect(c.rawMode).toBe(true);
    expect(c.altScreen).toBe(true);
    expect(c.bracketedPaste).toBe(true);
    expect(c.resize).toBe(true);
    expect(c.modernTerminal).toBe(true);
  });
});

describe('decideTuiMode：闸门规则', () => {
  it('forceNoTui 优先于一切（包括 forceTui）→ legacy', () => {
    const good = caps({ TERM: 'xterm-256color', WT_SESSION: 'x' }, WIN, true);
    expect(decideTuiMode(good, { forceNoTui: true, forceTui: true }).mode).toBe('legacy');
    expect(decideTuiMode(good, { forceNoTui: true }).reason).toContain('禁用');
  });

  it('forceTui 显式覆盖：非 TTY 也 → ink', () => {
    const c = caps({}, LINUX, false);
    const d = decideTuiMode(c, { forceTui: true });
    expect(d.mode).toBe('ink');
    expect(d.reason.length).toBeGreaterThan(0);
  });

  it('非 TTY → legacy（无覆盖时）', () => {
    const d = decideTuiMode(caps({ TERM: 'xterm' }, LINUX, false));
    expect(d.mode).toBe('legacy');
    expect(d.reason).toContain('非 TTY');
  });

  it('非 Windows TTY → ink', () => {
    const d = decideTuiMode(caps({ TERM: 'xterm-256color' }, LINUX, true));
    expect(d.mode).toBe('ink');
  });

  it('TERM=dumb（任何平台）→ legacy', () => {
    expect(decideTuiMode(caps({ TERM: 'dumb' }, LINUX, true)).mode).toBe('legacy');
    expect(decideTuiMode(caps({ TERM: 'dumb' }, WIN, true)).mode).toBe('legacy');
  });

  it('CI（任何平台）→ legacy', () => {
    expect(decideTuiMode(caps({ TERM: 'xterm', CI: 'true' }, LINUX, true)).mode).toBe('legacy');
    expect(decideTuiMode(caps({ TERM: 'xterm', WT_SESSION: 'x', CI: 'true' }, WIN, true)).mode).toBe('legacy');
  });
});

describe('decideTuiMode：Windows 四场景闸门', () => {
  it('场景 1 Windows Terminal（WT_SESSION）→ ink', () => {
    const d = decideTuiMode(caps({ WT_SESSION: 'guid' }, WIN, true));
    expect(d.mode).toBe('ink');
  });

  it('场景 2 VS Code 集成终端（TERM_PROGRAM=vscode）→ ink', () => {
    const d = decideTuiMode(caps({ TERM_PROGRAM: 'vscode' }, WIN, true));
    expect(d.mode).toBe('ink');
  });

  it('场景 3 传统 cmd.exe（无标记）→ legacy，reason 可读', () => {
    const d = decideTuiMode(caps({}, WIN, true));
    expect(d.mode).toBe('legacy');
    expect(d.reason).toMatch(/传统|cmd|现代终端|marker/i);
  });

  it('场景 4 PowerShell 5.1（无标记）→ legacy', () => {
    const d = decideTuiMode(caps({ TERM: undefined, WT_SESSION: undefined }, WIN, true));
    expect(d.mode).toBe('legacy');
    expect(d.reason.length).toBeGreaterThan(0);
  });

  it('ConEmu / ANSICON / xterm（Git Bash）在 Windows 也 → ink', () => {
    expect(decideTuiMode(caps({ ConEmuANSI: 'ON' }, WIN, true)).mode).toBe('ink');
    expect(decideTuiMode(caps({ ANSICON: '1' }, WIN, true)).mode).toBe('ink');
    expect(decideTuiMode(caps({ TERM: 'xterm-256color' }, WIN, true)).mode).toBe('ink');
  });
});
