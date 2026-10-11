// web 设置覆层（Z7）：把共享设置页（`@harness2/ui-shared/renderer/settings`）接到 web 壳。
//
// 端口实现（只接 web **真能**做到的部分；没有的如实不提供，由共享设置页降级为「此壳未提供」）：
//   * 外观（主题/界面字号）—— **真实生效**：走共享运行时（ui-shared renderer/theme），
//     持久化经 D-14 例外 #1/#2（浏览器存储键 harness2-theme / harness2-font-size，与 theme-boot.js 同源）；
//   * 常规偏好（notifyDetails 等）—— 无落盘通道，仅内存；对应分区不进 web 导航（sectionAllowList）；
//   * 配置读写（getConfig/updateConfig/getAuthMasked/updateAuth）—— serve 的 GET /api/config 只回
//     **另一形状**的脱敏报告（providers/roles/approval），不满足 SettingsConfigShape，且无写入端点
//     → **不提供**（网关/IM 分区如实显示「本壳无数据面 + 启动指引」，不摆假条目）；
//   * doctor/崩溃报告/技能/模型配置 —— 均无 serve 端点 → 不提供。
import { useMemo, useState, type ReactNode } from 'react';
import { SettingsPage, type SettingsPorts } from '@harness2/ui-shared/renderer/settings/index.js';
import {
  applyUiFontSize,
  currentUiFontSize,
  getShellTheme,
  setShellTheme,
  useShellTheme,
} from '@harness2/ui-shared/renderer/theme/index.js';
import type { SettingsPreferencesShape, SettingsTheme } from '@harness2/ui-shared/shared/settings.js';
import { useWebShell } from './web-shell-context.js';

/**
 * web 导航保留的分区（**有真数据面**者）：外观（主题/字号真生效）+ 网关/IM（如实只读指引）。
 * 其余分区不进导航（隐藏而非摆禁用假控件）；差异登记见模块头注释与 Z7 报告。
 */
export const WEB_SETTINGS_SECTIONS: readonly string[] = ['appearance', 'gateway'];

/** web 的网关启动指引（web 无网关数据面，只给可行动命令） */
export const WEB_GATEWAY_GUIDANCE =
  'web 壳不读写网关配置/凭据：请在桌面端「设置 → 网关 / IM」或命令行配置 config.gateways 与 auth.json 后，运行 harness2 gateway --platform qq,feishu。';

/** web 偏好（theme 走浏览器存储例外 #1；其余仅内存、无落盘通道） */
function webPreferences(theme: SettingsTheme): SettingsPreferencesShape {
  return { theme, defaultPaneCount: 1, showWelcome: false, notifyDetails: 'minimal' };
}

/** 设置覆层席位内容（web）：共享设置页 + web 端口面 */
export function WebSettingsOverlay(): ReactNode {
  const { settingsOpen, onCloseSettings } = useWebShell();
  const theme = useShellTheme();
  const [uiFontSize, setUiFontSize] = useState<number>(() => currentUiFontSize());

  const ports: SettingsPorts = useMemo<SettingsPorts>(
    () => ({
      // 主题偏好：选择即经共享主题运行时呈现（D-15 四要素）+ 镜像浏览器存储（例外 #1）。
      getPreferences: async () => webPreferences(getShellTheme()),
      setPreferences: async (p) => {
        if (p.theme !== getShellTheme()) setShellTheme(p.theme);
        return p;
      },
      theme,
      onSelectTheme: (t) => setShellTheme(t),
      uiFontSize,
      onUiFontSizeCommit: (px) => setUiFontSize(applyUiFontSize(px)),
      versionLabel: 'web',
      sectionAllowList: WEB_SETTINGS_SECTIONS,
      gatewayGuidance: WEB_GATEWAY_GUIDANCE,
    }),
    [theme, uiFontSize],
  );

  return <SettingsPage open={settingsOpen} onClose={onCloseSettings} ports={ports} />;
}
