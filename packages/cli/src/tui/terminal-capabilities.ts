// terminal-capabilities.ts — 终端能力探测与 TUI 闸门（纯决策，零 ink/react 依赖，可单测）。
//
// 契约见 docs/issue-log/2026-09-11-T.md §7。设计原则：保守。
//  - rawMode 需要 TTY；altScreen / bracketedPaste / resize 还要求非 `dumb` TERM 且不在 CI。
//  - Windows 四场景闸门（显式纯函数 decideWindowsTuiMode）：
//      Windows Terminal(WT_SESSION) / VS Code(TERM_PROGRAM) / ConEmu(ConEmuANSI=ON) / ANSICON /
//      TERM=xterm|screen|tmux  → ink；
//      传统 cmd.exe / PowerShell 5.1（无任何现代终端标记）→ legacy，附可读原因。
//  - 显式覆盖优先：forceNoTui（HARNESS2_NO_TUI=1 / --no-tui）> forceTui（HARNESS2_TUI=1）> 自动探测。
//
// TerminalCapabilities.modernTerminal 为契约外的只读补充字段，供 Windows 闸门在纯函数内自足判断。

export interface TerminalCapabilities {
  isTTY: boolean;
  platform: NodeJS.Platform;
  term: string | undefined;
  rawMode: boolean;
  altScreen: boolean;
  bracketedPaste: boolean;
  resize: boolean;
  reason: string;
  /** 是否命中现代终端标记（Windows 闸门依据；契约外只读补充） */
  modernTerminal: boolean;
}

export type TuiMode = 'ink' | 'legacy';

export interface TuiModeDecision {
  mode: TuiMode;
  reason: string;
}

/** CI 判定（CI / CONTINUOUS_INTEGRATION 任一显式为真）。 */
function isCi(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI ?? env.CONTINUOUS_INTEGRATION;
  if (value === undefined) return false;
  const s = value.trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false';
}

/**
 * 现代终端标记：Windows Terminal / VS Code / ConEmu / ANSICON / xterm|screen|tmux。
 * 用于 Windows 闸门——传统 cmd.exe / PowerShell 5.1 通常一个都不命中。
 */
export function hasModernTerminalMarker(env: NodeJS.ProcessEnv): boolean {
  if (env.WT_SESSION !== undefined && env.WT_SESSION !== '') return true;
  if (env.TERM_PROGRAM !== undefined && env.TERM_PROGRAM !== '') return true;
  if ((env.ConEmuANSI ?? '').toLowerCase() === 'on') return true;
  if (env.ANSICON !== undefined && env.ANSICON !== '') return true;
  const term = (env.TERM ?? '').toLowerCase();
  if (term.startsWith('xterm') || term.startsWith('screen') || term.startsWith('tmux')) return true;
  return false;
}

/** 探测终端能力：环境 + 平台 + 是否 TTY → 能力集与降级原因。 */
export function detectTerminalCapabilities(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isTTY: boolean,
): TerminalCapabilities {
  const term = env.TERM;
  const dumb = (term ?? '').toLowerCase() === 'dumb';
  const ci = isCi(env);
  const modernTerminal = hasModernTerminalMarker(env);
  const rawMode = isTTY;
  const ansiCapable = isTTY && !dumb && !ci;

  let reason: string;
  if (!isTTY) {
    reason = 'stdin 非 TTY（管道/重定向），无法进入 raw mode，降级 legacy';
  } else if (dumb) {
    reason = 'TERM=dumb（终端无 ANSI/alt screen 能力），降级 legacy';
  } else if (ci) {
    reason = 'CI 环境（不接管终端 raw mode/alt screen），降级 legacy';
  } else {
    reason = 'TTY 且终端支持 ANSI：可启用 ink（raw mode / alt screen / bracketed paste / resize）';
  }

  return {
    isTTY,
    platform,
    term,
    rawMode,
    altScreen: ansiCapable,
    bracketedPaste: ansiCapable,
    resize: ansiCapable,
    modernTerminal,
    reason,
  };
}

/**
 * Windows 闸门（显式纯函数）：现代终端标记命中 → ink；传统控制台 → legacy（可读原因）。
 * 仅在 isTTY 且 ANSI 能力齐备时调用。
 */
export function decideWindowsTuiMode(caps: TerminalCapabilities): TuiModeDecision {
  if (caps.modernTerminal) {
    return {
      mode: 'ink',
      reason:
        'Windows 现代终端标记命中（WT_SESSION / TERM_PROGRAM / ConEmuANSI / ANSICON / TERM=xterm|screen|tmux），启用 ink',
    };
  }
  return {
    mode: 'legacy',
    reason:
      'Windows 传统控制台（cmd.exe / PowerShell 5.1 未检测到现代终端标记），降级 legacy 以避免 raw mode / alt screen 异常',
  };
}

/** 综合决策：显式覆盖 > 非 TTY > 能力（Windows 四场景闸门）> 默认 ink。 */
export function decideTuiMode(
  caps: TerminalCapabilities,
  opts: { forceNoTui?: boolean; forceTui?: boolean } = {},
): TuiModeDecision {
  if (opts.forceNoTui === true) {
    return { mode: 'legacy', reason: '已显式禁用 TUI（HARNESS2_NO_TUI=1 / --no-tui）' };
  }
  if (opts.forceTui === true) {
    return { mode: 'ink', reason: '已显式启用 TUI（HARNESS2_TUI=1），覆盖能力探测' };
  }
  if (!caps.isTTY) {
    return { mode: 'legacy', reason: caps.reason };
  }
  if (!caps.altScreen || !caps.bracketedPaste) {
    return { mode: 'legacy', reason: caps.reason };
  }
  if (caps.platform === 'win32') {
    return decideWindowsTuiMode(caps);
  }
  return { mode: 'ink', reason: '非 Windows 交互 TTY：能力齐备，启用 ink' };
}
