// 主题运行时（B2 外观 + Z1-05 三态）：把主题偏好应用到 <html>。Z7：自 desktop `renderer/theme.ts`
// 下沉 ui-shared（桌面/web 共享；桌面按原路径再导出）。
//
// 偏好三选一：system / zai-light / zai-dark（Z-66；默认 system = 跟随系统）。
// 每次应用都写全并清理旧值：
//   1) 根 class 三选一 theme-zai-light / theme-zai-dark（先移除另一个）；
//   2) 解析为深色时加 `dark` class，浅色时移除；
//   3) <html data-theme="zai-light"|"zai-dark">（本仓相对 ZCode 的刻意改进，便于调试与断言）；
//   4) <html style.color-scheme> = light|dark；
//   5) 偏好值镜像到 localStorage['harness2-theme']（首屏防闪脚本读，供 index.html / public/theme-boot.js）。
// D-15 四要素中的 body[data-ds-dark-theme] / --dsh-content-font-size / <meta name=theme-color>
// 由 theme-presenter.ts 一并写入（shell-theme 同时调用两者）。
import type { SettingsTheme } from '../../shared/settings.js';

const DARK_QUERY = '(prefers-color-scheme: dark)';
/** 首屏防闪脚本读取的持久化 key（见 public/theme-boot.js） */
export const THEME_STORAGE_KEY = 'harness2-theme';
const LIGHT_CLASS = 'theme-zai-light';
const DARK_CLASS = 'theme-zai-dark';

/** 解析后的实际主题（两态；system 由 prefers-color-scheme 解析） */
export type ResolvedTheme = 'zai-light' | 'zai-dark';

function systemIsDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(DARK_QUERY).matches === true;
}

/** theme 偏好 → 解析结果（zai-light / zai-dark）；无 matchMedia 环境（如 jsdom）视为浅色 */
export function resolvedTheme(theme: SettingsTheme): ResolvedTheme {
  if (theme === 'zai-dark') return 'zai-dark';
  if (theme === 'zai-light') return 'zai-light';
  return systemIsDark() ? 'zai-dark' : 'zai-light';
}

/** 偏好值（非解析结果）镜像到 localStorage；隐私模式/存储不可用时静默忽略 */
function mirrorPreference(theme: SettingsTheme): void {
  try {
    window.localStorage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 存储不可用（隐私模式等）：防闪退化为默认 system，不阻断应用
  }
}

/** 桌面 nativeTheme 镜像（Z-86）：system 传 'system'，否则传解析结果。
 *  web / 旧夹具未暴露该通道（缺省 undefined）→ 如实忽略，不伪造成功。 */
function mirrorNativeTheme(theme: SettingsTheme): void {
  const value = theme === 'system' ? 'system' : theme === 'zai-dark' ? 'dark' : 'light';
  try {
    const api = (globalThis as { harness2?: { setTitleBarTheme?: (t: string) => Promise<unknown> } }).harness2;
    const pending = api?.setTitleBarTheme?.(value);
    void pending?.catch(() => {});
  } catch {
    // preload 未暴露该通道（旧版本/测试夹具/非桌面壳）：如实忽略
  }
}

/** 把解析结果写全到 <html>（class + dark + data-theme + color-scheme），返回解析结果 */
function writeDom(theme: SettingsTheme): ResolvedTheme {
  const resolved = resolvedTheme(theme);
  const dark = resolved === 'zai-dark';
  const root = document.documentElement;
  root.classList.remove(dark ? LIGHT_CLASS : DARK_CLASS);
  root.classList.add(dark ? DARK_CLASS : LIGHT_CLASS);
  root.classList.toggle('dark', dark);
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = dark ? 'dark' : 'light';
  return resolved;
}

/** 应用主题（不重启切换）；返回取消函数（system 模式监听系统变化并重放） */
export function applyTheme(theme: SettingsTheme): () => void {
  const mq = typeof window !== 'undefined' ? window.matchMedia?.(DARK_QUERY) : undefined;
  const set = (): void => {
    writeDom(theme);
    mirrorPreference(theme);
    mirrorNativeTheme(theme);
  };
  set();
  if (theme === 'system' && mq !== undefined && typeof mq.addEventListener === 'function') {
    const onChange = (): void => set();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }
  return () => {};
}

export function themeLabel(theme: SettingsTheme): string {
  switch (theme) {
    case 'zai-light':
      return '浅色';
    case 'zai-dark':
      return '深色';
    case 'system':
      return '跟随系统';
  }
}
