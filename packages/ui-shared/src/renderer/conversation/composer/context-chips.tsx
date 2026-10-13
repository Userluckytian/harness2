// context-chips.tsx — Z10-2 composer 上方「项目」「Git 分支」两个上下文 chip（壳无关纯展示）。
//
// 权威依据：docs/ai-framework/plans/2026-10-13-phase-Z10-p1-p2-parity.md §0.2（编排者内置浏览器
// 实测 1440×900）：项目 chip [516,348 96×28] 显示当前项目名，分支 chip [613,348 90×28] 显示当前
// git 分支，二者同处一行、位于 composer 输入框**上方**（composer 在 y=394/446）。
//
// 如实口径（红线⑩）：
//   * 本仓**没有**「切换当前会话项目/cwd」与「切换 git 分支」的既有通道（全仓无 checkout /
//     switch 类 IPC，见交付报告 grep 结论）→ 两 chip 均为**只读**：渲染为 disabled + title 说明
//     （`data-placeholder` 可 machine 分辨），绝不摆「点了没反应」的可点假 chip。
//   * 缺省不渲染：project / branch 任一缺失（无 cwd / gitBranch 返回 null / web 无通道）即不渲染
//     该 chip —— 不摆空 chip、不显示假分支名。
//
// 壳无关：纯展示，数据一律 props 注入；`projectNameFromCwd` / `branchShortName` / `buildContextChips`
// 为纯函数，桌面与 web 壳共用同一口径（避免两壳各写一份推导）。
import type { ReactNode } from 'react';

/** 单个上下文 chip 的数据面（label 为当前值；`onPick` 缺省 = 该壳无切换通道 → 只读）。 */
export interface ComposerContextChip {
  /** 当前值文案（项目名 / 分支名） */
  readonly label: string;
  /** 真实切换动作；缺省（undefined）= 无通道 → 只读（disabled + title 说明） */
  readonly onPick?: () => void;
  /** 只读态悬停说明（为什么不可点）；缺省非空（见 CONTEXT_CHIP_READONLY_HINT）。 */
  readonly disabledHint?: string;
}

/** composer 上方两 chip 的数据面（任一缺省 = 该项不渲染）。 */
export interface ComposerContextChipsProps {
  readonly project?: ComposerContextChip;
  readonly branch?: ComposerContextChip;
}

/** 只读 chip 的缺省悬停说明（壳未给 `disabledHint` 时）。 */
export const CONTEXT_CHIP_READONLY_HINT = '暂不支持切换';
/** 项目 chip 只读态悬停说明（本仓无「切换当前会话项目」通道）。 */
export const CONTEXT_CHIP_PROJECT_READONLY_HINT = '暂不支持切换项目';
/** 分支 chip 只读态悬停说明（本仓无「切换 git 分支」通道）。 */
export const CONTEXT_CHIP_BRANCH_READONLY_HINT = '暂不支持切换分支';

/**
 * cwd → 项目名（末段）。正反斜杠都识别（Windows / POSIX 路径），忽略尾部斜杠；空串 / 无末段
 * （如 `/` 或 `C:\`）→ undefined（不摆空 chip）。
 */
export function projectNameFromCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  const trimmed = cwd.replace(/[\\/]+$/, '');
  if (trimmed.length === 0) return undefined;
  const parts = trimmed.split(/[\\/]+/);
  const last = parts[parts.length - 1];
  return last !== undefined && last.length > 0 ? last : undefined;
}

/** git 分支简称：去 `heads/` 前缀（与桌面会话头 `shortBranch` 同口径）。 */
export function branchShortName(branch: string): string {
  return branch.startsWith('heads/') ? branch.slice('heads/'.length) : branch;
}

/**
 * 由会话 cwd 与 git 分支名装配 chip 数据面（各壳共用口径）。
 *   * 二者都无 → undefined（整行不渲染）；
 *   * 缺哪项就不出哪项（不摆空 chip、不显示假分支名）；
 *   * `options.*OnPick` 提供时该项为可点真动作；缺省即只读（disabled + title）。
 */
export function buildContextChips(
  cwd: string | undefined,
  branch: string | undefined,
  options: { readonly projectOnPick?: () => void; readonly branchOnPick?: () => void } = {},
): ComposerContextChipsProps | undefined {
  const name = projectNameFromCwd(cwd);
  const branchLabel = branch !== undefined && branch.length > 0 ? branchShortName(branch) : undefined;
  const project: ComposerContextChip | undefined =
    name === undefined
      ? undefined
      : {
          label: name,
          disabledHint: CONTEXT_CHIP_PROJECT_READONLY_HINT,
          ...(options.projectOnPick !== undefined ? { onPick: options.projectOnPick } : {}),
        };
  const branchChip: ComposerContextChip | undefined =
    branchLabel === undefined
      ? undefined
      : {
          label: branchLabel,
          disabledHint: CONTEXT_CHIP_BRANCH_READONLY_HINT,
          ...(options.branchOnPick !== undefined ? { onPick: options.branchOnPick } : {}),
        };
  if (project === undefined && branchChip === undefined) return undefined;
  return {
    ...(project !== undefined ? { project } : {}),
    ...(branchChip !== undefined ? { branch: branchChip } : {}),
  };
}

/** 单个 chip 元素：有 `onPick` = 可点真动作；否则 disabled + title + data-placeholder（红线⑩）。 */
function ContextChipButton({
  kind,
  chip,
}: {
  readonly kind: 'project' | 'branch';
  readonly chip: ComposerContextChip;
}): ReactNode {
  const real = chip.onPick !== undefined;
  return (
    <button
      type="button"
      className={real ? 'composer-context-chip' : 'composer-context-chip composer-context-chip-readonly'}
      data-testid={`composer-context-chip-${kind}`}
      data-kind={kind}
      {...(real ? {} : { 'data-placeholder': 'true' })}
      title={real ? chip.label : (chip.disabledHint ?? CONTEXT_CHIP_READONLY_HINT)}
      disabled={!real}
      {...(real ? { onClick: chip.onPick } : {})}
    >
      {chip.label}
    </button>
  );
}

/** 两 chip 行（位于 `.composer` 内、编辑器之前）；两项都缺 → null（不渲染空行）。 */
export function ComposerContextChipRow({
  chips,
}: {
  readonly chips: ComposerContextChipsProps | undefined;
}): ReactNode {
  if (chips === undefined || (chips.project === undefined && chips.branch === undefined)) return null;
  return (
    <div className="composer-context-chips" data-testid="composer-context-chips">
      {chips.project !== undefined && <ContextChipButton kind="project" chip={chips.project} />}
      {chips.branch !== undefined && <ContextChipButton kind="branch" chip={chips.branch} />}
    </div>
  );
}
