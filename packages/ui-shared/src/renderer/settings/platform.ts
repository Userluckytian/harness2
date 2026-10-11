// 设置壳的平台判定（Z-88 右栏容器圆角按平台：Windows 5px，其余 xl）。
// 共享层不引任何壳的 platform 模块：只结构性读取宿主同步暴露的 `harness2.platform`
// （桌面 preload）；web / 测试夹具缺失 → null（不启用平台特化，实测仍是 xl 圆角）。
export type SettingsPlatform = 'darwin' | 'win32' | 'linux' | null;

export function settingsPlatform(): SettingsPlatform {
  if (typeof window === 'undefined') return null;
  const api = (globalThis as { harness2?: { platform?: unknown } }).harness2;
  const p = api?.platform;
  return p === 'darwin' || p === 'win32' || p === 'linux' ? p : null;
}
