// ansi.ts — 终端转义序列工具（P2 T2-1）。零外部依赖。
// 序列常量集中在此，供 diff-presenter / screen / 装配层引用，避免魔法串散落。

export const ESC = '\x1b';

/** 光标绝对定位 CUP：参数为 0-based 逻辑坐标，序列按终端 1-based 发射 */
export function cup(x: number, y: number): string {
  return `${ESC}[${y + 1};${x + 1}H`;
}

// --- SGR ---

export const SGR_RESET = `${ESC}[0m`;

/** 256 色前景 */
export function sgrFg256(n: number): string {
  return `${ESC}[38;5;${n}m`;
}

/** truecolor 前景 */
export function sgrFgRgb(r: number, g: number, b: number): string {
  return `${ESC}[38;2;${r};${g};${b}m`;
}

// --- 生命周期 ---

/** 进入备用屏幕缓冲 */
export const ALT_SCREEN_ENTER = `${ESC}[?1049h`;
/** 退出备用屏幕缓冲（恢复主缓冲内容） */
export const ALT_SCREEN_EXIT = `${ESC}[?1049l`;

/** 隐藏光标 */
export const HIDE_CURSOR = `${ESC}[?25l`;
/** 显示光标 */
export const SHOW_CURSOR = `${ESC}[?25h`;

/** 开启鼠标上报：按键+拖动事件（1000/1002）+ SGR 扩展坐标（1006），单序列合并发射 */
export const MOUSE_ON = `${ESC}[?1000;1002;1006h`;
/** 关闭鼠标上报（与 MOUSE_ON 对称，逆序复位不必要：模式位独立） */
export const MOUSE_OFF = `${ESC}[?1000;1002;1006l`;

// --- 清除 ---

/** 清整行（光标所在行） */
export const CLEAR_LINE = `${ESC}[2K`;
/** 清光标到行尾 */
export const CLEAR_TO_EOL = `${ESC}[K`;
/** 清整屏（光标归位行为由终端决定，全量重绘前使用） */
export const CLEAR_SCREEN = `${ESC}[2J`;
