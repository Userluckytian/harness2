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
//  - G-31～G-41 属 G-6x Agent 级键位，**不进 G-07～G-13 的动作解析表**（语义面不同：
//    这些键是 Agent 级模态/开关，不是焦点/滚动动作）——但它们的**和弦占用**登记在本文件
//    末尾的 `AGENT_CHORD_TABLE`（P3-F）：一处集中声明「这个和弦归谁、接没接、没接的为什么」，
//    防止未来批次撞键（如 Ctrl+X 曾同时被队列面板与快捷键帮助占用）。
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

// ═══════════════════════════════════════════════════════════════════════════
// G-6x Agent 级键位归属表（G-31～G-41，P3-F 逐条归存）
// ═══════════════════════════════════════════════════════════════════════════
//
// 规格依据：docs/refs/refs-grok-build.md「G-6x Agent 级键位」表（2026-09-13 基线 37949780）
// 与上游 `crates/codegen/xai-grok-pager/src/actions/defaults.rs`（`ActionDef.default_key`）。
//
// 本表回答三个问题（**唯一事实来源**，接线层与快捷键帮助都从这里取数据）：
//   1. 这个和弦归谁（避免未来批次撞键——历史事故：Ctrl+X 同时被队列面板与快捷键帮助占用）；
//   2. 接了没有、落在哪（`owner: 'wired'` + `target`）；
//   3. 没接的为什么、什么时候接（`owner: 'deferred'` + `p7` 理由，如实登记不谎称已实现）。
//
// 边界（与 G-2x 表的分工）：本表**只登记**，不参与 `resolveKeyAction` 的 G-07～G-13 动作
// 解析；Esc 依旧一律不进任何表（G-08，语义归 esc-machine.ts）。
// 编码口径与上文一致：字母小写 + `ctrl`；标点用字符本体（`;` `'` `.` `,` `\`）；
// 注意这类和弦**无 C0 控制字节**，legacy 终端收不到，只有 kitty keyboard protocol
// （或等价扩展）能送达——逐条在 `note` 里如实标注。

/** 和弦归属状态：wired = 已接线（有真实落点）；deferred = 归存 P7（当前无落点） */
export type AgentChordOwner = 'wired' | 'deferred';

/** Agent 级动作 id（本表内部键；与 G 条目一一对应） */
export type AgentChordActionId =
  | 'palette.open'
  | 'model.picker'
  | 'mode.cycle'
  | 'mode.always-approve'
  | 'session.picker'
  | 'pane.todos'
  | 'pane.tasks'
  | 'extensions.open'
  | 'turn.background'
  | 'cancel-or-exit'
  | 'help.shortcuts'
  | 'settings.open'
  | 'agent.dashboard';

export interface AgentChordEntry {
  /** G 条目号（G-31～G-41）；一个条目多和弦时逐条列出（同 id 可出现多行） */
  readonly id: string;
  readonly action: AgentChordActionId;
  /** 展示名（快捷键帮助 / 报告直引） */
  readonly label: string;
  readonly chords: readonly Chord[];
  readonly owner: AgentChordOwner;
  /** 功能一句话（快捷键帮助的正文） */
  readonly summary: string;
  /** wired：落点（装配层函数名，便于审查核对） */
  readonly target?: string;
  /** deferred：归存 P7 的理由 / 边界（wired 时写差异与终端可达性） */
  readonly note?: string;
  /** 复刻等级（G 表「等级」列）：必刻 / 参考 */
  readonly tier: '必刻' | '参考';
}

/**
 * G-6x Agent 级键位归属表（2026-09-14 P3-F 逐条归存）。
 * 行序 = G 条目序；同一 G 条目多和弦拆多行（label 区分主/备）。
 */
