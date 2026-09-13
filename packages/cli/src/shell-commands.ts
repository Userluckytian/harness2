// shell-commands：壳侧 ShellCommand 分发表（P1-Dev-2 内核下沉第二棒）。
// core 的 13 条命令中 mode/reasoning 标记 shellOnly（core 无执行体）：审批模式切换与推理
// 展示开关是壳状态/呈现语义，实现留壳——但三处壳（legacy readline / ink / next）不得各写
// 一份，统一收敛到本表，由各入口经 createShellCommandDispatcher 表驱动分发（壳内禁止
// switch/case 命令名）。实现与文案以 legacy-chat 为基准逐字统一；各壳的呈现差异经
// ShellCommandContext 可选缝注入（ink 的无参 /mode 选择浮层、/reasoning off 收起推理块），
// next 的 /mode 为 UI 四态声明态语义（测试锁定 + P3-B 红线 6），经 dispatcher override 注册。
import type { ChatRuntime } from './chat-setup.js';
import { MODE_ALIAS_LABEL, MODE_ALIAS_ORDER, MODE_ALIAS_TO_CORE, describeMode, parseModeAlias } from './mode-alias.js';

/** 壳侧命令执行缝：print 为该壳的转录输出；runtime 提供审批模式/推理开关状态（两路径同一份） */
export interface ShellCommandContext {
  print(text: string): void;
  runtime: ChatRuntime;
  /** ink 缝：无参 /mode 打开交互选择浮层（注入后取代基准实现的文本列表呈现；带参仍走基准实现） */
  openModePicker?: () => void;
  /** ink 缝：/reasoning off 后收起已展开的推理块（壳侧呈现附加行为，legacy/next 不注入） */
  onReasoningOff?: () => void;
}

export type ShellCommandRun = (ctx: ShellCommandContext, rest: string) => void;

export interface ShellCommand {
  /** 规范命令 id（不含 /；与 core 元数据一致） */
  id: string;
  run: ShellCommandRun;
}

/**
 * /mode：审批模式查看/切换（legacy-chat 基准文案，三处壳逐字统一）。
 * 无参：默认列出当前模式与可选模式（ink 注入 openModePicker 缝时改为选择浮层）；
 * 带参：parseModeAlias 解析（含 core 值兼容）→ runtime.setMode → 确认文案。
 */
export const runModeCommand: ShellCommandRun = (ctx, rest) => {
  if (rest.length === 0) {
    if (ctx.openModePicker !== undefined) {
      ctx.openModePicker();
      return;
    }
    ctx.print(`当前模式: ${describeMode(ctx.runtime.mode())}`);
    ctx.print('可选模式:');
    for (const alias of MODE_ALIAS_ORDER) {
      ctx.print(`  ${alias}\t${MODE_ALIAS_LABEL[alias]}`);
    }
    ctx.print('用法: /mode <别名>（如 /mode plan）');
    return;
  }
  const alias = parseModeAlias(rest);
  if (alias === undefined) {
    ctx.print(`error: 未知模式 ${rest}（可选: ${MODE_ALIAS_ORDER.join(', ')}）`);
    return;
  }
  ctx.runtime.setMode(MODE_ALIAS_TO_CORE[alias]);
  ctx.print(`已切换模式: ${alias}（${MODE_ALIAS_LABEL[alias]}）`);
};

/**
 * /reasoning：推理展示查看/切换（legacy-chat 基准文案，三处壳逐字统一）。
 * off 时若壳注入 onReasoningOff 缝（ink）则先收起已展开的推理块再输出确认行。
 */
export const runReasoningCommand: ShellCommandRun = (ctx, rest) => {
  const arg = rest.trim().toLowerCase();
  if (arg.length === 0) {
    ctx.print(`推理展示: ${ctx.runtime.reasoning() ? '开启' : '关闭'}（/reasoning on|off）`);
    return;
  }
  if (arg === 'on') {
    ctx.runtime.setReasoning(true);
    ctx.print('推理展示已开启（灰色斜体折叠输出）。');
    return;
  }
  if (arg === 'off') {
    ctx.runtime.setReasoning(false);
    if (ctx.onReasoningOff !== undefined) ctx.onReasoningOff();
    ctx.print('推理展示已关闭。');
    return;
  }
  ctx.print(`error: 未知参数 ${rest}（用 on|off，或留空查看当前状态）`);
};

/** 壳侧命令表（当前仅 core shellOnly 的两条；表驱动——壳内不得再出现 switch/case 命令名） */
export const SHELL_COMMANDS: readonly ShellCommand[] = [
  { id: 'mode', run: runModeCommand },
  { id: 'reasoning', run: runReasoningCommand },
];

/**
 * 构建壳侧命令分发器（查表执行；未注册返回 false，调用方回落 core runCoreCommand）。
 * overrides 允许某壳为特定 shellOnly 命令注册本壳变体（当前仅 next 的 UI 四态 /mode，
 * 差异裁决登记在其调用处），不得用于新增 core 未注册的命令（那是壳内第二份清单）。
 */
export function createShellCommandDispatcher(
  overrides: Readonly<Record<string, ShellCommandRun>> = {},
): (id: string, rest: string, ctx: ShellCommandContext) => boolean {
  const table = new Map<string, ShellCommandRun>(SHELL_COMMANDS.map((c) => [c.id, c.run]));
  for (const [id, run] of Object.entries(overrides)) {
    table.set(id, run);
  }
  return (id, rest, ctx) => {
    const run = table.get(id);
    if (run === undefined) return false;
    run(ctx, rest);
    return true;
  };
}
