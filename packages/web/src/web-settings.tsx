// web 设置覆层（Z7 → Z9-6b → A2）：把共享设置页（`@harness2/ui-shared/renderer/settings`）接到 web 壳。
//
// 端口实现（**只接 web 真能**做到的部分；没有的如实不提供，由共享设置页降级/不进导航）：
//   * 外观（主题/界面字号）—— **真实生效**：走共享运行时（ui-shared renderer/theme），
//     持久化经 D-14 例外 #1/#2（浏览器存储键 harness2-theme / harness2-font-size，与 theme-boot.js 同源）；
//   * 常规偏好（notifyDetails 等）—— 无落盘通道，仅内存（web 本地偏好，不接 serve）；
//   * 配置读写 / auth 掩码 / doctor / 技能 / 崩溃报告 —— 经 `serve-client` 打到 Z9-6a 的
//     `GET|PUT /api/settings/config`、`GET /api/settings/{auth,doctor,skills,crash-reports}`；
//   * `updateAuth` —— A2 放开：`PUT /api/settings/auth`（仅 auth.json gateways 段；响应只回掩码级信息）；
//   * `modelsApi` —— A2 接通：serve `/api/settings/models*` 七法齐备 → 共享 `modelsApiReady` 为真，
//     models 分区进导航并如实读写/删/凭据/发现（密钥只回状态，永不回显明文）。
//
// 分区白名单（`sectionAllowList`）按「**端口满足且数据面齐备**」原则逐分区判定，只开数据可如实渲染者：
//   进：general（本地偏好）、appearance（主题/字号）、models（A2：serve 模型端点齐备）、
//       approval（cfg.approval，真实）、memory / browser / subagent（cfg.* 真实读取 + 「保存」经
//       updateConfig 写回）、plugins / mcp / hooks（cfg.* 真实只读展示）、gateway（cfg.gateways 真实读取
//       + auth 掩码；策略可写、凭据只读如实降级）、shortcuts / cron / sessions / about（静态事实）、
//       skill（getSkills 端点）、diagnostics（doctor + crash 端点）。
//      （Z9-6c：core `GET /api/settings/config` 已改为返回完整 config 形状 —— memory/browser/plugins/
//       mcpServers/subagent/hooks/gateways 段都可如实读取，故上述分区放开。）
//      （A2：core 补齐 auth 写 + 两条模型通道 [credential-status / ack-declaration]，models 分区七法齐备。）
//   不进：无（16 → 17 分区全部数据面齐备）。
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
  ModelsSettingsApi,
  SettingsAuthMaskedShape,
  SettingsConfigShape,
  SettingsCrashReportShape,
  SettingsDoctorReportShape,
  SettingsPreferencesShape,
  SettingsSkillsShape,
  SettingsTheme,
} from '@harness2/ui-shared/shared/settings.js';
import type { ServeAuthUpdateResult, ServeClient, ServeConfigUpdateResult } from './serve-client.js';
import { useWebShell } from './web-shell-context.js';

/**
 * web 导航保留的分区（**端口满足且数据面齐备**；判定依据见模块头注释）。
 * 顺序**必须**与 `SETTINGS_SECTION_META`（组 × 组内 order）一致（装配层按该顺序过滤渲染）。
 * A2 起 17 个分区全部进导航（models 已接通 serve 模型端点）。
 */
export const WEB_SETTINGS_SECTIONS: readonly string[] = [
  'general',
  'appearance',
  'models',
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
  /** A2：写 auth.json 的 gateways 段（口径同桌面 settings:updateAuth） */
  updateAuth: (patch: Record<string, unknown>) => Promise<ServeAuthUpdateResult>;
  getDoctorReport: () => Promise<SettingsDoctorReportShape>;
  getSkills: () => Promise<SettingsSkillsShape>;
  getCrashReports: () => Promise<SettingsCrashReportShape[]>;
  /** A2：模型配置通道面（七法齐备 → 共享 modelsApiReady 为真，models 分区可用） */
  modelsApi: Partial<ModelsSettingsApi>;
}

/**
 * 用 serve 客户端构造 web 设置数据端口（薄适配；各端点在 `serve-client` 里已适配成共享形状）。
 * A2：`modelsApi`（七法齐备）与 `updateAuth` 一并提供 —— 模型分区与网关凭据写入进导航并如实生效。
 */
export function createWebSettingsDataPorts(
  client: Pick<
    ServeClient,
    | 'getSettingsConfig'
    | 'updateSettingsConfig'
    | 'getSettingsAuthMasked'
    | 'updateSettingsAuth'
    | 'getSettingsDoctor'
    | 'getSettingsSkills'
    | 'getSettingsCrashReports'
    | 'settingsGetModels'
    | 'settingsUpdateModels'
    | 'settingsDeleteProvider'
    | 'settingsWriteChannelKey'
    | 'settingsGetCredentialStatus'
    | 'settingsAckModelsDeclaration'
    | 'settingsDiscoverModels'
  >,
): WebSettingsDataPorts {
  // 通道面对象：与桌面（modelsApi: window.harness2）同形 —— 只暴露 serve 真有路由的方法，
  // onSettingsEvent 无 serve 事件源故不提供（共享分区按可选成员如实降级，不订阅即不轮询）。
  const modelsApi: Partial<ModelsSettingsApi> = {
    settingsGetModels: () => client.settingsGetModels(),
    settingsUpdateModels: (opts) => client.settingsUpdateModels(opts),
    settingsDeleteProvider: (route, confirmRoute) => client.settingsDeleteProvider(route, confirmRoute),
    settingsWriteChannelKey: (route, key) => client.settingsWriteChannelKey(route, key),
    settingsGetCredentialStatus: (routes) => client.settingsGetCredentialStatus(routes),
    settingsAckModelsDeclaration: (version) => client.settingsAckModelsDeclaration(version),
    settingsDiscoverModels: (input) => client.settingsDiscoverModels(input),
  };
  return {
    getConfig: () => client.getSettingsConfig(),
    updateConfig: (patch) => client.updateSettingsConfig(patch),
    getAuthMasked: () => client.getSettingsAuthMasked(),
    updateAuth: (patch) => client.updateSettingsAuth(patch),
    getDoctorReport: () => client.getSettingsDoctor(),
    getSkills: () => client.getSettingsSkills(),
    getCrashReports: () => client.getSettingsCrashReports(),
    modelsApi,
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
