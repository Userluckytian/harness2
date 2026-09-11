// paste.ts — 终端粘贴内核（纯函数，零 ink/react 依赖，可单测）。
//
// 契约见 docs/issue-log/2026-09-11-T.md §7。要点：
//  - normalizePaste：CRLF / 孤立 CR → LF。ink 7 的 usePaste 原样投递 CRLF（实测），故必须归一。
//  - classifyPaste：短单行 → inline（直接插入 draft）；多行或超长单行 → chip（草稿只放占位标签）；
//    归一后 UTF-8 字节数 > PASTE_MAX_BYTES（1MiB）→ rejected（可读原因，不插入）。
//  - 字节计数一律用 Buffer.byteLength(..., 'utf8')，不是 JS 字符长度（中文/emoji 差异显著）。
//  - chip 保存**归一后的完整原文**；提交时由 Composer 用 chip.text 展开占位标签，绝不截断。
//
// 单个行尾换行的处理（显式决策）：**保留**。行尾换行是正文的一部分，静默删除等于改写用户内容，
// 与「提交用完整原文、绝不截断」冲突；且粘贴是原子插入，保留换行也不会触发提交（提交只由显式 Enter 触发）。
//
// 1MiB 限额：拒绝而非截断——超出时返回 {kind:'rejected'}，由 UI 给出反馈，避免静默丢内容。

/** 粘贴内容上限：1 MiB（UTF-8 字节）。超过即拒绝，绝不截断。 */
export const PASTE_MAX_BYTES = 1024 * 1024;

/**
 * 单行粘贴仍走 inline 的字节上限（UI 渲染阈值，非内容限额）。
 * 超过该值的单行也转 chip，避免把超长单行直接塞进输入框渲染。
 */
export const PASTE_INLINE_MAX_BYTES = 4 * 1024;

export interface PasteChip {
  /** chip 序号（字符串），用于占位标签与展开定位 */
  id: string;
  /** 归一后的完整原文（提交时原样展开，绝不截断） */
  text: string;
  /** 逻辑行数（行尾换行不额外算一行） */
  lines: number;
  /** UTF-8 字节数（Buffer.byteLength） */
  bytes: number;
}

export type PasteClassifyResult =
  { kind: 'inline'; text: string } | { kind: 'chip'; chip: PasteChip } | { kind: 'rejected'; reason: string };

/** CRLF / 孤立 CR → LF；其余原样（含单个行尾换行）。 */
export function normalizePaste(raw: string): string {
  return raw.replace(/\r\n?/g, '\n');
}

/** 逻辑行数：行尾换行视为行终止符，不额外产生一个空行。 */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  const withoutTrailing = text.endsWith('\n') ? text.slice(0, -1) : text;
  return withoutTrailing.split('\n').length;
}

/** 人类可读字节数（B / KB / MB，保留一位小数）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** chip 占位标签（插进 draft 的可读文本；提交时按此展开为完整原文）。 */
export function renderChipLabel(chip: PasteChip): string {
  return `[粘贴 #${chip.id} · ${chip.lines} 行 · ${formatBytes(chip.bytes)}]`;
}

/** 分类粘贴：短单行 → inline；多行/超长单行 → chip；> 1MiB → rejected。 */
export function classifyPaste(raw: string, seq: number): PasteClassifyResult {
  const text = normalizePaste(raw);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > PASTE_MAX_BYTES) {
    return {
      kind: 'rejected',
      reason: `粘贴内容超过 1MB 限额（${formatBytes(bytes)}），未插入`,
    };
  }
  const multiline = text.includes('\n');
  if (multiline || bytes > PASTE_INLINE_MAX_BYTES) {
    return {
      kind: 'chip',
      chip: { id: String(seq), text, lines: countLines(text), bytes },
    };
  }
  return { kind: 'inline', text };
}
