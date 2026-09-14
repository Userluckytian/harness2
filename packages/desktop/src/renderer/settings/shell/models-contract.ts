// 模型配置分区的**宿主契约**（B 棒 `ui-settings-models` / D-50～D-59、D-85 的接入面）。
//
// 为什么单列一个文件：B 棒（`renderer/settings/models/**`）与本壳并行开发，
// 双方只约定**组件名 + props 名**，互不 import 对方实现：
//   B 侧导出：`export function ModelsSettings(props: ModelsSettingsProps): React.ReactNode`
//   本壳侧：把 `ModelsSettings` 折成一条分区贡献注册进 `MODELS_SECTION_ID`（见 contributions.tsx）。
// B 的文件尚未落地时，壳不 import 不存在的路径（否则编译失败），只在分区正文里**显式占位**。
import type { SettingsConfigShape } from '../../../shared/protocol.js';
import type { SettingsSectionProps } from './section-model.js';

/** 归属包名（D-6x 包清单里的 `ui-settings-models`） */
export const MODELS_SETTINGS_OWNER = 'ui-settings-models';

/**
 * 宿主可注入给模型页的数据面（全部可选）。
 * B 棒已在 `shared/protocol.ts` 落 `ModelsSettingsApi`（`settingsGetModels` / `settingsUpdateModels` /
 * `settingsDeleteProvider` / `settingsWriteChannelKey` / `settingsGetCredentialStatus` /
 * `settingsDiscoverModels` / `onSettingsEvent`），因此模型页**可以自己取数**；
 * 下面两项只是宿主多给一条既有 config.json 通道（B 不需要时可以完全忽略）。
 */
export interface ModelsSettingsHostProps {
  /** `settings:getConfig` 的形状（既有 B2 通道；只读展示用） */
  readonly config?: SettingsConfigShape;
  /** `settings:updateConfig` 的白名单 patch 深合并（失败抛错） */
  readonly onSaveConfig?: (patch: Record<string, unknown>) => Promise<void>;
}

/**
 * B 棒 `ModelsSettings` 的完整 props 契约。
 * `active` 由壳给出（只有当前分区会被挂载 → 恒为 true，保留字段是为了空态/懒加载语义）。
 */
export type ModelsSettingsProps = SettingsSectionProps & ModelsSettingsHostProps;
