// 网关 / IM 分区（Z7）：IM 网关（QQ / 飞书）的**凭据写入入口 + 只读状态 + 空态指引**。
//
// 数据面（按壳如实提供，缺失即降级，红线⑩不摆假状态）：
//   * config.gateways.<channel>（appId 非密钥入 config.json；enabled/dmPolicy/groupPolicy/allow）—— 只读展示 + 策略写入（有 updateConfig 时）；
//   * auth.json gateways.<channel>.appSecret（**永不回显明文**）—— 只经 onSaveAuth 只写；
//     appId 同样只写不回显明文，回读只有 SettingsAuthMaskedShape.gateways[].maskedAppId/maskedAppSecret 的掩码布尔。
//
// 连接状态口径：本仓**无可信运行时状态源**（gateway 常驻进程与 serve 互不问状态，无 status 端点）——
// 因此**不渲染任何绿点/连接中假状态**，只显示「未探测（无运行时状态源）」如实文案 + 启动指引。
import { useEffect, useState } from 'react';
import type {
  SettingsAuthMaskedShape,
  SettingsConfigShape,
  SettingsGatewayChannelShape,
} from '../../../shared/settings.js';
import { SettingsSectionBlock } from '../shell/index.js';

/** IM 渠道名（与 core config.schema GATEWAY_CHANNELS 同值：qq / feishu） */
export const GATEWAY_CHANNELS = ['qq', 'feishu'] as const;
export type GatewayChannel = (typeof GATEWAY_CHANNELS)[number];

/** 渠道显示名 */
export const GATEWAY_CHANNEL_LABEL: Record<GatewayChannel, string> = {
  qq: 'QQ',
  feishu: '飞书',
};

export const GATEWAY_POLICIES = [
  { value: 'open', label: '开放' },
  { value: 'allowlist', label: '白名单' },
  { value: 'disabled', label: '禁用' },
] as const;

/** 默认启动指引（宿主可经 SettingsPorts.gatewayGuidance 覆盖为更贴合本壳的命令） */
export const DEFAULT_GATEWAY_GUIDANCE =
  '在 ~/.harness2/config.json 的 gateways 段配置 appId 与策略、把 appSecret 写入 ~/.harness2/auth.json，运行 harness2 gateway --platform qq,feishu 启动网关。';

export interface GatewaySectionProps {
  readonly cfg: SettingsConfigShape;
  readonly auth: SettingsAuthMaskedShape;
  /** 写 auth.json gateway 凭据（缺失 = 此壳不可写凭据：输入与保存按钮不渲染） */
  readonly onSaveAuth?: ((patch: Record<string, unknown>) => Promise<void>) | undefined;
  /** 写 config.json gateways（启用/策略；缺失 = 只读展示） */
  readonly onSaveCfg?: ((patch: Record<string, unknown>) => Promise<void>) | undefined;
  /** 启动指引文案 */
  readonly guidance?: string | undefined;
}

/** 该渠道是否已配置（config 有 appId 或 auth 有掩码凭据） */
export function isGatewayConfigured(channel: string, cfg: SettingsConfigShape, auth: SettingsAuthMaskedShape): boolean {
  const gw = (cfg.gateways?.[channel] ?? {}) as SettingsGatewayChannelShape;
  const hasAppId = typeof gw.appId === 'string' && gw.appId.length > 0;
  const masked = auth.gateways.find((g) => g.channel === channel);
  return hasAppId || masked?.maskedAppId === true || masked?.maskedAppSecret === true;
}

