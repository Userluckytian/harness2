// 设置页（桌面壳端口适配，Z7）：**唯一实现已下沉** `@harness2/ui-shared/renderer/settings`；
// 本文件只把 `window.harness2` 的 settings:* IPC 包成 `SettingsPorts` 注入共享设置页，并接桌面
// 主题 store（D-15 立即呈现）+ 界面字号运行时（例外 #2）。不在此写任何设置 UI。
import { useMemo, useState } from 'react';
import type { Harness2Api, SettingsTheme } from '../../shared/protocol.js';
import {
  SettingsPage as SharedSettingsPage,
  type SettingsCopy,
  type SettingsPorts,
} from '@harness2/ui-shared/renderer/settings/index.js';
import { PREFERENCES_FILE } from '../../shared/preferences.js';
import { useShellTheme } from '../layout/shell-theme.js';
import { applyUiFontSize, currentUiFontSize } from '../ui-font-size.js';

/**
 * 桌面壳的措辞（按壳注入共享设置页）：偏好文件名、打开设置键位、快捷键表、关于标题、定时任务说明
 * —— 均为桌面**真实情形**（与 App.tsx 全局键位表、main.ts 开发者工具绑定、desktop-preferences.json 一致）。
 */
const DESKTOP_SETTINGS_COPY: SettingsCopy = {
  aboutTitle: 'harness2 桌面端',
  preferencesFileLabel: PREFERENCES_FILE,
  openSettingsKeys: 'Ctrl+,',
  shortcutRows: [
    { keys: 'Enter', label: '发送当前消息' },
    { keys: 'Shift+Enter', label: '换行（不发送）' },
    { keys: 'Ctrl+, / Cmd+,', label: '打开设置' },
    { keys: 'Ctrl+K / Cmd+K', label: '命令面板' },
    { keys: 'Ctrl+N / Cmd+N', label: '新建会话' },
    { keys: 'Ctrl+J / Cmd+J', label: '切换终端面板' },
    { keys: 'Ctrl+Shift+I / Cmd+Opt+I', label: '开发者工具' },
  ],
  cronNote:
    '侧栏「自动化」进入主区视图，可用「定时任务模板」或表单创建任务；亦可经 CLI：harness2 cron add/remove/list。',
};

export interface SettingsPageProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 主题选择（宿主：立即呈现 D-15 四要素；持久化由共享页经 setPreferences 完成） */
  readonly onThemeChange: (t: SettingsTheme) => void;
  /** 本次打开要落到的分区 id（Z3-04 直达；undefined = 壳默认分区） */
  readonly defaultSectionId?: string;
}

/**
 * Z-47：把 preload 的托盘通道（TrayApi，Partial 面）适配成共享设置页的可选端口。
 * 缺通道（web 宿主 / 旧 jsdom 夹具）→ 返回空对象 = 通用分区不渲染「关窗驻留」开关（红线⑩）。
 */
function trayPortsFrom(api: Pick<Harness2Api, 'trayStatus' | 'traySetCloseToTray'>): Partial<SettingsPorts> {
  const { trayStatus, traySetCloseToTray } = api;
  const read = typeof trayStatus === 'function' ? trayStatus : undefined;
  const write = typeof traySetCloseToTray === 'function' ? traySetCloseToTray : undefined;
  return {
    ...(read !== undefined ? { getTrayStatus: () => read() } : {}),
    ...(write !== undefined ? { setCloseToTray: (enabled: boolean) => write(enabled) } : {}),
  };
}

export function SettingsPage({ open, onClose, onThemeChange, defaultSectionId }: SettingsPageProps): React.ReactNode {
  // 当前主题来自壳主题 store（P4/D-15 的真源），不另存一份易漂移的副本
  const theme = useShellTheme();
  // 界面字号真源（Z-90）：ui-font-size 运行时（浏览器存储键例外 #2 + 根变量）
  const [uiFontSize, setUiFontSize] = useState<number>(() => currentUiFontSize());

  const ports: SettingsPorts = useMemo<SettingsPorts>(
    () => ({
      getPreferences: () => window.harness2.settingsGetPreferences(),
      setPreferences: (p) => window.harness2.settingsSetPreferences(p),
      getConfig: () => window.harness2.settingsGetConfig(),
      updateConfig: (patch) =>
        window.harness2.settingsUpdateConfig(patch).then((r) => ({
          ok: r.ok,
          ...(r.config !== undefined ? { config: r.config } : {}),
          ...(r.error !== undefined ? { error: r.error } : {}),
          ...(r.warnings !== undefined ? { warnings: r.warnings } : {}),
        })),
      getAuthMasked: () => window.harness2.settingsGetAuthMasked(),
      updateAuth: (patch) => window.harness2.settingsUpdateAuth(patch),
      getDoctorReport: () => window.harness2.settingsGetDoctorReport(),
      getCrashReports: () => window.harness2.settingsGetCrashReports(),
      getSkills: () => window.harness2.settingsGetSkills(),
      // 模型配置通道面（Partial<ModelsSettingsApi>）：Harness2Api 结构上满足；缺失时分区如实降级。
      modelsApi: window.harness2,
      // Z-47 托盘端口（T2 主进程已就绪）：preload 缺通道（旧夹具）时如实不提供 → 共享页不渲染开关。
      ...trayPortsFrom(window.harness2),
      theme,
      onSelectTheme: onThemeChange,
      uiFontSize,
      onUiFontSizeCommit: (px) => setUiFontSize(applyUiFontSize(px)),
    }),
    [theme, onThemeChange, uiFontSize],
  );

  return (
    <SharedSettingsPage
      open={open}
      onClose={onClose}
      ports={ports}
      copy={DESKTOP_SETTINGS_COPY}
      {...(defaultSectionId !== undefined ? { defaultSectionId } : {})}
    />
  );
}
