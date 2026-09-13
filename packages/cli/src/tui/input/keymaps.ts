// keymaps.ts — P2-B：simple / vim 两套输入模式键位表（数据化，G-07）。
//
// 规格依据：docs/refs/refs-grok-build.md「G-2x 输入与焦点模型」（2026-09-13 基线 37949780）。
// 本表是**数据即文档**：每个动作的注释标注 G- 条目号；表驱动消费方（P3 接线层）按
// InputModeId 取表，用 resolveKeyAction / chordMatches 做KeyEvent 匹配。
//
// ── 表外键位的归属（避免误解为遗漏）─────────────────────────────────────────
//  - Esc **一律不进键位表**：G-08 明文「Esc 不是焦点键」，其全部语义（G-14～G-20）
//    归 esc-machine.ts 的状态机专管；本表若出现 Esc 即为违规（测试有负向断言）。
//  - Ctrl+C（G-38 取消/退出的唯一键）属 G-6x Agent 级键位，不在本表（本表范围 G-07～G-13）。
//  - G-05 块折叠键族（h/l/e/E…）属渲染层既有实现（next-shell），不是 G-2x 键位。
//  - G-26～G-30（Enter 入队 / send-now 和弦等）属 G-5x 运行中回合，不在本表。
//
// ── 和弦编码口径（与本仓库统一输入层 src/input/parser.ts 对齐）────────────────
//  - 字母和统一写**小写** + `shift: true`：legacy 终端不置 shift 位（shift 体现在字符
//    本身大写，parser 产出 key='L'、shift=false），kitty CSI-u 则是 codepoint 74 +
//    shift 位（key='j'、shift=true）。chordMatches 对两种编码都判为 Shift+J。
//  - Ctrl+字母 = C0 控制字节（parser: 0x01-0x1a → key='a'..'z' + ctrl 位）；
//    Alt+字母 = ESC 前缀（parser: \x1b<x → key='x' + alt 位）。
//  - Ctrl+J 特例：字节 0x0a（LF）被 parser 映射为 key='j' + ctrl=true（G-10 行下滚依赖此）。
import type { KeyEvent } from '../../input/types.js';

/** 输入模式（G-07：`simple` 默认，`vim` 由 `[ui].vim_mode` 或 `/vim-mode` 开启） */
export type InputModeId = 'simple' | 'vim';

/** 焦点窗格（G-08 焦点环两态；与 focus.ts 的 FocusPane 同构，此处独立定义避免环依赖） */
export type KeymapPane = 'prompt' | 'scrollback';

/** 一条和弦：规范键名或字符（与 KeyEvent.key 同域）+ 修饰。字母一律小写（见文件头编码口径）。 */
export interface Chord {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  /** true = 需要 Shift（kitty shift 位或 legacy 大写字符均算）；缺省 false = 无 Shift */
  readonly shift?: boolean;
}

/** 动作 id：命名 `<域>.<动作>`；注释标 G- 条目号 */
export type KeyActionId =
  // G-08 焦点环
  | 'focus.toggle'
  | 'focus.to-prompt'
  // G-09 导航
  | 'nav.down'
  | 'nav.up'
  | 'nav.turn-next'
  | 'nav.turn-prev'
  | 'nav.viewport-turn-above'
  | 'nav.viewport-turn-below'
  | 'nav.first'
  | 'nav.last'
  // G-10 滚动粒度
  | 'scroll.line-up'
  | 'scroll.line-down'
  | 'scroll.page-up'
  | 'scroll.page-down'
  | 'scroll.half-up'
  | 'scroll.half-down'
  // G-11 Shell 模式（draft 前缀触发，非键盘和弦）
  | 'shell.bang'
  // G-12 图片粘贴
  | 'paste.image'
  // G-17 草稿 stash（双击 Esc 清空后的恢复通道）
  | 'draft.stash-toggle';

/** 绑定种类：'chord' = 键盘和弦；'draft-prefix' = 草稿行首前缀触发（G-11 `!`） */
export type KeyBindingKind = 'chord' | 'draft-prefix';

export interface KeyBinding {
  readonly action: KeyActionId;
  readonly chords: readonly Chord[];
  /** 限定起始窗格；缺省两态皆可 */
  readonly from?: KeymapPane;
  readonly kind?: KeyBindingKind;
  /** 差异 / 边界备注（接线层与 cheatsheet 复用） */
  readonly note?: string;
}

