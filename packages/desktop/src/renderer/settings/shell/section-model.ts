// 设置壳的分区模型（D-6x `ui-settings-general` 对应物的一半：**设置壳**）。
//
// 模块边界（D-6x 原则「一个能力一个包/模块、通过席位或 ctx 注入、不跨层 import」）：
//   本目录只放**壳**（分区导航 + 内容槽 + 分区声明契约），不碰 IPC / 不 import main / preload；
//   分区内容由宿主（settings/shell 的使用者）或能力模块经 `SettingsSectionContribution` 注入。
//
// 与 slots 注册表（renderer/slots）的分工：slots 是**帧级席位**（sidebar / main / rightbar / overlay）；
// 本模型是**设置弹窗内部**的分区槽（key 只在设置弹窗内唯一），是两套不同层级的注册面，不要混淆。
import type { ComponentType } from 'react';

/** 分区内容组件收到的宿主事实（D-6x：能力模块只消费注入的 props，不自己翻全局单例） */
export interface SettingsSectionProps {
  /** 该分区当前是否可见（壳按需挂载：只有当前分区的 render 会被调用） */
  readonly active: boolean;
}

/** 分区声明：壳按 order（升序，缺省 100）+ 注册顺序排列导航 */
export interface SettingsSectionDefinition {
  /** 分区 id（弹窗内唯一；点分命名如 'general' / 'models'） */
  readonly id: string;
  /** 中文标签（导航主文案） */
  readonly label: string;
  /** 英文标签（导航副文案，与既有导航栏样式一致） */
  readonly en: string;
  /** 归属能力包名（D-02 口径：便于审查「哪份内容属于哪个能力」） */
  readonly owner: string;
  /** 排序（升序；缺省 100） */
  readonly order?: number;
  /** 渲染分区正文（只有当前分区会被调用 → 未激活分区不挂载、不产生副作用） */
  readonly render: () => React.ReactNode;
}

/** 分区贡献（能力模块注入的一种方式）：组件 + 静态 props，折成一条分区声明 */
export interface SettingsSectionContribution extends Omit<SettingsSectionDefinition, 'render'> {
  readonly component: ComponentType<SettingsSectionProps>;
  readonly props?: Omit<SettingsSectionProps, 'active'>;
}

/** 默认排序位（未声明 order 的分区） */
export const DEFAULT_SECTION_ORDER = 100;

/** 分区声明 → 导航排序键（order 升序，缺省 100） */
export function sectionOrder(section: Pick<SettingsSectionDefinition, 'order'>): number {
  return section.order ?? DEFAULT_SECTION_ORDER;
}

/** 按 order 升序排定分区（同 order 保持传入顺序 = 注册顺序；不修改入参） */
export function sortSections<T extends Pick<SettingsSectionDefinition, 'order'>>(sections: readonly T[]): readonly T[] {
  return [...sections].sort((a, b) => sectionOrder(a) - sectionOrder(b));
}