export const AGENT_CHORD_TABLE: readonly AgentChordEntry[] = [
  {
    id: 'G-31',
    action: 'palette.open',
    label: 'Ctrl+P',
    chords: [{ key: 'p', ctrl: true }],
    owner: 'wired',
    summary: '命令面板（模糊搜索动作与斜杠命令）',
    target: 'next-shell.ts extraKeyHandler → togglePalette / paletteLayer',
    note: 'P3-A/P3-E 已接线；备用和弦 `?`（空草稿时）见同处分支',
    tier: '必刻',
  },
  {
    id: 'G-32',
    action: 'model.picker',
    label: 'Ctrl+M',
    chords: [{ key: 'm', ctrl: true }],
    owner: 'deferred',
    summary: '模型选择器（prompt 聚焦时改为多行切换）',
    note: '归存 P7：harness2 无模型选择器（模型经 config/provider 装配期确定，运行期无切换句柄）；多行切换亦未实现（`/multiline` 属 G-72，同未接）。双语义都不具备 → 不建假面板；和弦在此登记占用，未来接驳不得改口径',
    tier: '必刻',
  },
  {
    id: 'G-33',
    action: 'mode.cycle',
    label: 'Shift+Tab',
    chords: [{ key: 'tab', shift: true }],
    owner: 'wired',
    summary: '模式循环 Normal → Plan → Auto → Always-approve',
    target: 'next-shell.ts extraKeyHandler → cycleMode（MODE_CYCLE 四态）',
    note: 'P3-B 已接线；审批卡接管期该和弦被卡内焦点环消费（dispatcher 层级，卡片反向走行）',
    tier: '必刻',
  },
  {
    id: 'G-33',
    action: 'mode.always-approve',
    label: 'Ctrl+O',
    chords: [{ key: 'o', ctrl: true }],
    owner: 'wired',
    summary: '直切 / 关闭 always-approve（与 Shift+Tab 循环共享同一单态）',
    target: 'next-shell.ts extraKeyHandler → toggleAlwaysApprove；审批卡上亦有同键分支',
    note: 'P3-B 已接线。上游为 toggle（Ctrl+O 直接翻转 YOLO），harness2 同口径；与 G-28 的 Apple Terminal send-now 和弦 Ctrl+O 冲突已在 SEND_NOW_FAMILY 裁决中登记（本壳固定 default 族）',
    tier: '必刻',
  },
  {
    id: 'G-34',
    action: 'session.picker',
    label: 'Ctrl+R',
    chords: [{ key: 'r', ctrl: true }],
    owner: 'wired',
    summary: '会话选择器（历史会话列表 → Enter 切换）',
    target: 'next-shell.ts extraKeyHandler → openSessionPicker / sessionLayer',
    note: 'P3-F 新增接线：列表取自 runtime.sessionManager.list(root)（mtime 倒序），Enter 经既有 `/resume <id>` 命令管线切换（同 rewindPicker 模式，不新造切换语义）。F3 为已废除旧键位，仓内无残留（parser 只保留 f3 键名本身，无绑定）。差异：G-91 的「scrollback 聚焦时 Ctrl+R 借做鼠标上报开关」未接（配置项 `[ui] mouse_reporting_toggle` 不在 P3 范围），故本壳 Ctrl+R 在两窗格皆为会话选择器——登记，接 G-91 时须按规格加窗格限定',
    tier: '必刻',
  },
  {
    id: 'G-35',
    action: 'pane.todos',
    label: 'Ctrl+T',
    chords: [{ key: 't', ctrl: true }],
    owner: 'deferred',
    summary: 'todos 面板开关',
    note: '归存 P7：本壳无 todos 数据源（core 无 todo 列表契约，转录里也没有「agent 当前待办清单」这一投影）→ 不造假面板；和弦在此登记占用',
    tier: '必刻',
  },
  {
    id: 'G-35',
    action: 'pane.tasks',
    label: 'Ctrl+G',
    chords: [{ key: 'g', ctrl: true }],
    owner: 'deferred',
    summary: 'tasks 面板开关（minimal 下改为外部编辑器）',
    note: '归存 P7：next 壳无任务数据源（`/tasks` 在 core 需 cron 存储句柄，ChatRuntime 未注入，只出降级文案；旧壳的 taskPanelCounts 只服务旧壳面板，两壳不共享数据）→ 两条语义（fullscreen 面板 / minimal 外部编辑器）都无落点；和弦在此登记占用。与 G-37 同批（都在等 TaskCoordinator / cron 句柄装配）',
    tier: '必刻',
  },
  {
    id: 'G-36',
    action: 'extensions.open',
    label: 'Ctrl+L',
    chords: [{ key: 'l', ctrl: true }],
    owner: 'deferred',
    summary: 'extensions 模态（VS Code 族下改为 interject）',
    note: '归存 P7：本壳无 extensions 模态（MCP/插件只读面走 `/mcps` `/plugins` 命令，无模态浮层）→ 不建假面板；和弦在此登记占用（capability.ts 已记 VS Code 族改 interject 的差异）',
    tier: '必刻',
  },
  {
    id: 'G-37',
    action: 'turn.background',
    label: 'Ctrl+B',
    chords: [{ key: 'b', ctrl: true }],
    owner: 'deferred',
    summary: '当前回合转后台',
    note: '归存 P7：CLI 从未装配 core 的 TaskCoordinator（见 OPEN.md 已知项），「转后台」无落点（既无后台任务表也无 attach 通道）→ 不谎称转后台；和弦在此登记占用。与 G-35 同批（TaskCoordinator 装配时一起接）',
    tier: '必刻',
  },
  {
    id: 'G-38',
    action: 'cancel-or-exit',
    label: 'Ctrl+C',
    chords: [{ key: 'c', ctrl: true }],
    owner: 'wired',
    summary: '取消当前回合（唯一取消键）；取消中再按升级为退出',
    target: 'next-shell.ts extraKeyHandler（复制优先）+ createCtrlCGuard 退出协议；审批卡上 = 取消审批',
    note: 'P2-C/P4-1 已接线（G-14～G-19 同源）；有选择时优先复制（OSC52），无选择走 guard 双击退出。Esc 永不取消（G-14）',
    tier: '必刻',
  },
  {
    id: 'G-39',
    action: 'help.shortcuts',
    label: 'Ctrl+.',
    chords: [{ key: '.', ctrl: true }],
    owner: 'wired',
    summary: '快捷键帮助（主键；Ctrl+X 为备用）',
    target: 'next-shell.ts extraKeyHandler → toggleShortcutsHelp / helpLayer',
    note: '与 Ctrl+X 同动作（上游 ctrl_dot_unreliable 同源：一个主键一个备用）。**Ctrl+. 无 C0 控制字节**，legacy/Windows Terminal 收不到，仅 kitty keyboard protocol 可达——真机清单项',
    tier: '必刻',
  },
  {
    id: 'G-39',
    action: 'help.shortcuts',
    label: 'Ctrl+X',
    chords: [{ key: 'x', ctrl: true }],
    owner: 'wired',
    summary: '快捷键帮助（本壳可滚动 cheatsheet 浮层）',
    target: 'next-shell.ts extraKeyHandler → toggleShortcutsHelp / helpLayer',
    note: "P3-F 新增接线 + 冲突修复：Ctrl+X 原为队列面板的壳侧附加别名（G-29 的键位是 Ctrl+; / Ctrl+' / Ctrl+4），与 G-39 撞键 → 已从面板打开路径移除；面板内取消高亮行改用裸 `x`（Ctrl+X 在面板打开期 = 关面板并开帮助，模态让位于全局帮助键）。Ctrl+X 在 legacy 终端可达（C0 0x18）",
    tier: '必刻',
  },
  {
    id: 'G-40',
    action: 'settings.open',
    label: 'F2',
    chords: [{ key: 'f2' }],
    owner: 'deferred',
    summary: '设置面板',
    note: '归存 P7：本壳无设置面板（配置经 config.json / `/mode` `/theme` 等单点命令改，无统一设置模态）→ 不建假面板；F2 与 Ctrl+, 两个和弦在此登记占用',
    tier: '必刻',
  },
  {
    id: 'G-40',
    action: 'settings.open',
    label: 'Ctrl+,',
    chords: [{ key: ',', ctrl: true }],
    owner: 'deferred',
    summary: '设置面板（备用和弦）',
    note: '同 G-40 主键：无落点归存 P7；Ctrl+, 亦无 C0 字节，legacy 不可达',
    tier: '必刻',
  },
  {
    id: 'G-41',
    action: 'agent.dashboard',
    label: 'Ctrl+\\',
    chords: [{ key: '\\', ctrl: true }],
    owner: 'deferred',
    summary: 'agents dashboard（多 agent 监控/派发；`GROK_AGENT_DASHBOARD=0` 可关）',
    note: '归存 P7：复刻等级为**参考**（G 表「参考」列），且本壳无多 agent 运行时（无 dashboard 数据源、无派发通道）→ 不建假 dashboard；和弦在此登记占用（上游主键 Ctrl+\\，macOS VS Code 族备用 Ctrl+4——该备用位与本仓 G-29 的 macOS VS Code 族主键 Ctrl+4 撞位，接驳时须先裁决）',
    tier: '参考',
  },
];

