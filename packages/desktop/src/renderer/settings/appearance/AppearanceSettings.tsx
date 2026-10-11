// 外观设置（Z-90 裁剪到真实数据面）：
//   界面主题 —— Select（跟随系统/深色/浅色，Monitor/Moon/Sun 图标）；选择经宿主 onSelectTheme
//               落 P4 主题呈现器/store（D-15 四要素即时生效），真源在壳主题 store（受控组件）。
//   界面字号 —— FontSizeInput（12–20，默认 14）；提交经宿主 onUiFontSizeCommit →
//               applyUiFontSize（写根 --ui-font-size + 浏览器存储键例外 #2 持久化）。
//   代码设置卡（代码主题 10 选 / 行号 / 换行 / 代码字号）—— **整卡不渲染**（Z-90 如实省略）：
//               本仓没有代码高亮主题体系（无数据面，摆了就是假开关）；随代码预览能力（D-76）
//               落地时再按 Z-90 补齐，见 docs/refs/refs-zcode.md Z-90。
import type { SettingsTheme } from '../../../shared/protocol.js';
import { themeLabel } from '../../theme.js';
import { FontSizeInput } from '@harness2/ui-shared/components/ui/font-size-input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@harness2/ui-shared/components/ui/select.js';
import { IconMonitor, IconMoon, IconSun, type SettingsIconProps } from '../shell/icons.js';
import { SettingsSectionBlock } from '../shell/section-block.js';

/** 主题可选项（顺序 = Z-90 选项顺序：系统 → 深色 → 浅色；与命令面板同源 themeLabel） */
export const THEME_CHOICES: readonly SettingsTheme[] = ['system', 'zai-dark', 'zai-light'];

/** 界面字号范围（Z-90：12–20，默认 14；与 ui-font-size.ts 同值） */
export const UI_FONT_SIZE_MIN = 12;
export const UI_FONT_SIZE_MAX = 20;

/** 主题选项的图标（Z-90：system=Monitor / dark=Moon / light=Sun） */
const THEME_ICONS: Record<SettingsTheme, React.ComponentType<SettingsIconProps>> = {
  system: IconMonitor,
  'zai-dark': IconMoon,
  'zai-light': IconSun,
};

export interface AppearanceSettingsProps {
  /** 当前主题（宿主注入：来自壳主题 store，主题的真相不在本模块） */
  readonly theme: SettingsTheme;
  /** 选择主题（宿主负责落到 P4 主题 store + 持久化；本模块只报选择） */
  readonly onSelectTheme: (theme: SettingsTheme) => void;
  /** 当前界面字号（宿主注入：ui-font-size 运行时的真相） */
  readonly uiFontSize: number;
  /** 提交界面字号（宿主负责写根变量 + 持久化；本模块只报提交值，已钳制 12–20） */
  readonly onUiFontSizeCommit: (px: number) => void;
  /** 偏好是否已载入（未载入时不渲染可点控件，避免「点了没反应」的假开关） */
  readonly loaded: boolean;
  /** 可选的宿主反馈文案（主题偏好保存失败等如实显示在动作发生的分区） */
  readonly note?: string | null;
}

export function AppearanceSettings({
  theme,
  onSelectTheme,
  uiFontSize,
  onUiFontSizeCommit,
  loaded,
  note,
}: AppearanceSettingsProps): React.ReactNode {
  return (
    <>
      <SettingsSectionBlock title="界面主题" desc="选择浅色、深色或跟随系统主题，选择即生效。">
        {!loaded ? (
          <p className="settings-desc">加载中…</p>
        ) : (
          <div className="settings-row" data-settings-group="theme">
            <Select value={theme} onValueChange={(v) => onSelectTheme(v as SettingsTheme)}>
              <SelectTrigger className="w-56" data-settings-theme-select aria-label="界面主题">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEME_CHOICES.map((t) => {
                  const Icon = THEME_ICONS[t];
                  return (
                    <SelectItem key={t} value={t} data-theme-choice={t}>
                      <span className="flex items-center gap-2">
                        <Icon className="size-4 shrink-0" />
                        <span>{themeLabel(t)}</span>
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        )}
        {note !== undefined && note !== null && <p className="settings-feedback">{note}</p>}
      </SettingsSectionBlock>
      <SettingsSectionBlock
        title="界面字号"
        desc="12–20 px，默认 14；回车或失焦生效，Esc 还原输入。改动写界面基准字号，全部 text-ui-* 文本跟随。"
      >
        <FontSizeInput
          value={uiFontSize}
          onCommit={onUiFontSizeCommit}
          min={UI_FONT_SIZE_MIN}
          max={UI_FONT_SIZE_MAX}
          aria-label="界面字号"
        />
      </SettingsSectionBlock>
    </>
  );
}
