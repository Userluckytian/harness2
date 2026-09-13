// capability 单测：G-13 终端能力依赖的数据化清单（WezTerm kitty keyboard 主条目 + 终端族差异）。
import { describe, expect, it } from 'vitest';
import { IMAGE_PASTE_CHORD } from '../../../src/tui/input/image-paste.js';
import {
  IMAGE_PASTE_CHORD_REF,
  KITTY_KEYBOARD_OPT_IN_HINT,
  TERMINAL_CHORD_PROFILES,
  chordRiskSummary,
  detectTerminalFamily,
} from '../../../src/tui/input/capability.js';

describe('G-13 主条目：WezTerm 需 enable_kitty_keyboard = true', () => {
  it('WezTerm 画像：kitty keyboard = opt-in + 必需配置（G-13 原文）', () => {
    const wez = TERMINAL_CHORD_PROFILES.find((p) => p.family === 'WezTerm');
    expect(wez).toBeDefined();
    expect(wez!.kittyKeyboard).toBe('opt-in');
    expect(wez!.requiredConfig).toBe('enable_kitty_keyboard = true');
    expect(wez!.knownGaps.join('\n')).toContain('G-13');
  });

  it('独立导出的配置提示常量与表内一致（状态行/文档直引锚点）', () => {
    expect(KITTY_KEYBOARD_OPT_IN_HINT.terminal).toBe('WezTerm');
    expect(KITTY_KEYBOARD_OPT_IN_HINT.config).toBe('enable_kitty_keyboard = true');
  });

  it('chordRiskSummary：opt-in 族追加「开启后全量口径」条目；未知族返回空', () => {
    const risks = chordRiskSummary('WezTerm');
    expect(risks.length).toBeGreaterThan(1);
    expect(risks.at(-1)).toContain('enable_kitty_keyboard = true');
    expect(chordRiskSummary('不存在的终端')).toEqual([]);
  });
});

describe('G-13 终端族画像表完整性', () => {
  it('每族都有检测线索与支持层级；native 族无必需配置', () => {
    for (const profile of TERMINAL_CHORD_PROFILES) {
      expect(profile.detection.length, `${profile.family} 应有 env 检测建议`).toBeGreaterThan(0);
      expect(['native', 'opt-in', 'unavailable']).toContain(profile.kittyKeyboard);
      if (profile.kittyKeyboard === 'native') expect(profile.requiredConfig).toBeUndefined();
    }
  });

  it('G-12 键位缺口进表：Ctrl+V 被占的族注明 Alt+V；Linux 条目注明 PRIMARY', () => {
    const wt = TERMINAL_CHORD_PROFILES.find((p) => p.family === 'Windows Terminal')!;
    expect(wt.knownGaps.join('\n')).toContain('Alt+V');
    const linux = TERMINAL_CHORD_PROFILES.find((p) => p.family.includes('Linux'))!;
    expect(linux.knownGaps.join('\n')).toContain('Shift+Insert');
  });

  it('G-28 / G-17 键位缺口进表：Apple Terminal 的 Ctrl+O send-now 与 XOFF 吞 Ctrl+S', () => {
    const apple = TERMINAL_CHORD_PROFILES.find((p) => p.family === 'Apple Terminal')!;
    const text = apple.knownGaps.join('\n');
    expect(text).toContain('G-28');
    expect(text).toContain('Ctrl+O');
    expect(text).toContain('Alt+S');
  });
});

describe('G-13 env 检测建议（建议级：只读 env，不做协议探测）', () => {
  it('WezTerm：WEZTERM_EXECUTABLE 或 TERM_PROGRAM=WezTerm 命中', () => {
    expect(detectTerminalFamily({ WEZTERM_EXECUTABLE: '/usr/bin/wezterm' })).toBe('WezTerm');
    expect(detectTerminalFamily({ TERM_PROGRAM: 'WezTerm' })).toBe('WezTerm');
  });

  it('Windows Terminal / VS Code / Apple Terminal / kitty / ghostty 各按线索命中', () => {
    expect(detectTerminalFamily({ WT_SESSION: 'abc' })).toBe('Windows Terminal');
    expect(detectTerminalFamily({ TERM_PROGRAM: 'vscode' })).toBe('VS Code integrated terminal');
    expect(detectTerminalFamily({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('Apple Terminal');
    expect(detectTerminalFamily({ KITTY_WINDOW_ID: '1' })).toBe('kitty');
    expect(detectTerminalFamily({ GHOSTTY_RESOURCES_DIR: '/x' })).toBe('ghostty');
    expect(detectTerminalFamily({ TERM: 'xterm-kitty' })).toBe('kitty');
  });

  it('tmux / screen 命中 Linux 条目；空 env 返回 null', () => {
    expect(detectTerminalFamily({ TMUX: '/tmp/tmux-0/default,1,0' })).toContain('Linux');
    expect(detectTerminalFamily({})).toBeNull();
  });

  it('值不符不命中（TERM_PROGRAM=WezTerm vs vscode 严格区分）', () => {
    expect(detectTerminalFamily({ TERM_PROGRAM: 'iTerm.app' })).toBe('iTerm2');
    expect(detectTerminalFamily({ TERM_PROGRAM: 'unknown-term' })).toBeNull();
  });
});

describe('跨文件一致性', () => {
  it('capability 的图片粘贴和弦引用与 image-paste 的主和弦同值（G-12 锚点防漂移）', () => {
    expect(IMAGE_PASTE_CHORD_REF).toEqual(IMAGE_PASTE_CHORD);
  });
});
