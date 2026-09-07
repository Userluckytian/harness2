// 桌面端纯 UI 偏好 schema（main/renderer 共享）：~/.harness2/desktop-preferences.json。
// 只存「不影响内核行为」的桌面 UI 偏好；模型/审批/记忆等正式配置一律走 config.json/auth.json
// （与 CLI 共用同一份，不建平行配置）。normalizePreferences 是文件读取与 IPC 保存的唯一校验口
// （损坏/越界一律回落默认值），复刻 shared/layout.ts 的 normalizeLayout 模式。
export const THEMES = ['warmPaper', 'dark', 'system'] as const;
export type DesktopTheme = (typeof THEMES)[number];

export const NOTIFY_DETAILS = ['minimal', 'full'] as const;
export type NotifyDetails = (typeof NOTIFY_DETAILS)[number];

export interface DesktopPreferences {
  /** 主题：暖纸浅色 / 深色 / 跟随系统（渲染层据 data-theme 切换） */
  theme: DesktopTheme;
  /** 启动默认分栏数（1..3） */
  defaultPaneCount: number;
  /** 是否显示欢迎页/引导（当前仅记录，欢迎页属后续阶段） */
  showWelcome: boolean;
  /** 任务完成系统通知详情级别 */
  notifyDetails: NotifyDetails;
}

export function defaultPreferences(): DesktopPreferences {
  return { theme: 'warmPaper', defaultPaneCount: 1, showWelcome: true, notifyDetails: 'minimal' };
}

/** 校验未知来源的偏好数据（磁盘文件/IPC）：形状非法/越界一律回落默认字段 */
export function normalizePreferences(raw: unknown): DesktopPreferences {
  const fallback = defaultPreferences();
  if (typeof raw !== 'object' || raw === null) return fallback;
  const o = raw as Record<string, unknown>;
  return {
    theme: THEMES.includes(o['theme'] as DesktopTheme) ? (o['theme'] as DesktopTheme) : fallback.theme,
    defaultPaneCount:
      typeof o['defaultPaneCount'] === 'number' &&
      Number.isInteger(o['defaultPaneCount']) &&
      o['defaultPaneCount'] >= 1 &&
      o['defaultPaneCount'] <= 3
        ? o['defaultPaneCount']
        : fallback.defaultPaneCount,
    showWelcome: typeof o['showWelcome'] === 'boolean' ? o['showWelcome'] : fallback.showWelcome,
    notifyDetails: NOTIFY_DETAILS.includes(o['notifyDetails'] as NotifyDetails)
      ? (o['notifyDetails'] as NotifyDetails)
      : fallback.notifyDetails,
  };
}

export const PREFERENCES_FILE = 'desktop-preferences.json';