/** 单渠道行：凭据掩码态 + appId/secret 写入 + 策略（只读/可写按端口可用性） */
function GatewayChannelCard({
  channel,
  cfg,
  auth,
  onSaveAuth,
  onSaveCfg,
}: {
  channel: GatewayChannel;
  cfg: SettingsConfigShape;
  auth: SettingsAuthMaskedShape;
  onSaveAuth?: ((patch: Record<string, unknown>) => Promise<void>) | undefined;
  onSaveCfg?: ((patch: Record<string, unknown>) => Promise<void>) | undefined;
}): React.ReactNode {
  const gw = (cfg.gateways?.[channel] ?? {}) as SettingsGatewayChannelShape;
  const masked = auth.gateways.find((g) => g.channel === channel);
  const appIdMasked = masked?.maskedAppId === true;
  const secretMasked = masked?.maskedAppSecret === true;
  const configured = isGatewayConfigured(channel, cfg, auth);
  const enabled = gw.enabled !== false;

  const [appId, setAppId] = useState('');
  const [secret, setSecret] = useState('');
  const [policy, setPolicy] = useState<string>(typeof gw.dmPolicy === 'string' ? gw.dmPolicy : 'allowlist');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPolicy(typeof gw.dmPolicy === 'string' ? gw.dmPolicy : 'allowlist');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg]);

  const saveCredential = (): void => {
    if (onSaveAuth === undefined) return;
    setBusy(true);
    setFeedback(null);
    void onSaveAuth({ gateways: { [channel]: { appId, appSecret: secret } } })
      .then(() => {
        setAppId('');
        setSecret('');
        setFeedback('已写入 auth.json（不回显明文）');
      })
      .catch((e: Error) => setFeedback(`保存失败：${e.message}`))
      .finally(() => setBusy(false));
  };

  const savePolicy = (): void => {
    if (onSaveCfg === undefined) return;
    void onSaveCfg({
      gateways: {
        [channel]: {
          ...gw,
          enabled,
          dmPolicy: policy,
          groupPolicy: policy,
          allow: Array.isArray(gw.allow) ? gw.allow : [],
        },
      },
    })
      .then(() => setFeedback('已保存策略'))
      .catch((e: Error) => setFeedback(`保存失败：${e.message}`));
  };

  const label = GATEWAY_CHANNEL_LABEL[channel];
  return (
    <div className="settings-card" data-gateway-channel={channel}>
      <h4>{label}</h4>
      <div className="settings-table">
        <div className="settings-table-row">
          <span className="row-key">凭据</span>
          <span className="row-val" data-gateway-credential={configured ? 'configured' : 'unconfigured'}>
            {configured
              ? `已配置（appId ${appIdMasked ? '掩码' : '明文缺失'} · appSecret ${secretMasked ? '掩码' : '未配置'}）`
              : '未配置'}
          </span>
        </div>
        <div className="settings-table-row">
          <span className="row-key">连接状态</span>
          {/* 红线⑩：无可信运行时状态源 → 只报「未探测」，不造假绿点 */}
          <span className="row-val" data-gateway-status="unprobed">
            未探测（本壳无网关运行时状态源）
          </span>
        </div>
        <div className="settings-table-row">
          <span className="row-key">启用</span>
          <span className="row-val">{enabled ? '是' : '否（enabled=false）'}</span>
        </div>
      </div>

      {onSaveAuth !== undefined ? (
        <div className="settings-row" data-gateway-credential-form>
          <span className="row-key">AppID</span>
          <input
            className="settings-input"
            value={appId}
            placeholder={appIdMasked ? '已配置（掩码，留空不改）' : ''}
            onChange={(e) => setAppId(e.target.value)}
            aria-label={`${label} AppID`}
          />
          <span className="row-key">AppSecret</span>
          <input
            className="settings-input"
            type="password"
            value={secret}
            placeholder={secretMasked ? '已配置（掩码，留空不改）' : ''}
            onChange={(e) => setSecret(e.target.value)}
            aria-label={`${label} AppSecret`}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={busy || (appId.length === 0 && secret.length === 0)}
            onClick={saveCredential}
          >
            {busy ? '保存中…' : '保存凭据'}
          </button>
        </div>
      ) : (
        <p className="settings-desc" data-gateway-credential-unavailable>
          此壳未提供凭据写入通道：请用桌面端或命令行配置 {label} 的 appId / appSecret。
        </p>
      )}

      <div className="settings-row">
        <span className="row-key">私聊/群策略</span>
        {GATEWAY_POLICIES.map((p) => (
          <button
            key={p.value}
            type="button"
            className={`seg${policy === p.value ? ' seg-on' : ''}`}
            disabled={onSaveCfg === undefined}
            onClick={() => setPolicy(p.value)}
          >
            {p.label}
          </button>
        ))}
        {onSaveCfg !== undefined ? (
          <button type="button" className="btn-primary" onClick={savePolicy}>
            保存策略
          </button>
        ) : (
          <span className="settings-desc">（此壳只读）</span>
        )}
      </div>
      {feedback !== null && <p className="settings-feedback">{feedback}</p>}
    </div>
  );
}

