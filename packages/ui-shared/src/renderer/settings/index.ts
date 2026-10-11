// 设置页共享入口（Z7 自桌面下沉）：唯一一份设置实现（桌面 / web 经 SettingsPorts 注入数据面）。
export { SettingsPage, type SettingsPageProps } from './SettingsPage.js';
export { SettingsPortsProvider, useOptionalSettingsPorts, useSettingsPorts, type SettingsPorts } from './ports.js';
export { SETTINGS_SECTION_META, type SettingsSectionMeta } from './page-config.js';
export * from './shell/index.js';
export {
  DEFAULT_GATEWAY_GUIDANCE,
  GATEWAY_CHANNELS,
  GATEWAY_CHANNEL_LABEL,
  GATEWAY_POLICIES,
  GatewaySection,
  GatewayUnavailable,
  isGatewayConfigured,
  type GatewayChannel,
  type GatewaySectionProps,
} from './gateway/GatewaySection.js';
