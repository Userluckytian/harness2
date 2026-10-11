// 设置壳的分区模型（D-6x `ui-settings-general` 对应物的一半：**设置壳**）。
//
// 模块边界（D-6x 原则「一个能力一个包/模块、通过席位或 ctx 注入、不跨层 import」）：
//   本目录只放**壳**（分区导航 + 内容槽 + 分区声明契约），不碰 IPC / 不 import main / preload；
//   分区内容由宿主（settings/shell 的使用者）或能力模块经 `SettingsSectionContribution` 注入。
//
// 与 slots 注册表（renderer/slots）的分工：slots 是**帧级席位**（sidebar / main / rightbar / overlay）；
// 本模型是**设置页内部**的分区槽（key 只在设置页内唯一），是两套不同层级的注册面，不要混淆。
import type { ComponentType } from 'react';
import type { SettingsIconProps } from './icons.js';

/** 分区内容组件收到的宿主事实（D-6x：能力模块只消费注入的 props，不自己翻全局单例） */
export interface SettingsSectionProps {
  /** 该分区当前是否可见（壳按需挂载：只有当前分区的 render 会被调用） */
  readonly active: boolean;
}

/**
 * 分区分组 id（Z-89：可见性与归属**数据驱动**，三组）。
 * 只列**有真数据**的分区（ZCode 有而我们无数据的分区不进表 —— 列了就是假入口）。
 */
export type SettingsSectionGroupId = 'basics' | 'agentCapabilities' | 'dataAndStats';

/** 分区分组声明（顺序 = 导航组顺序；Z-89 三组） */
export interface SettingsSectionGroup {
  readonly id: SettingsSectionGroupId;
  /** 组标题（导航分组标题；窄屏 sr-only） */
  readonly label: string;
}

/** 分区分组表（Z-89：basics / agentCapabilities / dataAndStats；顺序即导航顺序） */
export const SETTINGS_SECTION_GROUPS: readonly SettingsSectionGroup[] = [
  { id: 'basics', label: '基础设置' },
  { id: 'agentCapabilities', label: 'Agent 能力' },
  { id: 'dataAndStats', label: '数据与统计' },
];

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
  /** 分区分组（Z-89 数据驱动；缺省进未分组尾组，仅测试用裸分区时出现） */
  readonly group?: SettingsSectionGroupId;
  /** 导航图标（窄屏导航只剩图标；缺省壳给兜底圆点） */
  readonly icon?: ComponentType<SettingsIconProps>;
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

/** 一个分区分组的导航视图（组标题 + 组内分区；组内已按 order 升序） */
export interface SettingsSectionGroupView<T = SettingsSectionDefinition> {
  /** 组声明；null = 未声明 group 的分区（兼容裸分区测试，渲染时不给组标题） */
  readonly group: SettingsSectionGroup | null;
  readonly sections: readonly T[];
}

/** 分区分组视图（Z-89 数据驱动）：组顺序 = SETTINGS_SECTION_GROUPS；组内按 order 升序；未分组垫底 */
export function groupSections<T extends Pick<SettingsSectionDefinition, 'group' | 'order'>>(
  sections: readonly T[],
): readonly SettingsSectionGroupView<T>[] {
  const sorted = sortSections(sections);
  const views: SettingsSectionGroupView<T>[] = [];
  for (const g of SETTINGS_SECTION_GROUPS) {
    const inGroup = sorted.filter((s) => s.group === g.id);
    if (inGroup.length > 0) views.push({ group: g, sections: inGroup });
  }
  const ungrouped = sorted.filter((s) => s.group === undefined);
  if (ungrouped.length > 0) views.push({ group: null, sections: ungrouped });
  return views;
}