/** 网关 / IM 分区正文（有 config/auth 数据面时；缺失请用 GatewayUnavailable） */
export function GatewaySection({ cfg, auth, onSaveAuth, onSaveCfg, guidance }: GatewaySectionProps): React.ReactNode {
  const anyConfigured = GATEWAY_CHANNELS.some((c) => isGatewayConfigured(c, cfg, auth));
  const guide = guidance ?? DEFAULT_GATEWAY_GUIDANCE;
  return (
    <>
      <SettingsSectionBlock
        title="IM 网关"
        desc="QQ / 飞书接入（config.json gateways + auth.json 凭据）；appSecret 只写不回显，状态不造假"
      >
        {!anyConfigured && (
          <div className="settings-desc" data-gateway-empty>
            尚未配置任何 IM 网关渠道。{guide}
          </div>
        )}
        {GATEWAY_CHANNELS.map((c) => (
          <GatewayChannelCard key={c} channel={c} cfg={cfg} auth={auth} onSaveAuth={onSaveAuth} onSaveCfg={onSaveCfg} />
        ))}
        <p className="settings-note">
          密钥只落 ~/.harness2/auth.json（gateways.&lt;channel&gt;.appSecret），配置文件只持有 appId 与策略；
          本页永不回显明文。连接状态暂无运行时数据源，故只报「未探测」。
        </p>
      </SettingsSectionBlock>
      <SettingsSectionBlock title="启动指引" desc="网关为独立常驻进程（CLI），桌面/ web 壳不代跑">
        <p className="settings-note">{guide}</p>
      </SettingsSectionBlock>
    </>
  );
}

/**
 * 网关 / IM 分区正文（**本壳无 config/auth 数据面**时）：只报如实状态 + 启动指引，不摆假条目/假开关。
 * web 壳无 config.json 读取与 auth.json 写入通道 → 走此分支（红线⑩）。
 */
export function GatewayUnavailable({ guidance }: { guidance?: string | undefined }): React.ReactNode {
  const guide = guidance ?? DEFAULT_GATEWAY_GUIDANCE;
  return (
    <>
      <SettingsSectionBlock title="IM 网关" desc="本壳无网关数据面（只读指引）">
        <div className="settings-desc" data-gateway-unavailable>
          此壳不提供 config.json 读取 / auth.json 凭据写入通道，无法展示或修改网关配置与凭据 （appSecret
          永不回显）。请在桌面端或命令行配置。
        </div>
        <div className="settings-table">
          {GATEWAY_CHANNELS.map((c) => (
            <div key={c} className="settings-table-row" data-gateway-channel={c}>
              <span className="row-key">{GATEWAY_CHANNEL_LABEL[c]}</span>
              <span className="row-val" data-gateway-status="unprobed">
                未探测（本壳无运行时状态源与配置通道）
              </span>
            </div>
          ))}
        </div>
      </SettingsSectionBlock>
      <SettingsSectionBlock title="启动指引" desc="网关为独立常驻进程（CLI）">
        <p className="settings-note">{guide}</p>
      </SettingsSectionBlock>
    </>
  );
}
