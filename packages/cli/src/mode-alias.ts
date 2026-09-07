// mode-alias：/mode 命令的对外别名 ↔ 内核 ApprovalMode 映射（两路径共用，禁各写一份）。
// 展示名 normal/allow-approve/auto/plan 是用户输入与状态栏文案；内核值来自 APPROVAL_MODES。
import type { ApprovalMode } from '@harness2/core';

/** 状态栏与 /mode 选项使用的展示别名 */
export type ModeAlias = 'normal' | 'allow-approve' | 'auto' | 'plan';

/** 展示别名 → 内核 mode */
export const MODE_ALIAS_TO_CORE: Readonly<Record<ModeAlias, ApprovalMode>> = {
  normal: 'default',
  'allow-approve': 'acceptEdits',
  auto: 'bypass',
  plan: 'plan',
};

/** 内核 mode → 展示别名 */
export const CORE_MODE_TO_ALIAS: Readonly<Record<ApprovalMode, ModeAlias>> = {
  default: 'normal',
  acceptEdits: 'allow-approve',
  bypass: 'auto',
  plan: 'plan',
};

/** /mode 列表展示顺序（SelectList 选项与 legacy 纯文本列出的顺序一致） */
export const MODE_ALIAS_ORDER: readonly ModeAlias[] = ['normal', 'allow-approve', 'auto', 'plan'];

export const MODE_ALIAS_LABEL: Readonly<Record<ModeAlias, string>> = {
  normal: 'normal（default：只读自动放行，其余询问）',
  'allow-approve': 'allow-approve（acceptEdits：编辑类自动放行）',
  auto: 'auto（bypass：全部放行）',
  plan: 'plan（只读放行，其余拒绝，等待手动切换）',
};

/** 把任意字符串解析为 ModeAlias；无效返回 undefined（供 /mode <arg> 带参分支用） */
export function parseModeAlias(raw: string): ModeAlias | undefined {
  const trimmed = raw.trim().toLowerCase();
  const key = trimmed.replace(/^\/mode\s*/, '');
  if (key === '' || key === 'mode') return undefined;
  const alias = (Object.keys(MODE_ALIAS_TO_CORE) as ModeAlias[]).find((a) => a === key);
  // 兼容内核值直接输入（default/acceptEdits/bypass/plan）
  if (alias !== undefined) return alias;
  const coreKey = (Object.keys(CORE_MODE_TO_ALIAS) as ApprovalMode[]).find((m) => m === key);
  return coreKey !== undefined ? CORE_MODE_TO_ALIAS[coreKey] : undefined;
}

/** 内核 mode → 展示文本（StatusBar / StatusBar 后的模式段；与 MODE_ALIAS_LABEL 同口径） */
export function describeMode(mode: ApprovalMode): string {
  return MODE_ALIAS_LABEL[CORE_MODE_TO_ALIAS[mode]];
}

/** plan 模式下追加到每条 user message 的系统前缀（两路径共用同一份文案常量） */
export const PLAN_MODE_SYSTEM_PREFIX =
  '[系统：当前处于 plan 模式。只读工具可用，write/edit/bash 等有副作用的工具调用会被拒绝执行。请先给出你的计划，不要反复重试被拒绝的工具调用；等用户手动切换到其他模式后再执行。]';