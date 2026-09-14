// 通用设置（D-6x `ui-settings-general` 对应物：通用设置区）。
//
// 只摆**真生效**的项（AGENTS.md：不摆没用的开关）：
//   主题   —— 选择即经宿主的 onSelectTheme 落到 P4 主题呈现器/store（D-15 四要素即时生效）；
//             主题是在**壳主题 store** 里，不在本模块里（本模块是受控组件，宿主注入）。
//   通知详情 —— 真实偏好字段（`desktop-preferences.json` 的 notifyDetails，App 启动时读取）；
//             如实标注「重启应用后生效」（运行中的通知文案不追改）。
// 已删除的项：启动默认分栏数 —— P4-C 三栅落地后分栏（PaneArea）已拆除，该项无消费方（假开关）。
import type { SettingsNotifyDetails, SettingsTheme } from '../../../shared/protocol.js';
import { themeLabel } from '../../theme.js';
import { SettingsSectionBlock } from '../shell/section-block.js';

/** 主题可选项（顺序 = 用户可见顺序；标签与命令面板同源 `themeLabel`，不另写一套文案） */
export const THEME_CHOICES: readonly SettingsTheme[] = ['warmPaper', 'dark', 'system'];

/** 通知详情可选项（与 shared/preferences 的 NOTIFY_DETAILS 同值域） */
export const NOTIFY_DETAILS_CHOICES: readonly SettingsNotifyDetails[] = ['minimal', 'full'];

/** 通知详情文案（与 App 的 composeNotifyContent 消费口径一致） */
export const NOTIFY_DETAILS_LABEL: Record<SettingsNotifyDetails, string> = {
  minimal: '精简（仅标题）',
  full: '完整（含回复摘要）',
};

export interface GeneralSettingsProps {
  /** 当前主题（宿主注入：来自壳主题 store，主题的真相不在本模块） */
  readonly theme: SettingsTheme;
  /** 选择主题（宿主负责落到 P4 主题 store + 持久化；本模块只报选择） */
  readonly onSelectTheme: (theme: SettingsTheme) => void;
  /** 当前通知详情级别（宿主注入：来自 preferences IPC） */
  readonly notifyDetails: SettingsNotifyDetails;
  /** 选择通知详情级别（宿主持久化） */
  readonly onSelectNotifyDetails: (details: SettingsNotifyDetails) => void;
  /** 偏好是否已载入（未载入时不渲染可点控件，避免「点了没反应」的假开关） */
  readonly loaded: boolean;
  /** 可选的宿主反馈文案（保存失败等如实显示） */
  readonly note?: string | null;
}

export function GeneralSettings({
  theme,
  onSelectTheme,
  notifyDetails,
  onSelectNotifyDetails,
  loaded,
  note,
}: GeneralSettingsProps): React.ReactNode {
  return (
    <>
      <SettingsSectionBlock title="主题" desc="选择即生效（写 html/body 呈现值与 data-theme，无需重启）">
        {!loaded ? (
          <p className="settings-desc">加载中…</p>
        ) : (
          <div className="settings-row" data-settings-group="theme">
            {THEME_CHOICES.map((t) => (
              <button
                key={t}
                type="button"
                className={`seg${theme === t ? ' seg-on' : ''}`}
                data-theme-choice={t}
                aria-pressed={theme === t}
                onClick={() => onSelectTheme(t)}
              >
                {themeLabel(t)}
              </button>
            ))}
          </div>
        )}
      </SettingsSectionBlock>
      <SettingsSectionBlock
        title="任务完成通知"
        desc="系统通知的详情级别；改动写 desktop-preferences.json，重启应用后生效（当前运行的通知文案不追改）"
      >
        {!loaded ? (
          <p className="settings-desc">加载中…</p>
        ) : (
          <div className="settings-row" data-settings-group="notify-details">
            {NOTIFY_DETAILS_CHOICES.map((d) => (
              <button
                key={d}
                type="button"
                className={`seg${notifyDetails === d ? ' seg-on' : ''}`}
                data-notify-choice={d}
                aria-pressed={notifyDetails === d}
                onClick={() => onSelectNotifyDetails(d)}
              >
                {NOTIFY_DETAILS_LABEL[d]}
              </button>
            ))}
          </div>
        )}
        {note !== undefined && note !== null && <p className="settings-feedback">{note}</p>}
      </SettingsSectionBlock>
      <SettingsSectionBlock title="发送快捷键" desc="只读：键位由 composer / 壳的全局键位表决定">
        <p className="settings-desc">Enter 发送 · Shift+Enter 换行 · Ctrl+K 命令面板 · Ctrl+, 打开本设置</p>
      </SettingsSectionBlock>
    </>
  );
}
