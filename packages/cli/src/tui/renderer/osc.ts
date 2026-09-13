// osc.ts — OSC 终端序列构造（P4-1，零依赖，Node 内置 Buffer）。
//
// - OSC 8 超链接：`\x1b]8;;URL\x1b\\`（空 params 形式）… `\x1b]8;;\x1b\\` 关闭。
//   终端兼容面：Windows Terminal 10g+、iTerm2、GNOME Terminal (VTE)、kitty、WezTerm、
//   foot 支持；不支持的终端按不认识序列处理（多数把 OSC 段整体吞掉不显示，退化为纯文本）。
// - OSC 52 剪贴板：`\x1b]52;c;<base64>\x1b\\`。Windows Terminal 1.17+ 支持（且需
//   settings 内允许 OSC52 / 默认支持剪贴板写入；较老版本忽略）。
//   URL 不做转义：来源为行内连续非空白区段，不可能包含 ESC/ST 终止符。

/** OSC8 关闭序列（空 URL 形式） */
export const OSC8_CLOSE = '\x1b]8;;\x1b\\';

/** OSC8 打开序列：包住一段超链接文本 */
export function osc8Open(url: string): string {
  return `\x1b]8;;${url}\x1b\\`;
}

/** OSC52 复制序列：把文本以 base64 写进系统剪贴板（clipboard selection 'c'） */
export function osc52Copy(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x1b\\`;
}
