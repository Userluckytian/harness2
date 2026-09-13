// minimal.ts — G-01 minimal 模式契约 + G-03 模式限定命令清单（数据与谓词，零渲染）。
//
// minimal 契约（G-01「minimal：原生 scrollback，不接管屏幕」的落地口径）：
// - 无 alt-screen：不切换备用屏、不接管鼠标、退出时不做屏幕恢复——转录永久留在终端
//   原生 scrollback 里（终端自己滚，本进程不管理视口）。
// - 屏上固定区域只有两个：prompt（输入）与可选 status line——没有 fullscreen 的
//   shortcuts bar / 数据面板 / 浮层栈（regions.ts 的八区域模型是 fullscreen 专属）。
// - 系统行直写滚动区：系统提示/告警以普通文本行写进 stdout（与 legacy-chat.ts 的
//   renderer.line 同语义），不重绘、不擦除、不动画。
//
// G-03 模式限定命令（清单即数据，谓词即接口）：
// - 仅 fullscreen：/find /jump /timeline /theme /tutorial /dashboard
//   （这些命令依赖全屏交互面：查找条/时间线面板/主题预览/教程/仪表盘）
// - 仅 minimal：/expand（在全屏接管下无原生 scrollback 可展开，语义不存在）
// - /workflow runs 在 minimal 降级为纯文本输出（命令可用，渲染降级——不列入不可用）
//
// 【不做假入口】：本文件只有数据与谓词——命令的注册、分发、降级渲染实现归命令层
// （第三批接线）；谓词 false 的命令应被分发层拒绝并提示，而不是静默吞掉。
import type { RenderMode } from './mode.js';

/**
 * minimal 模式契约（类型钉死：altScreen 恒 false，装配层想接管屏幕编译期就报错）。
 * managedRegions 用元组类型表达「只有这两个、顺序固定」（status line 画在 prompt 上方）。
 */
export const MINIMAL_CONTRACT = {
  // 不接管屏幕（G-01：无 alt-screen / 无鼠标捕获 / 无备用屏切换）
  altScreen: false,
  // 屏上固定区域：prompt + statusLine（后者可选，见 MINIMAL_STATUS_LINE_DEFAULT）
  managedRegions: ['prompt', 'statusLine'],
  // 系统行直写终端滚动区（write-through：不重绘不擦除，终端原生滚动）
  systemLinePolicy: 'write-through',
} as const;

export type MinimalModeContract = typeof MINIMAL_CONTRACT;

/**
 * minimal 的 status line 缺省态：关（可选层，非必刻）。
 * 取舍依据：minimal 最接近 legacy readline 形态（现资产无状态行），缺省最素；
 * 装配层可经配置打开（打开后占 prompt 上方 1 行）。
 */
export const MINIMAL_STATUS_LINE_DEFAULT = false;

/** 仅 fullscreen 可用的命令（G-03 第一份清单；不含前导斜杠，小写规范形） */
export const FULLSCREEN_ONLY_COMMANDS: readonly string[] = [
  'find',
  'jump',
  'timeline',
  'theme',
  'tutorial',
  'dashboard',
];

/** 仅 minimal 可用的命令（G-03 第二份清单） */
export const MINIMAL_ONLY_COMMANDS: readonly string[] = ['expand'];

/**
 * minimal 下降级为纯文本输出的命令（命令可用、渲染降级——与「不可用」是两回事）。
 * /workflow runs 的 runs 视图在 minimal 无面板可画，退化为逐行文本；
 * 按命令根名记账（workflow 的其他子命令同样按纯文本输出，降级无害）。
 */
export const MINIMAL_DEGRADED_TEXT_COMMANDS: readonly string[] = ['workflow'];

/** 命令在某模式下的支持形态 */
export type ModeCommandSupport =
  /** 两模式都可用，无降级 */
  | 'available'
  /** 仅 fullscreen 可用，当前在 minimal 被拒 */
  | 'unavailable-fullscreen-only'
  /** 仅 minimal 可用，当前在 fullscreen 被拒 */
  | 'unavailable-minimal-only'
  /** 可用但输出降级为纯文本（仅发生在 minimal 的 /workflow） */
  | 'degraded-text';

/** 命令名规范化：去前导斜杠 + 小写（/Find 与 find 同判） */
function normalizeCommand(name: string): string {
  return (name.startsWith('/') ? name.slice(1) : name).toLowerCase();
}

/**
 * 命令在某模式下的支持形态（G-03 谓词主入口）。
 * 不在任何限定清单里的命令（/new /resume /model 等通用命令，以及未知命令——未知与否
 * 由命令分发层判定）一律 'available'：本谓词只回答「模式限定」这一件事。
 */
export function commandSupportInMode(command: string, mode: RenderMode): ModeCommandSupport {
  const name = normalizeCommand(command);
  if (FULLSCREEN_ONLY_COMMANDS.includes(name)) {
    return mode === 'fullscreen' ? 'available' : 'unavailable-fullscreen-only';
  }
  if (MINIMAL_ONLY_COMMANDS.includes(name)) {
    return mode === 'minimal' ? 'available' : 'unavailable-minimal-only';
  }
  if (MINIMAL_DEGRADED_TEXT_COMMANDS.includes(name) && mode === 'minimal') {
    return 'degraded-text';
  }
  return 'available';
}

/** 命令在当前模式是否可执行（降级也算可执行——降级是渲染形态不是拒绝） */
export function isCommandAvailableInMode(command: string, mode: RenderMode): boolean {
  const support = commandSupportInMode(command, mode);
  return support === 'available' || support === 'degraded-text';
}
