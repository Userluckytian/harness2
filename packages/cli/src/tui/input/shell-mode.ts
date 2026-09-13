// shell-mode.ts — P2-B：Shell 模式检测（G-11：行首 `!` 进入 shell 模式直接执行命令）。
//
// 规格依据：docs/refs/refs-grok-build.md G-11。上游形态（refs/grok-build）是「空 prompt
// 敲 `!` 翻入 Bash 输入模式、提交即执行」+ 历史条目以 `! cmd` 前缀存储/恢复；本仓库 composer
// 是整段草稿提交制，故本模块做成**草稿文本级检测器**：提交前对整段草稿跑 detectShellMode，
// 命中则走 shell 执行通道（执行器由接线层注入，本模块不发进程）。
//
// ── 转义边界（派工授权自定，逐条钉死）────────────────────────────────────────
//  1. 触发位 = 草稿**第一个字符**是 ASCII `!`（U+0021）。首字符之外（` !cmd`、`hello !`、
//     第二行行首）一律不触发——「行首」以草稿首字符为准，避免与多行草稿的逐行歧义。
//  2. `!!rest` → **字面文本**，不触发（转义口：让用户能发以 `!` 开头的普通消息，
//     类 shell 历史展开惯例）。`!!` 后接什么、甚至只有 `!!` 都不触发。
//  3. `!` 后紧跟空白（`! cmd`）或直接接命令（`!cmd`）都触发；**只剥离一个**空白分隔符
//     （`!  cmd` → 命令 ` cmd`，多余的空格归命令本身——对齐上游历史恢复 strip_prefix("! ") 的
//     「剥前缀不多剥」口径）。命令 = 剥前缀后的**整段草稿**（含换行，支持多行脚本）。
//  4. 只有 `!` 或 `!` + 纯空白（含只有换行）→ **不触发**（空命令没有可执行物）。
//  5. 全角 `！`（U+FF01）不触发（shell 语法只认 ASCII）。
//  6. 触发与焦点/回合状态无关（本模块只看文本）；忙时 `!` 命令是否入队由接线层按 G-26 队列
//     语义裁决，不在此处。

export interface ShellModeDecision {
  /** true = 触发 shell 模式（草稿应交给 shell 执行而非模型回合） */
  readonly shell: boolean;
  /** shell = true 时的命令文本（剥 `!` 前缀与至多一个空白分隔符后的整段草稿） */
  readonly command: string;
  /** shell = false 时的不触发原因（诊断/测试用；shell = true 时为 null） */
  readonly notShellReason:
    null | 'empty' | 'first-char-not-bang' | 'double-bang-escape' | 'blank-command' | 'fullwidth-bang';
}

/** 行首 `!` 检测与 shell 命令提取（G-11；边界见文件头）。纯函数。 */
export function detectShellMode(draft: string): ShellModeDecision {
  if (draft.length === 0) return notShell('empty');
  const first = draft.charAt(0);
  if (first === '！') return notShell('fullwidth-bang');
  if (first !== '!') return notShell('first-char-not-bang');
  if (draft.startsWith('!!')) return notShell('double-bang-escape'); // 转义口：字面 `!` 消息
  const command = draft.slice(1);
  // 剥至多一个空白分隔符（`! cmd` 与 `!cmd` 等价；`!  cmd` 的第二个空格归命令）
  const stripped = command.startsWith(' ') ? command.slice(1) : command;
  if (stripped.trim().length === 0) return notShell('blank-command'); // `!`/`!   `/`! \n \n` 无可执行物
  return { shell: true, command: stripped, notShellReason: null };
}

/** 便捷判断：该草稿是否触发 shell 模式 */
export function isShellMode(draft: string): boolean {
  return detectShellMode(draft).shell;
}

function notShell(reason: NonNullable<ShellModeDecision['notShellReason']>): ShellModeDecision {
  return { shell: false, command: '', notShellReason: reason };
}

/**
 * 历史条目前缀（上游口径）：shell 执行的历史条目以 `! cmd` 形式存储；恢复时剥前缀回 shell 模式。
 * 供接线层写历史/回显使用（本阶段只定义数据口径，不接 UI）。
 */
export const SHELL_HISTORY_PREFIX = '! ';

/** 历史存储形态：`! ` + 命令原文（多行命令原样拼接，恢复时剥前缀即得命令） */
export function formatShellHistoryEntry(command: string): string {
  return SHELL_HISTORY_PREFIX + command;
}

/** 从历史条目提取命令：`! ` 前缀命中返回命令（shell 模式恢复），否则 null（普通模型消息） */
export function parseShellHistoryEntry(entry: string): string | null {
  return entry.startsWith(SHELL_HISTORY_PREFIX) ? entry.slice(SHELL_HISTORY_PREFIX.length) : null;
}
