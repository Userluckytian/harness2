// 命令行词法解析（纯函数，无注册表依赖——别名解析在 registry 完成，避免循环依赖）。
// 词法与 parseUndoArgs 从 cli commands.ts 逐字搬平（parseCommand / parseUndoArgs）。

/** 词法解析结果 */
export interface SplitCommandLine {
  /** 命令词（含 / 前缀，小写——未知命令报错文案用） */
  word: string;
  /** 其余参数（已 trim） */
  rest: string;
}

/** 解析命令行：以 / 开头返回命令词与参数；非命令返回 null */
export function splitCommandLine(line: string): SplitCommandLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIdx = trimmed.indexOf(' ');
  const word = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  return { word, rest };
}

/** /undo 参数解析结果 */
export interface UndoArgs {
  count: number;
  dryRun: boolean;
}

/** /undo 参数解析：[n] [--dry-run]；非法返回错误消息（文案与 cli 一致） */
export function parseUndoArgs(rest: string): UndoArgs | string {
  let count = 1;
  let dryRun = false;
  for (const token of rest.split(/\s+/).filter((t) => t.length > 0)) {
    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }
    const n = Number(token);
    if (!Number.isInteger(n) || n < 1 || n > 100) return `无效的撤回层数 "${token}"（应为 1..100 整数）`;
    count = n;
  }
  return { count, dryRun };
}
