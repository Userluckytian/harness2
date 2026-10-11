// 设置域端口面（ports）：共享设置页与「壳」之间的唯一缝（Z7 下沉手法，同 renderer/ports.ts 口径）。
//
// 设计原则：共享包**只**定义端口与呈现，不 import electron / Node 内建 / 任何壳的桥；
// 每个壳注入自己的实现——
//   * desktop：`window.harness2`（preload contextBridge + 主进程 config/auth IPC），见
//     `packages/desktop/src/renderer/components/SettingsPage.tsx`（薄适配，只做端口实现）；
//   * web    ：`packages/web/src/serve-client.ts`（serve HTTP；本壳能做多少给多少）。
//
// 「可选」语义：端口里带 `?` 的成员属于**壳可选择提供**的能力。缺失时共享设置页必须如实降级
// （分区显示「此壳未提供该数据面」/ 不进导航），**绝不**伪造成功、绝不摆假入口（红线⑩）。
//
// 分区可见性：宿主可给 `sectionAllowList` 白名单（web 只保留有真数据面的分区）。缺失 = 全部。
import { createContext, useContext } from 'react';
import type {
  ModelsSettingsApi,
  SettingsAuthMaskedShape,
  SettingsConfigShape,
  SettingsCrashReportShape,
  SettingsDoctorReportShape,
  SettingsPreferencesShape,
  SettingsSkillsShape,
  SettingsTheme,
} from '../../shared/settings.js';

/** 设置页数据 / 能力端口面（宿主注入；缺失成员 = 如实降级） */
export interface SettingsPorts {
  // —— 数据读写（desktop = settings:* IPC；web = serve HTTP 如有 / 缺失即不提供） ——

  /** 读桌面偏好（theme/notifyDetails…）；缺失 = 常规分区显示不可用 */
  getPreferences?: () => Promise<SettingsPreferencesShape>;
  /** 写桌面偏好（全量对象；返回持久化后的结果） */
  setPreferences?: (preferences: SettingsPreferencesShape) => Promise<SettingsPreferencesShape>;
  /** 读 config.json 脱敏视图 */
  getConfig?: () => Promise<SettingsConfigShape>;
  /** 改 config.json（白名单字段深合并；密钥类字段由壳拒绝） */
  updateConfig?: (
    patch: Record<string, unknown>,
  ) => Promise<{ ok: boolean; config?: SettingsConfigShape; error?: string; warnings?: string[] }>;
  /** 读 auth.json 掩码视图（channel/gateway 只回掩码状态） */
  getAuthMasked?: () => Promise<SettingsAuthMaskedShape>;
  /** 写 auth.json gateway 凭据（仅 auth.json；渲染端不回显明文） */
  updateAuth?: (patch: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;

  // —— 诊断 / 技能 ——

  /** doctor 六项检查结果 */
  getDoctorReport?: () => Promise<SettingsDoctorReportShape>;
  /** 崩溃报告列表 */
  getCrashReports?: () => Promise<SettingsCrashReportShape[]>;
  /** 技能列表（两级扫描；缺失 = 技能分区显示不可用） */
  getSkills?: () => Promise<SettingsSkillsShape>;

  // —— 模型配置通道面（存在 = models 分区可用；缺失 = 分区显示「此壳未提供模型配置通道」） ——

  modelsApi?: Partial<ModelsSettingsApi>;

  // —— 外观（宿主注入；缺失 = 外观分区不进导航） ——

  theme?: SettingsTheme;
  onSelectTheme?: (theme: SettingsTheme) => void;
  uiFontSize?: number;
  onUiFontSizeCommit?: (px: number) => void;

  // —— 展示事实 ——

  /** 左栏页脚版本号（缺省 'v1.0.0'） */
  versionLabel?: string;
  /**
   * 分区白名单（缺失 = 全部；web 用于只保留有真数据面的分区 —— 隐藏而非摆禁用假控件）。
   * 与 page-config 的 id 对应。
   */
  sectionAllowList?: readonly string[];
  /** 网关/IM 空态的可行动启动指引（宿主注入；缺省给通用 CLI 指引） */
  gatewayGuidance?: string;
}

const SettingsPortsContext = createContext<SettingsPorts | null>(null);

export const SettingsPortsProvider = SettingsPortsContext.Provider;

/** 取当前设置端口面（未在 SettingsPage 内使用 → 抛错，避免静默空端口） */
export function useSettingsPorts(): SettingsPorts {
  const value = useContext(SettingsPortsContext);
  if (value === null) throw new Error('useSettingsPorts 必须在 SettingsPage（SettingsPortsProvider）内使用');
  return value;
}

/**
 * 取当前设置端口面（可缺省）：分区组件单测可脱离 SettingsPage 直接渲染（传 `api` prop 等），
 * 未在 Provider 内时返回 null，由组件自行走「未提供」的如实降级分支（不抛错）。
 */
export function useOptionalSettingsPorts(): SettingsPorts | null {
  return useContext(SettingsPortsContext);
}
