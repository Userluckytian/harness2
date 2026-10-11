// 界面字号运行时（Z-90）：把界面字号（px）应用到 <html> 的 --ui-font-size（全部 text-ui-* 跟随）。
//
// 持久化 = **D-14 例外 #2**（理由同主题例外 #1：theme-boot.js 必须在 React 首渲染**之前**
// 同步读到偏好，settings:* IPC 异步不可得，浏览器存储是唯一同步通道；见 no-persistence.test.ts
// 白名单与 theme-boot.js 的注释）。key：localStorage['harness2-font-size']，值 = 整数 px 字符串。
//
// 与 theme.ts 的分工：主题归 theme.ts（例外 #1），字号归本模块（例外 #2）；两者共用
// public/theme-boot.js 的「首渲染前同步写 <html>」通道（desktop 与 web 各一份，保持同源实现）。
export const UI_FONT_SIZE_STORAGE_KEY = 'harness2-font-size';
export const UI_FONT_SIZE_CSS_VAR = '--ui-font-size';
/** Z-90 范围：12–20，默认 14 */
export const UI_FONT_SIZE_MIN = 12;
export const UI_FONT_SIZE_MAX = 20;
export const UI_FONT_SIZE_DEFAULT = 14;

/** 钳制进 [12, 20]（非整数向就近边界取整） */
export function clampUiFontSize(px: number): number {
  return Math.min(UI_FONT_SIZE_MAX, Math.max(UI_FONT_SIZE_MIN, Math.round(px)));
}

/** 读存储的偏好；无存储 / 越界 / 非法 → null（调用方回落默认值，不造值） */
export function readStoredUiFontSize(storage?: Pick<Storage, 'getItem'>): number | null {
  try {
    const raw = (storage ?? window.localStorage)?.getItem(UI_FONT_SIZE_STORAGE_KEY);
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const px = clampUiFontSize(n);
    // 原始值越界视为无效（防闪脚本同样口径）：静默忽略，回落默认
    if (px !== n) return null;
    return px;
  } catch {
    return null; // 存储不可用（隐私模式等）：回落默认字号，不阻断应用
  }
}

/** 应用字号（写根 --ui-font-size）并镜像到 localStorage（例外 #2）；返回应用后的值 */
export function applyUiFontSize(px: number): number {
  const next = clampUiFontSize(px);
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty(UI_FONT_SIZE_CSS_VAR, `${next}px`);
  }
  try {
    window.localStorage?.setItem(UI_FONT_SIZE_STORAGE_KEY, String(next));
  } catch {
    // 存储不可用：字号仍即时生效（本次会话），持久化退化，不阻断
  }
  return next;
}

/** 当前生效的界面字号（存储偏好 ?? 默认 14） */
export function currentUiFontSize(): number {
  return readStoredUiFontSize() ?? UI_FONT_SIZE_DEFAULT;
}

/** 应用启动时恢复字号（boot 脚本之后的双保险；无存储值时不写任何东西） */
export function initUiFontSize(): void {
  const stored = readStoredUiFontSize();
  if (stored !== null) applyUiFontSize(stored);
}
