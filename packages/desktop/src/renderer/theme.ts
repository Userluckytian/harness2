// 主题切换（B2 外观）：把桌面偏好 theme 应用于 <html data-theme>。
// warmPaper = 不设 data-theme（:root 暖纸生效）；dark = data-theme="dark"；
// system = 跟随系统 prefers-color-scheme（热更新监听）。
import type { SettingsTheme } from '../shared/protocol.js';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemIsDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(DARK_QUERY).matches === true;
}

/** theme 偏好 → 实际 data-theme 值（dark / 无） */
export function resolvedTheme(theme: SettingsTheme): 'dark' | null {
  if (theme === 'dark') return 'dark';
  if (theme === 'system') return systemIsDark() ? 'dark' : null;
  return null; // warmPaper
}

/** 应用主题（不重启切换）；返回一个取消函数（system 模式监听变化） */
export function applyTheme(theme: SettingsTheme): () => void {
  const mq = typeof window !== 'undefined' ? window.matchMedia?.(DARK_QUERY) : undefined;
  const set = (): void => {
    const dark = resolvedTheme(theme);
    if (dark === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  };
  set();
  if (theme === 'system' && mq !== undefined) {
    const onChange = (): void => set();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }
  return () => {};
}

export function themeLabel(theme: SettingsTheme): string {
  switch (theme) {
    case 'warmPaper':
      return '暖纸浅色';
    case 'dark':
      return '深色';
    case 'system':
      return '跟随系统';
  }
}