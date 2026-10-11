// 设置分区配置表（Z-89 思路：**可见性与归属数据驱动**）。
//
// 只列**有真数据**的分区 —— ZCode 有而我们无对应数据的分区（hooks / skills / computerUse /
// automations(Beta) / workspaceFileSearch / usage / 独立 mcp / 独立 commands）一律**不进表**
// （列了就是假入口）。与 ZCode 16 分区的对照差异在 test/settings/settings-page-config.test.ts
// 固化为断言，改动归属时先改测试再改表。
//
// 三组（Z-89）：basics = 基础设置；agentCapabilities = Agent 能力；dataAndStats = 数据与统计。
// order 只需**组内升序**（导航先按组、组内按 order）；数值段位给组间留出空隙便于插行。
import type { ComponentType } from 'react';
import { MODELS_SECTION_ID, MODELS_SETTINGS_OWNER, type SettingsSectionGroupId } from './shell/index.js';
import type { SettingsIconProps } from './shell/icons.js';
import {
  IconActivity,
  IconAlarmClock,
  IconBlocks,
  IconBot,
  IconBrain,
  IconDatabase,
  IconGlobe2,
  IconInfo,
  IconKeyRound,
  IconKeyboard,
  IconPackage,
  IconPalette,
  IconSettings2,
  IconShieldCheck,
} from './shell/icons.js';

/** 一条分区元数据（render 由宿主装配层补 —— 本表是**纯数据**，可独立测试） */
export interface SettingsSectionMeta {
  /** 分区 id（settings 页内唯一；models 复用 MODELS_SECTION_ID，Z3-04 直达依赖它） */
  readonly id: string;
  /** 中文标签（导航主文案 + 页面 h2） */
  readonly label: string;
  /** 英文标签（导航副文案） */
  readonly en: string;
  /** 归属能力包名（D-02 口径） */
  readonly owner: string;
  /** 分区分组（Z-89） */
  readonly group: SettingsSectionGroupId;
  /** 组内排序（升序） */
  readonly order: number;
  /** 导航图标（窄屏导航只剩图标） */
  readonly icon: ComponentType<SettingsIconProps>;
}

/**
 * 全部分区（导航显示顺序 = 组顺序 × 组内 order）。
 * 差异登记（vs Z-89 的 ZCode 16 分区）：
 *   - basics 里 `approval`（审批与安全）是我们有真数据（config.approval）而 ZCode 无的分区，归 basics；
 *   - `credentials`（IM 网关凭据）保留独立分区（auth.json 真数据），归 agentCapabilities；
 *   - `plugins` 合并承载 MCP 服务器（同一份 config.json 数据面，Z2 起即合一）—— ZCode 是
 *     plugin / mcp 两个分区，我们不拆（拆了要复制 PluginsSection 的正文，内容组件不改内部实现）；
 *   - `shortcuts` 归 basics（对齐 ZCode 的归属）；sessions / diagnostics / about 归 dataAndStats
 *     （本地数据 / 体检报告 / 版本事实，无「用量统计」数据面，不设 usage 假入口）；
 *   - about 保留分区（内核/数据/更新是真实事实），版本号同时进左栏页脚（ZCode 页脚是账号菜单）。
 */
export const SETTINGS_SECTION_META: readonly SettingsSectionMeta[] = [
  // —— basics（基础设置）——
  {
    id: 'general',
    label: '常规',
    en: 'General',
    owner: 'ui-settings-general',
    group: 'basics',
    order: 0,
    icon: IconSettings2,
  },
  {
    id: 'appearance',
    label: '外观',
    en: 'Appearance',
    owner: 'ui-settings-appearance',
    group: 'basics',
    order: 10,
    icon: IconPalette,
  },
  {
    id: MODELS_SECTION_ID,
    label: '模型配置',
    en: 'Models',
    owner: MODELS_SETTINGS_OWNER,
    group: 'basics',
    order: 20,
    icon: IconPackage,
  },
  {
    id: 'browser',
    label: '浏览器工具',
    en: 'Browser',
    owner: 'ui-settings',
    group: 'basics',
    order: 30,
    icon: IconGlobe2,
  },
  {
    id: 'approval',
    label: '审批与安全',
    en: 'Approval & Security',
    owner: 'ui-settings',
    group: 'basics',
    order: 40,
    icon: IconShieldCheck,
  },
  {
    id: 'shortcuts',
    label: '快捷键',
    en: 'Keyboard Shortcuts',
    owner: 'ui-settings',
    group: 'basics',
    order: 50,
    icon: IconKeyboard,
  },
  // —— agentCapabilities（Agent 能力）——
  {
    id: 'memory',
    label: '记忆',
    en: 'Memory',
    owner: 'ui-settings',
    group: 'agentCapabilities',
    order: 100,
    icon: IconBrain,
  },
  {
    id: 'subagent',
    label: '子代理',
    en: 'Subagent',
    owner: 'ui-settings',
    group: 'agentCapabilities',
    order: 110,
    icon: IconBot,
  },
  {
    id: 'plugins',
    label: '插件与集成',
    en: 'Plugins & MCP',
    owner: 'ui-settings',
    group: 'agentCapabilities',
    order: 120,
    icon: IconBlocks,
  },
  {
    id: 'cron',
    label: '定时任务',
    en: 'Cron',
    owner: 'ui-settings',
    group: 'agentCapabilities',
    order: 130,
    icon: IconAlarmClock,
  },
  {
    id: 'credentials',
    label: '凭据',
    en: 'Credentials',
    owner: 'ui-settings',
    group: 'agentCapabilities',
    order: 140,
    icon: IconKeyRound,
  },
  // —— dataAndStats（数据与统计）——
  {
    id: 'sessions',
    label: '会话与数据',
    en: 'Sessions & Data',
    owner: 'ui-settings',
    group: 'dataAndStats',
    order: 200,
    icon: IconDatabase,
  },
  {
    id: 'diagnostics',
    label: '诊断',
    en: 'Diagnostics',
    owner: 'ui-settings',
    group: 'dataAndStats',
    order: 210,
    icon: IconActivity,
  },
  { id: 'about', label: '关于', en: 'About', owner: 'ui-settings', group: 'dataAndStats', order: 220, icon: IconInfo },
];
