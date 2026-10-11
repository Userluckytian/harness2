// 设置页（桌面壳端口适配，Z7）：**唯一实现已下沉** `@harness2/ui-shared/renderer/settings`；
// 本文件只把 `window.harness2` 的 settings:* IPC 包成 `SettingsPorts` 注入共享设置页，并接桌面
// 主题 store（D-15 立即呈现）+ 界面字号运行时（例外 #2）。不在此写任何设置 UI。
import { useMemo, useState } from 'react';
import type { SettingsTheme } from '../../shared/protocol.js';
import { SettingsPage as SharedSettingsPage, type SettingsPorts } from '@harness2/ui-shared/renderer/settings/index.js';
import { useShellTheme } from '../layout/shell-theme.js';
import { applyUiFontSize, currentUiFontSize } from '../ui-font-size.js';

export interface SettingsPageProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 主题选择（宿主：立即呈现 D-15 四要素；持久化由共享页经 setPreferences 完成） */
  readonly onThemeChange: (t: SettingsTheme) => void;
  /** 本次打开要落到的分区 id（Z3-04 直达；undefined = 壳默认分区） */
  readonly defaultSectionId?: string;
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
      {...(defaultSectionId !== undefined ? { defaultSectionId } : {})}
    />
  );
}
