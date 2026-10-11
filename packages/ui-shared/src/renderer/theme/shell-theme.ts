// 壳主题状态（D-15 的驱动源）：偏好主题 + 立即呈现（memory-only，不自行落盘）。
// Z7：自 desktop `renderer/layout/shell-theme.ts` 下沉 ui-shared（桌面/web 共享；桌面按原路径再导出）。
// 落盘仍走各壳自己的偏好通道（桌面 settings:* IPC；web 走浏览器存储主题例外 #1，见 theme.ts）。
import type { SettingsTheme } from '../../shared/settings.js';
import { createShellStore, useShellStore, type ShellStore } from '../shell-store.js';
import { applyTheme, themeLabel } from './theme.js';
import { applyThemePresentation, type MatchMediaLike } from './theme-presenter.js';

export interface ShellThemeState {
  readonly theme: SettingsTheme;
}

export const shellThemeStore: ShellStore<ShellThemeState> = createShellStore({ theme: 'system' });

let disposePresentation: (() => void) | null = null;
let disposeDataset: (() => void) | null = null;

/** 立即应用主题（既有 data-theme 变量切换 + D-15 四要素一起写） */
export function setShellTheme(theme: SettingsTheme, opts: { matchMedia?: MatchMediaLike } = {}): void {
  disposePresentation?.();
  disposeDataset?.();
  disposeDataset = applyTheme(theme);
  disposePresentation = applyThemePresentation(theme, { matchMedia: opts.matchMedia });
  shellThemeStore.patch({ theme });
}

/** 当前主题 */
export function getShellTheme(): SettingsTheme {
  return shellThemeStore.getSnapshot().theme;
}

/** 主题标签（命令面板 / 设置页展示用；与外观分区同源） */
export function shellThemeLabel(theme: SettingsTheme = getShellTheme()): string {
  return themeLabel(theme);
}

/** 订阅当前主题 */
export function useShellTheme(): SettingsTheme {
  return useShellStore(shellThemeStore).theme;
}
