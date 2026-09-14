// 壳主题状态（D-15 的驱动源）：偏好主题 + 立即呈现（memory-only，不自行落盘）。
// 落盘仍走既有 settings:* IPC（命令面板循环主题时显式写偏好；设置弹窗保存时它自己写）。
import type { SettingsTheme } from '../../shared/protocol.js';
import { applyTheme, themeLabel } from '../theme.js';
import { applyThemePresentation, type MatchMediaLike } from './theme-presenter.js';
import { createShellStore, useShellStore, type ShellStore } from './shell-store.js';

export interface ShellThemeState {
  readonly theme: SettingsTheme;
}

export const shellThemeStore: ShellStore<ShellThemeState> = createShellStore({ theme: 'warmPaper' });

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

/** 主题标签（命令面板展示用；与设置页同源） */
export function shellThemeLabel(theme: SettingsTheme = getShellTheme()): string {
  return themeLabel(theme);
}

/** 订阅当前主题 */
export function useShellTheme(): SettingsTheme {
  return useShellStore(shellThemeStore).theme;
}