// ── 共用段（G-09 导航 / G-10 滚动：两套模式完全并行，提取为常量复用）────────
//
// G-09 导航键位（scrollback 窗格侧）：j/k ↔ ↓/↑；Shift+L/H ↔ Shift+→/←（按 turn）；
// Shift+J/K 跳视口顶上/下方 turn；g/Shift+G 首尾。prompt 窗格的 ↑/↓ 是草稿内移动 +
// 历史回溯（chat-controller 既有语义），不在本表。
// 注意与 G-05 折叠键的分工：小写 h/l = 折叠/展开（渲染层既有），Shift+H/L = 按 turn 跳转。
const NAV_BINDINGS: readonly KeyBinding[] = [
  {
    action: 'nav.down',
    chords: [{ key: 'down' }, { key: 'j' }],
    from: 'scrollback',
  },
  {
    action: 'nav.up',
    chords: [{ key: 'up' }, { key: 'k' }],
    from: 'scrollback',
  },
  {
    action: 'nav.turn-next',
    chords: [
      { key: 'l', shift: true },
      { key: 'right', shift: true },
    ],
    from: 'scrollback',
  },
  {
    action: 'nav.turn-prev',
    chords: [
      { key: 'h', shift: true },
      { key: 'left', shift: true },
    ],
    from: 'scrollback',
  },
  {
    // G-09（2026-09-13 修正）：Shift+J/K = 跳「视口顶上方 / 顶下方」的 turn（与 timeline
    // 箭头同目标），不是原稿失真的「按助手回复」
    action: 'nav.viewport-turn-above',
    chords: [{ key: 'k', shift: true }],
    from: 'scrollback',
  },
  {
    action: 'nav.viewport-turn-below',
    chords: [{ key: 'j', shift: true }],
    from: 'scrollback',
  },
  { action: 'nav.first', chords: [{ key: 'g' }], from: 'scrollback' },
  { action: 'nav.last', chords: [{ key: 'g', shift: true }], from: 'scrollback' },
];

// G-10 滚动粒度：Ctrl+K/Ctrl+J 行、PageUp/PageDown 整页、Ctrl+U/Ctrl+D 半页。
// 两窗格皆可（Ctrl 组与翻页键无文本输入冲突，与 chat-controller 现状一致：
// PageUp/PageDown、Ctrl+U/D 已从 prompt 窗格消费；Ctrl+K/J 为本表新增行粒度）。
const SCROLL_BINDINGS: readonly KeyBinding[] = [
  { action: 'scroll.line-up', chords: [{ key: 'k', ctrl: true }] },
  { action: 'scroll.line-down', chords: [{ key: 'j', ctrl: true }] },
  { action: 'scroll.page-up', chords: [{ key: 'pageup' }] },
  { action: 'scroll.page-down', chords: [{ key: 'pagedown' }] },
  { action: 'scroll.half-up', chords: [{ key: 'u', ctrl: true }] },
  { action: 'scroll.half-down', chords: [{ key: 'd', ctrl: true }] },
];

/** G-11 Shell 模式：行首 `!` 触发。不是和弦——由 shell-mode.ts 的 detectShellMode 在
 * 提交/草稿层检测（转义边界见该文件注释），此处登记以保持「表即文档」完整性。 */
const SHELL_BINDING: readonly KeyBinding[] = [
  {
    action: 'shell.bang',
    chords: [{ key: '!' }],
    kind: 'draft-prefix',
    note: '行首 `!` 进入 shell 模式直接执行；转义边界（!!、!后空白）见 shell-mode.ts',
  },
];

/** G-12 图片粘贴（Windows：Ctrl+V 被终端占，用 Alt+V）。Linux 的 PRIMARY/CLIPBOARD 区分
 * 与 Shift+Insert、拖拽入口不在和弦表（平台相关，见 image-paste.ts / capability.ts）。 */
const IMAGE_PASTE_BINDINGS: readonly KeyBinding[] = [
  {
    action: 'paste.image',
    chords: [{ key: 'v', alt: true }],
    note: 'G-12：Windows 用 Alt+V；Linux Shift+Insert 走 PRIMARY、拖拽亦可；真机透传 🟡 下放 P7',
  },
];

/** G-17 stash 通道：Ctrl+S / Alt+S。上游 StashPrompt 语义（prompt_stash.rs，P1-1 对齐）：
 * composer 非空 = 当前草稿入单槽 stash（新 stash 替换旧 stash）并清空 composer；
 * composer 空 = 恢复 stash 并清槽；空且无 stash = 无操作。Alt+S 备用（部分终端吞 Ctrl+S XOFF）。 */
const STASH_BINDINGS: readonly KeyBinding[] = [
  {
    action: 'draft.stash-toggle',
    chords: [
      { key: 's', ctrl: true },
      { key: 's', alt: true },
    ],
    note: 'G-17：stash/pop 切换（非空=暂存并清空 composer、空=恢复并清槽）；双击 Esc 清空入同一单槽；Ctrl+S 被终端吞时用 Alt+S',
  },
];

