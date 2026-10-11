// 模型配置页（P6-B，D-50～D-59）对外入口：设置壳（C 棒）从这里装配。
// 本模块自包含：只经 window.harness2 的 settings:* 通道读写，不碰文件系统、不持有明文密钥。
import { createElement } from 'react';
import type { ReactNode } from 'react';
import {
  MODELS_SECTION_ID,
  MODELS_SETTINGS_OWNER,
  registerSettingsSection,
  type SettingsSectionProps,
} from '../shell/index.js';
import { ModelsSettings } from './ModelsSettings.js';

export { ModelsSettings, type ModelsSettingsProps } from './ModelsSettings.js';
export { ProviderCard, StatusDot, type ProviderCardProps } from './ProviderCard.js';
export { ModelDiscoverSelector, type ModelDiscoverSelectorProps } from './ModelDiscoverSelector.js';
export { ConfirmDeleteDialog, type ConfirmDeleteDialogProps } from './ConfirmDeleteDialog.js';
export { FirstRunDialogs, nextFirstRunStep, type FirstRunDialogsProps } from './FirstRunDialogs.js';
export {
  MODELS_DECLARATION_VERSION,
  credentialPresentation,
  deriveApiKeyRef,
  documentProviderIds,
  emptyModelRow,
  firstRunStep,
  getModelsApi,
  isUnconfiguredProvider,
  layerLabel,
  modelsApiReady,
  newProviderDraft,
  providersNeedingCredential,
  rowToInput,
  shouldAutoExpand,
} from './model-document.js';
export {
  deselectAll,
  filterDiscovery,
  mergeDiscoveredModels,
  newSelectedCount,
  selectAllVisible,
  toggleDiscoverySelection,
} from './discover.js';
export { issueFor, validateApiKey, validateProviderDraft, type FieldIssue } from './validate.js';

/**
 * 分区正文适配器：壳给的 props 只有 `{ active }`（本页自持数据面，不消费宿主 config props）。
 * `active=false` 时壳本就不会调用 render —— 这里仍如实返回 null，不制造「挂载了却假装在渲染」的假象。
 */
function ModelsSection({ active }: SettingsSectionProps): ReactNode {
  return active ? createElement(ModelsSettings) : null;
}

/**
 * 装配入口（D-50～D-59「接线进设置壳」）：把模型配置页注册为设置壳的 `models` 分区正文。
 * 方向正确：**能力 → 壳的注册面**（壳不 import 本模块），同 id 注册即接管内建过渡面板。
 * 应用启动时调用一次（`main.tsx`）；返回幂等 disposer（测试 / 重挂载回收）。
 */
export function registerModelsSettingsSection(): () => void {
  return registerSettingsSection({
    id: MODELS_SECTION_ID,
    label: '模型配置',
    en: 'Models',
    owner: MODELS_SETTINGS_OWNER,
    order: 10,
    component: ModelsSection,
  });
}