// ── 旧壳（legacy 渲染壳）侧的差异登记（同批条目在另一壳的现状，供审查/接手对齐）──────
//  - G-31：命令面板未接（旧壳的 `/` 补全 + Ctrl+P 无 palette；登记差异）。
//  - G-33：Shift+Tab 模式循环未接（旧壳模式切换走 `/mode` 选择浮层）；Ctrl+O 在旧壳 是 T3
//    「展开最近工具卡」（真实 shell 能力）——与 always-approve 同键不同义，**登记冲突**：
//    往旧壳接 G-33 前必须先裁决该和弦（禁止静默覆盖既有能力）。
//  - G-34：空闲态 Ctrl+R = 会话选择器（P3-F 已接，复用 `/sessions` 无参浮层，见
//    旧壳入口）；busy 期仍是 T8「推理折叠块」键位（同键不同义，已登记）。
//  - G-35～G-37/G-40/G-41：旧壳侧同样无落点（与 next 同批归存 P7）。
//  - G-38：Ctrl+C 取消/退出已接（T0/Composer guard 协议）。
//  - G-39：Ctrl+X 在旧壳 被 T4 队列面板的「取消队首」占用（panels/queue-panel.tsx；
//    本轮允许改动集不含该文件）→ 旧壳侧快捷键帮助归存 P7；Ctrl+. 亦未接（需新增 Modal）。