/**
 * simple 模式键位表（G-07 默认模式）。
 * 焦点：Tab 双向切换（G-08）；Space 亦可回输入框（G-08「simple 下 Space 亦可」；
 * 仅 scrollback 窗格——prompt 窗格的 Space 是文本输入，不可能同时是焦点键）。
 */
export const SIMPLE_KEYMAP: readonly KeyBinding[] = [
  { action: 'focus.toggle', chords: [{ key: 'tab' }], note: 'G-08：Tab 在 prompt/scrollback 间切换（双模式通用）' },
  {
    action: 'focus.to-prompt',
    chords: [{ key: ' ' }],
    from: 'scrollback',
    note: 'G-08：simple 下 Space 亦可切回输入框（仅 scrollback 侧；prompt 侧 Space 是空格字符）',
  },
  ...NAV_BINDINGS,
  ...SCROLL_BINDINGS,
  ...SHELL_BINDING,
  ...IMAGE_PASTE_BINDINGS,
  ...STASH_BINDINGS,
];

/**
 * vim 模式键位表（G-07，`[ui].vim_mode` / `/vim-mode`）。
 * 焦点：Tab 双向切换；`i` 回输入框（G-08「vim 下 i 回输入」——vi 语义：scrollback 聚焦
 * 相当于 normal mode，i 进 insert）。无 Space 切焦点（vim 下 Space 属 vi 编辑语义）。
 * 🟡 G-07 部分：prompt 侧 vi 编辑（hjkl 词移 / 0$ / dd 等）本阶段不落表，下放 P7；
 * 滚动区侧 vim 键（j/k/g/G 等，与 simple 重叠）如实在表。
 */
export const VIM_KEYMAP: readonly KeyBinding[] = [
  { action: 'focus.toggle', chords: [{ key: 'tab' }], note: 'G-08：Tab 在 prompt/scrollback 间切换（双模式通用）' },
  {
    action: 'focus.to-prompt',
    chords: [{ key: 'i' }],
    from: 'scrollback',
    note: 'G-08：vim 下 i 回输入框（vi normal→insert 语义）；prompt 侧 i 是普通字符',
  },
  ...NAV_BINDINGS,
  ...SCROLL_BINDINGS,
  ...SHELL_BINDING,
  ...IMAGE_PASTE_BINDINGS,
  ...STASH_BINDINGS,
];

/** 按模式取键位表（G-07：两套表并行存在，消费方按 InputModeId 二选一） */
export function keymapFor(mode: InputModeId): readonly KeyBinding[] {
  return mode === 'vim' ? VIM_KEYMAP : SIMPLE_KEYMAP;
}

/**
 * 和弦匹配（编码口径见文件头）：
 *  - 字母键大小写归一（表内小写；事件大写字符 = legacy shift 编码）；
 *  - shift 判定 = kitty shift 位 ‖ 事件本身是大写字符（legacy）；
 *  - ctrl / alt 精确相等（不 loose 匹配，避免 Ctrl+Shift+J 误中 Shift+J）。
 */
export function chordMatches(chord: Chord, ev: KeyEvent): boolean {
  const raw = ev.key;
  const isUpperLetter = raw.length === 1 && raw >= 'A' && raw <= 'Z';
  const base = isUpperLetter ? raw.toLowerCase() : raw;
  if (base !== chord.key) return false;
  if ((chord.ctrl ?? false) !== ev.modifiers.ctrl) return false;
  if ((chord.alt ?? false) !== ev.modifiers.alt) return false;
  const shifted = ev.modifiers.shift || isUpperLetter;
  return (chord.shift ?? false) === shifted;
}

/**
 * KeyEvent → 动作解析：按模式在键位表中找第一条匹配绑定。
 * @param pane 当前焦点窗格；缺省不做窗格过滤（调用方自行裁决）。
 *             `from` 限定的绑定在窗格不符时跳过（如 prompt 侧的 j/k 是文本输入）。
 * @returns 匹配的绑定；无匹配返回 null。**Esc 永远不匹配**（不进表，语义归 esc-machine）。
 */
export function resolveKeyAction(mode: InputModeId, ev: KeyEvent, pane?: KeymapPane): KeyBinding | null {
  for (const binding of keymapFor(mode)) {
    if (binding.kind === 'draft-prefix') continue; // 前缀触发非和弦，由 shell-mode.ts 专管
    if (binding.from !== undefined && pane !== undefined && binding.from !== pane) continue;
    if (binding.chords.some((chord) => chordMatches(chord, ev))) return binding;
  }
  return null;
}
