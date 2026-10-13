// 通用设置（D-6x `ui-settings-general` 对应物：通用设置区）。
//
// 只摆**真生效**的项（AGENTS.md：不摆没用的开关）：
//   通知详情 —— 真实偏好字段（宿主的偏好存储，如桌面的偏好文件 notifyDetails，App 启动时读取）；
//             如实标注「重启应用后生效」（运行中的通知文案不追改）。
// 主题已迁到「外观」分区（Z-90：主题/字号属外观；本分区只留常规项），见 settings/appearance。
// 已删除的项：启动默认分栏数 —— P4-C 三栅落地后分栏（PaneArea）已拆除，该项无消费方（假开关）。
//
// 措辞按壳注入（Z-措辞纠偏）：偏好文件名与「打开本设置」键位**两壳不同**（web 无 desktop-preferences.json、
// 未绑定 Ctrl+,），故经 props 注入；缺省为中性且正确的文案（不含 desktop 专属事实）。
import type { SettingsNotifyDetails } from '../../../shared/settings.js';
import { SettingsSectionBlock } from '../shell/section-block.js';

/** 通知详情可选项（与 shared/preferences 的 NOTIFY_DETAILS 同值域） */
export const NOTIFY_DETAILS_CHOICES: readonly SettingsNotifyDetails[] = ['minimal', 'full'];

/** 通知详情文案（与 App 的 composeNotifyContent 消费口径一致） */
export const NOTIFY_DETAILS_LABEL: Record<SettingsNotifyDetails, string> = {
  minimal: '精简（仅标题）',
  full: '完整（含回复摘要）',
};

export interface GeneralSettingsProps {
  /** 当前通知详情级别（宿主注入：来自 preferences IPC） */
  readonly notifyDetails: SettingsNotifyDetails;
  /** 选择通知详情级别（宿主持久化） */
  readonly onSelectNotifyDetails: (details: SettingsNotifyDetails) => void;
  /** 偏好是否已载入（未载入时不渲染可点控件，避免「点了没反应」的假开关） */
  readonly loaded: boolean;
  /** 可选的宿主反馈文案（保存失败等如实显示） */
  readonly note?: string | null;
  /**
   * 偏好文件 / 存储介质措辞（按壳注入；缺省中性「本机偏好文件」）。
   * 桌面注入 `desktop-preferences.json`；web 注入其真实存储（浏览器本地存储）。
   */
  readonly preferencesFileLabel?: string;
  /**
   * 「打开本设置」的键位提示（按壳注入；缺省不显示该句）。
   * 桌面注入 `Ctrl+,`（真实绑定）；web 未绑定该键（经侧栏齿轮进入）则不传。
   */
  readonly openSettingsKeys?: string;
}

export function GeneralSettings({
  notifyDetails,
  onSelectNotifyDetails,
  loaded,
  note,
  preferencesFileLabel,
  openSettingsKeys,
}: GeneralSettingsProps): React.ReactNode {
  const prefLabel = preferencesFileLabel ?? '本机偏好文件';
  return (
    <>
      <SettingsSectionBlock
        title="任务完成通知"
        desc={`系统通知的详情级别；改动写 ${prefLabel}，重启应用后生效（当前运行的通知文案不追改）`}
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
        <p className="settings-desc">
          Enter 发送 · Shift+Enter 换行 · Ctrl+K 命令面板
          {openSettingsKeys !== undefined ? ` · ${openSettingsKeys} 打开本设置` : ''}
        </p>
      </SettingsSectionBlock>
    </>
  );
}