/** 取某 Agent 级动作的全部和弦（主键 + 备用；顺序即登记序） */
export function agentChordsFor(action: AgentChordActionId): readonly Chord[] {
  return AGENT_CHORD_TABLE.filter((e) => e.action === action).flatMap((e) => e.chords);
} /** 某 Agent 级动作是否**已接线**（deferred 动作即使和弦命中也不得消费按键） */
export function agentActionWired(action: AgentChordActionId): boolean {
  return AGENT_CHORD_TABLE.some((e) => e.action === action && e.owner === 'wired');
}

/** 键事件是否命中某 Agent 级动作的和弦（编码口径同 chordMatches） */
export function matchesAgentChord(ev: KeyEvent, action: AgentChordActionId): boolean {
  if (!agentActionWired(action)) return false; // 未接线动作不消费按键（防「登记了就当接了」）
  return agentChordsFor(action).some((chord) => chordMatches(chord, ev));
}

/** G-39 快捷键帮助和弦（Ctrl+. 主键 / Ctrl+X 备用，顺序即展示序） */
export const SHORTCUTS_HELP_CHORDS: readonly Chord[] = agentChordsFor('help.shortcuts');

/** G-39 判定：键事件是否请求快捷键帮助（两和弦任一命中） */
export function matchesShortcutsHelp(ev: KeyEvent): boolean {
  return matchesAgentChord(ev, 'help.shortcuts');
}

/** G-34 判定：键事件是否为会话选择器入口 */
export function matchesSessionPicker(ev: KeyEvent): boolean {
  return matchesAgentChord(ev, 'session.picker');
}
