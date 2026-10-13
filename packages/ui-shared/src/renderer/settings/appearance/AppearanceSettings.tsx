// 外观设置（Z-90 / Z10-7）：
//   界面主题 —— Select（跟随系统/深色/浅色，Monitor/Moon/Sun 图标）；选择经宿主 onSelectTheme
//               落 P4 主题呈现器/store（D-15 四要素即时生效），真源在壳主题 store（受控组件）。
//   界面字号 —— FontSizeInput（12–20，默认 14）；提交经宿主 onUiFontSizeCommit →
//               applyUiFontSize（写根 --ui-font-size + 浏览器存储键例外 #2 持久化）。
//   代码设置卡（Z10-7，refs-zcode.md:357）—— 浅/深代码主题 Select、显示行号开关、长行自动换行开关、
//               代码字号 FontSizeInput（12–20）。改动经 onCodePreferencesChange 落共享运行时 store
//               （查看器/预览卡**即时消费**）+ 各壳偏好通道持久化（桌面 desktop-preferences.json）。
//   代码预览卡 ×2（Z10-7，refs-zcode.md:358）—— ThemePreviewCard：固定 TS 样例、标题/主题名/徽标、
//               浅色固定背景 #f8f8f8、深色 #161616，两卡 `grid gap-4 sm:grid-cols-2`。
import type { CodeThemeId, SettingsTheme } from '../../../shared/settings.js';
import { resolvedTheme, themeLabel } from '../../theme/theme.js';
import { FontSizeInput } from '../../../components/ui/font-size-input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select.js';
import { Switch } from '../../../components/ui/switch.js';
import {
  CODE_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  clampCodeFontSize,
  codeThemeOptionsOf,
  type CodePreferences,
} from '../../code/index.js';
import { IconMonitor, IconMoon, IconSun, type SettingsIconProps } from '../shell/icons.js';
import { SettingsSectionBlock } from '../shell/section-block.js';
import { CODE_PREVIEW_DARK_BG, CODE_PREVIEW_LIGHT_BG, ThemePreviewCard } from './ThemePreviewCard.js';

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
  /**
   * 当前代码偏好（宿主注入：共享运行时 store 的快照）。
   * 由 SettingsPage 订阅 `codePreferencesStore` 注入，改一处即被查看器/预览卡消费。
   */
  readonly codePreferences: CodePreferences;
  /** 提交代码偏好补丁（宿主：写运行时 store + 经偏好通道持久化） */
  readonly onCodePreferencesChange: (patch: Partial<CodePreferences>) => void;
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
  codePreferences,
  onCodePreferencesChange,
  loaded,
  note,
}: AppearanceSettingsProps): React.ReactNode {
  // 明暗归属：决定「当前生效」徽标落在浅色还是深色预览卡（另一张显示其明暗名）
  const dark = resolvedTheme(theme) === 'zai-dark';
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
      <SettingsSectionBlock
        title="代码设置"
        desc="代码查看器与下方预览卡使用的高亮主题、行号、换行与字号；改动即时生效并写入偏好。"
      >
        {!loaded ? (
          <p className="settings-desc">加载中…</p>
        ) : (
          <>
            <div className="settings-row" data-settings-group="code-theme-light">
              <span className="settings-desc">浅色代码主题</span>
              <Select
                value={codePreferences.themeLight}
                onValueChange={(v) => onCodePreferencesChange({ themeLight: v as CodeThemeId })}
              >
                <SelectTrigger className="w-56" data-settings-code-theme-light aria-label="浅色代码主题">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {codeThemeOptionsOf('light').map((o) => (
                    <SelectItem key={o.id} value={o.id} data-code-theme-choice={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="settings-row" data-settings-group="code-theme-dark">
              <span className="settings-desc">深色代码主题</span>
              <Select
                value={codePreferences.themeDark}
                onValueChange={(v) => onCodePreferencesChange({ themeDark: v as CodeThemeId })}
              >
                <SelectTrigger className="w-56" data-settings-code-theme-dark aria-label="深色代码主题">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {codeThemeOptionsOf('dark').map((o) => (
                    <SelectItem key={o.id} value={o.id} data-code-theme-choice={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="settings-row" data-settings-group="code-line-numbers">
              <span className="settings-desc">显示行号</span>
              <Switch
                checked={codePreferences.lineNumbers}
                onCheckedChange={(v) => onCodePreferencesChange({ lineNumbers: v })}
                aria-label="显示行号"
                data-settings-code-line-numbers
              />
            </div>
            <div className="settings-row" data-settings-group="code-word-wrap">
              <span className="settings-desc">长行自动换行</span>
              <Switch
                checked={codePreferences.wordWrap}
                onCheckedChange={(v) => onCodePreferencesChange({ wordWrap: v })}
                aria-label="长行自动换行"
                data-settings-code-word-wrap
              />
            </div>
            <div className="settings-row" data-settings-group="code-font-size">
              <span className="settings-desc">代码字号</span>
              <FontSizeInput
                value={codePreferences.fontSize}
                onCommit={(px) => onCodePreferencesChange({ fontSize: clampCodeFontSize(px) })}
                min={CODE_FONT_SIZE_MIN}
                max={CODE_FONT_SIZE_MAX}
                aria-label="代码字号"
              />
            </div>
          </>
        )}
      </SettingsSectionBlock>
      <SettingsSectionBlock
        title="代码预览"
        desc="浅色 / 深色代码主题的即时预览；「当前生效」标记跟随界面明暗实际使用的那一支。"
      >
        <div className="grid gap-4 sm:grid-cols-2" data-code-previews>
          <ThemePreviewCard
            title="浅色预览"
            kind="light"
            themeId={codePreferences.themeLight}
            badge={dark ? '浅色' : '当前生效'}
            background={CODE_PREVIEW_LIGHT_BG}
          />
          <ThemePreviewCard
            title="深色预览"
            kind="dark"
            themeId={codePreferences.themeDark}
            badge={dark ? '当前生效' : '深色'}
            background={CODE_PREVIEW_DARK_BG}
          />
        </div>
      </SettingsSectionBlock>
    </>
  );
}
