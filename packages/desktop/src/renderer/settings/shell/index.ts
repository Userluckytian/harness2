// settings/shell 导出面（设置壳：分区模型 + 分区导航/内容槽 + 能力模块注入面）。
export { SettingsShell, SettingsShellError, resolveSections, type SettingsShellProps } from './SettingsShell.js';
export { SettingsSectionBlock, type SettingsSectionBlockProps } from './section-block.js';
export {
  DEFAULT_SECTION_ORDER,
  sectionOrder,
  sortSections,
  type SettingsSectionContribution,
  type SettingsSectionDefinition,
  type SettingsSectionProps,
} from './section-model.js';
export {
  MODELS_SECTION_ID,
  findSettingsSection,
  registerSettingsSection,
  resetSettingsSections,
  sectionFromContribution,
  settingsSectionContributions,
} from './contributions.js';
export { MODELS_SETTINGS_OWNER, type ModelsSettingsHostProps, type ModelsSettingsProps } from './models-contract.js';
