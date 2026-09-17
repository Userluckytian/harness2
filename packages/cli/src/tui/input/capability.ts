// capability.ts — P2-B：G-13 终端能力依赖的数据化清单（供 P3 状态行 / cheatsheet / 文档用）。
//
// 规格依据：docs/refs/refs-grok-build.md G-13——WezTerm 需 `enable_kitty_keyboard = true`
// 才能收到全量和弦；终端族差异在上游 21-terminal-support.md（摘要入本表）。
// 另有 `terminal-capabilities.ts`（tui/ 下既有）：那是「旧壳 vs legacy」TUI 闸门探测，与本表
// 分工不同——本表是**和弦级差异知识**（哪些终端要什么配置/有什么键位缺口），纯数据 +
// 一个 env 检测建议函数，不做进程探测、不做闸门决策。
//
// 检测建议（detection）统一给 env 线索，按数组顺序短路命中；均为建议而非硬判定——
// 真实检测（kitty keyboard protocol 查询 CSI ? u 等）属 P3/真机清单范围。
import type { Chord } from './keymaps.js';

/** kitty keyboard protocol 支持层级：
 *  - 'native'：默认开启（kitty / ghostty 等）；
 *  - 'opt-in'：需用户配置开启（WezTerm enable_kitty_keyboard）；
 *  - 'unavailable'：无 CSI-u 全量修饰（legacy 序列只有部分和弦，如 Shift+Enter 可能收不到）。 */
export type KittyKeyboardSupport = 'native' | 'opt-in' | 'unavailable';

export interface TerminalChordProfile {
  /** 终端族名（展示用） */
  readonly family: string;
  /** env 检测建议（按序短路：env 名 + 可选的期望值；value 省略 = 存在即命中） */
  readonly detection: readonly { readonly env: string; readonly value?: string }[];
  /** kitty keyboard protocol 支持层级（G-13 主判据：决定全量和弦能否收到） */
  readonly kittyKeyboard: KittyKeyboardSupport;
  /** 需要用户开启的配置（'opt-in' 时非空，如 WezTerm enable_kitty_keyboard = true） */
  readonly requiredConfig?: string;
  /** 该终端族的已知键位缺口 / 差异（引用 G 条目号；供 cheatsheet 与真机清单核对） */
  readonly knownGaps: readonly string[];
}

/**
 * 终端族和弦能力画像（G-13 + 相关键位差异条目摘要）。
 * 行序即展示序；detection 是建议线索，冲突时以更具体的族为准（如 TERM_PROGRAM 同时命中
 * WezTerm/vscode 的场景由调用方按序裁决）。
 */
export const TERMINAL_CHORD_PROFILES: readonly TerminalChordProfile[] = [
  {
    family: 'kitty',
    detection: [{ env: 'KITTY_WINDOW_ID' }, { env: 'TERM', value: 'xterm-kitty' }],
    kittyKeyboard: 'native',
    knownGaps: [],
  },
  {
    family: 'ghostty',
    detection: [{ env: 'GHOSTTY_RESOURCES_DIR' }],
    kittyKeyboard: 'native',
    knownGaps: [],
  },
  {
    family: 'WezTerm',
    detection: [{ env: 'WEZTERM_EXECUTABLE' }, { env: 'TERM_PROGRAM', value: 'WezTerm' }],
    kittyKeyboard: 'opt-in',
    requiredConfig: 'enable_kitty_keyboard = true',
    knownGaps: ['G-13：未开启 enable_kitty_keyboard 时收不全 CSI-u 和弦（如 Shift+Enter / Ctrl+Enter / Alt 组合）'],
  },
  {
    family: 'Windows Terminal',
    detection: [{ env: 'WT_SESSION' }],
    kittyKeyboard: 'unavailable',
    knownGaps: ['G-12：Ctrl+V 被终端占，图片粘贴用 Alt+V', 'G-12：无 PRIMARY 选择区概念（Windows 剪贴板单通道）'],
  },
  {
    family: 'VS Code integrated terminal',
    detection: [{ env: 'TERM_PROGRAM', value: 'vscode' }],
    kittyKeyboard: 'unavailable',
    knownGaps: [
      'G-12：Ctrl+V 被终端占，图片粘贴用 Alt+V',
      'G-36：Ctrl+L 改为 interject（extensions 模态键位让位）',
      'G-91：scrollback 聚焦时 Ctrl+R 可被鼠标上报开关借用（G-34 会话选择器让位）',
    ],
  },
  {
    family: 'Apple Terminal',
    detection: [{ env: 'TERM_PROGRAM', value: 'Apple_Terminal' }],
    kittyKeyboard: 'unavailable',
    knownGaps: [
      'G-28：send-now 和弦用 Ctrl+O（Ctrl+Enter / Ctrl+I 不可用）',
      'G-17：Ctrl+S 会被 XOFF 流控吞掉，用 Alt+S stash 恢复',
    ],
  },
  {
    family: 'iTerm2',
    detection: [{ env: 'ITERM_PROFILE' }, { env: 'TERM_PROGRAM', value: 'iTerm.app' }],
    kittyKeyboard: 'unavailable',
    knownGaps: ['G-17：Ctrl+S 会被 XOFF 流控吞掉，用 Alt+S stash 恢复'],
  },
  {
    family: 'Linux X11 / Wayland 终端（xterm 族 / tmux / screen）',
    detection: [{ env: 'TMUX' }, { env: 'TERM', value: 'screen' }],
    kittyKeyboard: 'unavailable',
    knownGaps: [
      'G-12：区分 PRIMARY / CLIPBOARD，Shift+Insert 走 PRIMARY',
      'G-17：Ctrl+S 会被 XOFF 流控吞掉，用 Alt+S stash 恢复',
    ],
  },
];

/** WezTerm kitty keyboard 配置提示（G-13 主条目；单独导出便于状态行/文档直引） */
export const KITTY_KEYBOARD_OPT_IN_HINT = {
  terminal: 'WezTerm',
  config: 'enable_kitty_keyboard = true',
  consequence: '未开启时收不全 CSI-u 全量和弦（G-13）',
} as const;

/**
 * env 检测建议：返回命中的终端族名（按表序短路）；未命中返回 null。
 * 这是「建议级」检测（见文件头）——只读 env 字符串，不做任何进程/协议探测。
 */
export function detectTerminalFamily(env: NodeJS.ProcessEnv): string | null {
  for (const profile of TERMINAL_CHORD_PROFILES) {
    for (const clue of profile.detection) {
      const value = env[clue.env];
      if (value === undefined) continue;
      if (clue.value === undefined || value === clue.value) return profile.family;
    }
  }
  return null;
}

/** 汇总某终端族的「缺失和弦风险」清单：kitty keyboard 非 native 的缺口文案拼接（文档用） */
export function chordRiskSummary(family: string): readonly string[] {
  const profile = TERMINAL_CHORD_PROFILES.find((p) => p.family === family);
  if (profile === undefined) return [];
  if (profile.kittyKeyboard === 'opt-in' && profile.requiredConfig !== undefined) {
    return [...profile.knownGaps, `${profile.family}：开启 ${profile.requiredConfig} 后按 kitty/ghostty 全量口径`];
  }
  return profile.knownGaps;
}

/** 与 G-12 图片粘贴的跨文件一致性锚点：主和弦的 key/alt 域（IMAGE_PASTE_CHORD 同值） */
export const IMAGE_PASTE_CHORD_REF: Chord = { key: 'v', alt: true };
