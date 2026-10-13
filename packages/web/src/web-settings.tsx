// web 设置覆层（Z7 → Z9-6b）：把共享设置页（`@harness2/ui-shared/renderer/settings`）接到 web 壳。
//
// 端口实现（**只接 web 真能**做到的部分；没有的如实不提供，由共享设置页降级/不进导航）：
//   * 外观（主题/界面字号）—— **真实生效**：走共享运行时（ui-shared renderer/theme），
//     持久化经 D-14 例外 #1/#2（浏览器存储键 harness2-theme / harness2-font-size，与 theme-boot.js 同源）；
//   * 常规偏好（notifyDetails 等）—— 无落盘通道，仅内存（web 本地偏好，不接 serve）；
//   * 配置读写 / auth 掩码 / doctor / 技能 / 崩溃报告 —— 经 `serve-client` 打到 Z9-6a 的
//     `GET|PUT /api/settings/config`、`GET /api/settings/{auth,doctor,skills,crash-reports}`；
//   * `updateAuth` —— **不提供**（网页端写凭据未授权，serve 侧 PUT /api/settings/auth = 405）；缺失即如实降级；
//   * `modelsApi` —— serve 无模型配置路由 → 不提供（models 分区不进导航）。
//
// 分区白名单（`sectionAllowList`）按「**端口满足且数据面齐备**」原则逐分区判定，只开数据可如实渲染者：
//   进：general（本地偏好）、appearance（主题/字号）、approval（cfg.approval，真实）、
//       memory / browser / subagent（cfg.* 真实读取，且带「保存」按钮经 updateConfig 写回）、
//       plugins / mcp / hooks（cfg.plugins / cfg.mcpServers / cfg.hooks 真实只读展示）、
//       gateway（cfg.gateways 真实读取 + auth 掩码；策略可写、凭据只读如实降级）、
//       shortcuts / cron / sessions / about（静态事实，无数据面依赖）、skill（getSkills 端点）、
//       diagnostics（doctor + crash 端点）。
//      （Z9-6c：core `GET /api/settings/config` 已改为返回完整 config 形状 —— memory/browser/plugins/
//       mcpServers/subagent/hooks/gateways 段都可如实读取，故上述分区放开；此前因「读载荷过窄 →
//       保存会用 schema 缺省覆盖用户真实配置」而被排除的顾虑已消除。）
//   不进（并在报告写明原因）：
//     - models：serve 无模型配置路由（不提供 modelsApi）→ 无法如实读写模型文档，保持不进。
import { useMemo, useState, type ReactNode } from 'react';
import { SettingsPage, type SettingsPorts } from '@harness2/ui-shared/renderer/settings/index.js';
import {
  applyUiFontSize,
  currentUiFontSize,
  getShellTheme,
  setShellTheme,
  useShellTheme,
} from '@harness2/ui-shared/renderer/theme/index.js';
import type {
  SettingsAuthMaskedShape,
  SettingsConfigShape,
  SettingsCrashReportShape,
  SettingsDoctorReportShape,
  SettingsPreferencesShape,
  SettingsSkillsShape,
  SettingsTheme,
} from '@harness2/ui-shared/shared/settings.js';
import type { ServeClient, ServeConfigUpdateResult } from './serve-client.js';
import { useWebShell } from './web-shell-context.js';

/**
 * web 导航保留的分区（**端口满足且数据面齐备**；判定依据见模块头注释）。
 * 顺序**必须**与 `SETTINGS_SECTION_META`（组 × 组内 order）一致（装配层按该顺序过滤渲染）。
 * 未列入者不进导航（隐藏，而非摆禁用假控件）——当前仅 `models`（serve 无模型配置路由）。
 */
export const WEB_SETTINGS_SECTIONS: readonly string[] = [
  'general',
  'appearance',
  'browser',
  'approval',
  'shortcuts',
  'memory',
  'subagent',
  'plugins',
  'mcp',
  'skill',
  'cron',
  'hooks',
  'gateway',
  'sessions',
  'diagnostics',
  'about',
];

/** web 的网关启动指引（web 无网关配置数据面，只给可行动命令） */
export const WEB_GATEWAY_GUIDANCE =
  'web 壳不读写网关配置/凭据：请在桌面端「设置 → 网关 / IM」或命令行配置 config.gateways 与 auth.json 后，运行 harness2 gateway --platform qq,feishu。';

/** web 偏好（theme 走浏览器存储例外 #1；其余仅内存、无落盘通道） */
function webPreferences(theme: SettingsTheme): SettingsPreferencesShape {
  return { theme, defaultPaneCount: 1, showWelcome: false, notifyDetails: 'minimal' };
}

/** web 设置**数据面端口**（由 serve 客户端提供；与 `SettingsPorts` 的数据成员同形） */
export interface WebSettingsDataPorts {
  getConfig: () => Promise<SettingsConfigShape>;
  updateConfig: (patch: Record<string, unknown>) => Promise<ServeConfigUpdateResult>;
  getAuthMasked: () => Promise<SettingsAuthMaskedShape>;
  getDoctorReport: () => Promise<SettingsDoctorReportShape>;
  getSkills: () => Promise<SettingsSkillsShape>;
  getCrashReports: () => Promise<SettingsCrashReportShape[]>;
}

/**
 * 用 serve 客户端构造 web 设置数据端口（薄适配；各端点在 `serve-client` 里已适配成共享形状）。
 * `getAuthMasked` 一并提供（Z9-6b 交付要求）；Z9-6c 起 gateway 分区已进导航并消费它（凭据只读掩码）。
 */
export function createWebSettingsDataPorts(
  client: Pick<
    ServeClient,
    | 'getSettingsConfig'
    | 'updateSettingsConfig'
    | 'getSettingsAuthMasked'
    | 'getSettingsDoctor'
    | 'getSettingsSkills'
    | 'getSettingsCrashReports'
  >,
): WebSettingsDataPorts {
  return {
    getConfig: () => client.getSettingsConfig(),
    updateConfig: (patch) => client.updateSettingsConfig(patch),
    getAuthMasked: () => client.getSettingsAuthMasked(),
    getDoctorReport: () => client.getSettingsDoctor(),
    getSkills: () => client.getSettingsSkills(),
    getCrashReports: () => client.getSettingsCrashReports(),
  };
}

/** 设置覆层席位内容（web）：共享设置页 + web 端口面 */
export function WebSettingsOverlay(): ReactNode {
  const { settingsOpen, onCloseSettings, settingsDataPorts } = useWebShell();
  const theme = useShellTheme();
  const [uiFontSize, setUiFontSize] = useState<number>(() => currentUiFontSize());

  const ports: SettingsPorts = useMemo<SettingsPorts>(
    () => ({
      // 数据面（serve HTTP）：未注入（如无 serve 客户端）→ 对应分区如实降级，不摆假数据。
      ...(settingsDataPorts ?? {}),
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
    [settingsDataPorts, theme, uiFontSize],
  );

  return <SettingsPage open={settingsOpen} onClose={onCloseSettings} ports={ports} />;
}
