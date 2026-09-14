// 设置弹窗（B2；P6-C 重构为**设置壳 + 分区装配**）。
//
// 结构（D-6x「ui-settings-general（设置壳与通用设置）」对应物）：
//   壳与内容槽 → `renderer/settings/shell`（分区导航 + 按需挂载 + 能力模块注入面）；
//   通用设置   → `renderer/settings/general`（主题真生效 / 通知详情 / 快捷键说明）；
//   模型配置   → B 棒 `ui-settings-models`（按 props 契约接 `ModelsSettings`；未落地时**显式占位 +
//               过渡面板**，不造假实现）；
//   凭据等既有分区 → 本文件内（配置读写仍走既有 settings:* IPC，与 CLI 共用 config.json / auth.json）。
//
// 数据读取一律经 window.harness2 的 settings:* IPC（渲染进程零 Node，不碰文件系统）。
// 主题呈现：选择经宿主 `onThemeChange`（装配层 = P4 的 setShellTheme）→ 立即写 D-15 四要素，再持久化偏好；
// 本文件不自己碰 DOM、不自己碰壳 store（边界：分区内容只经 props 与宿主交互）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  SettingsAuthMaskedShape,
  SettingsConfigShape,
  SettingsCrashReportShape,
  SettingsDoctorCheck,
  SettingsDoctorReportShape,
  SettingsNotifyDetails,
  SettingsPreferencesShape,
  SettingsTheme,
} from '../../shared/protocol.js';
import { useShellTheme } from '../layout/shell-theme.js';
import { GeneralSettings } from '../settings/general/index.js';
import {
  MODELS_SECTION_ID,
  MODELS_SETTINGS_OWNER,
  SettingsSectionBlock,
  SettingsShell,
  findSettingsSection,
  type ModelsSettingsProps,
  type SettingsSectionDefinition,
} from '../settings/shell/index.js';

const APPROVAL_MODES = [
  { value: 'default', label: '每次执行前询问', desc: 'default：安全工具自动执行，有副作用工具先询问' },
  { value: 'acceptEdits', label: '自动接受编辑', desc: 'acceptEdits：write/edit 直接执行，其余有副作用工具仍询问' },
  { value: 'bypass', label: '完全控制', desc: 'bypass：全部工具自动执行，不作询问' },
  {
    value: 'plan',
    label: '先计划再执行',
    desc: 'plan：agent 先给计划等你确认，write/edit/bash 等被拒执行（内核支持随终端轨道 T1 提供）',
  },
];

const MEMORY_MODES = [
  { value: 'off', label: '关闭' },
  { value: 'ask', label: '询问' },
  { value: 'auto', label: '自动' },
];

const GATEWAY_POLICIES = [
  { value: 'open', label: '开放' },
  { value: 'allowlist', label: '白名单' },
  { value: 'disabled', label: '禁用' },
];

// —— 分区：模型配置（B 棒接管前） ——

/**
 * 模型配置的**过渡面板**（B 棒 `ui-settings-models` 落地前）：
 * 保留既有的「主模型改写」真实能力（roles.main → config.json 白名单深合并），并显式标注待接入。
 * B 的 `ModelsSettings` 注册进 `MODELS_SECTION_ID` 后，本面板自动让位（不再渲染）。
 */
function ModelsTransitionSection({
  cfg,
  onSave,
}: {
  cfg: SettingsConfigShape;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}): React.ReactNode {
  // PD5：主模型改写入口（roles.main → 全局 config.json 白名单深合并）。生效范围如实标注：
  // 运行中会话的 effective run-config 是创建期快照，新会话/重启 serve 后生效。
  const mainRole = cfg.roles['main'] ?? { channel: '', model: '' };
  const [mainChannel, setMainChannel] = useState(mainRole.channel);
  const [mainModel, setMainModel] = useState(mainRole.model);
  const [mainFeedback, setMainFeedback] = useState<string | null>(null);
  const applyMain = (): void => {
    void onSave({ roles: { main: { channel: mainChannel, model: mainModel } } })
      .then(() => setMainFeedback('已写入全局配置；运行中会话不变，新会话/重启后生效'))
      .catch((e: Error) => setMainFeedback(e.message));
  };
  return (
    <>
      <SettingsSectionBlock
        title="模型配置页待接入（B 棒 ui-settings-models）"
        desc="该分区已按 props 契约预留（组件名 ModelsSettings，见 renderer/settings/shell/models-contract.ts）"
      >
        <p className="settings-note">
          模型配置页（D-50～D-59、D-85）由并行开发的 B 棒 `renderer/settings/models/**` 提供，尚未落地；
          本分区当前由下面的**过渡面板**承载（与 CLI 共用 config.json），B 组件注册后本提示与过渡面板自动让位。
        </p>
      </SettingsSectionBlock>
      <SettingsSectionBlock
        title="模型与角色（过渡）"
        desc="channel 列表与 roles 映射（config.json 同一份，与 CLI 共用）"
      >
        <div className="settings-table">
          {Object.entries(cfg.providers).map(([name, p]) => (
            <div key={name} className="settings-table-row">
              <span className="row-key">{name}</span>
              <span className="row-val">{p.protocol}</span>
              <span className="row-val mono">{p.baseUrl}</span>
              {p.envKey !== undefined && <span className="row-val mono">env:{p.envKey}</span>}
            </div>
          ))}
          {Object.keys(cfg.providers).length === 0 && (
            <div className="settings-desc">未配置 provider（可在 CLI 的 ~/.harness2/config.json 配置）</div>
          )}
        </div>
        <div className="settings-table">
          {Object.entries(cfg.roles).map(([role, r]) => (
            <div key={role} className="settings-table-row">
              <span className="row-key">{role}</span>
              <span className="row-val">channel: {r.channel}</span>
              <span className="row-val">model: {r.model}</span>
            </div>
          ))}
        </div>
        <div className="settings-table">
          <div className="settings-table-row">
            <span className="row-key">main（主模型）</span>
            <input
              className="settings-input mono"
              value={mainChannel}
              placeholder="channel（如 local-oai）"
              onChange={(e) => setMainChannel(e.target.value)}
            />
            <input
              className="settings-input mono"
              value={mainModel}
              placeholder="model（须在该 channel 的 models 内）"
              onChange={(e) => setMainModel(e.target.value)}
            />
            <button type="button" className="btn-primary" onClick={applyMain}>
              保存主模型
            </button>
          </div>
        </div>
        {mainFeedback !== null && <p className="settings-feedback">{mainFeedback}</p>}
        <p className="settings-note">
          模型改动写入**全局** config.json（与 CLI 共用同一份；密钥仍只进 auth.json，写前校验、原子落盘）。
          运行中会话的生效配置不变，新会话/重启 serve 后生效；增删 provider 仍请在 CLI 配置文件中进行。
        </p>
        {cfg.sources.global === false && cfg.sources.project === false && (
          <p className="settings-warn">尚未找到任何配置文件（~/.harness2/config.json）</p>
        )}
      </SettingsSectionBlock>
    </>
  );
}

// —— 分区：审批与安全 ——

function ApprovalSettingsSection({
  cfg,
  onSave,
}: {
  cfg: SettingsConfigShape;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}): React.ReactNode {
  const [mode, setMode] = useState(cfg.approval.mode);
  const [feedback, setFeedback] = useState<string | null>(null);
  const apply = (): void => {
    void onSave({ approval: { mode } })
      .then(() => setFeedback('已保存'))
      .catch((e: Error) => setFeedback(e.message));
  };
  return (
    <SettingsSectionBlock title="审批模式" desc="与 CLI config.json 的 approval.mode 同一字段">
      <div className="settings-choice">
        {APPROVAL_MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            className={`choice${mode === m.value ? ' choice-on' : ''}`}
            onClick={() => setMode(m.value)}
          >
            <span className="choice-label">{m.label}</span>
            <span className="choice-desc">{m.desc}</span>
          </button>
        ))}
      </div>
      {cfg.approval.tools !== undefined && Object.keys(cfg.approval.tools).length > 0 && (
        <SettingsSectionBlock
          title="工具级规则（只读展示）"
          desc="按工具粒度 allow/ask/deny，见 config.json approval.tools"
        >
          <div className="settings-table">
            {Object.entries(cfg.approval.tools).map(([tool, rule]) => (
              <div key={tool} className="settings-table-row">
                <span className="row-key">{tool}</span>
                <span className="row-val">{rule}</span>
              </div>
            ))}
          </div>
        </SettingsSectionBlock>
      )}
      <div className="settings-row">
        <button type="button" className="btn-primary" onClick={apply}>
          保存
        </button>
        {feedback !== null && <span className="settings-feedback">{feedback}</span>}
      </div>
    </SettingsSectionBlock>
  );
}

// —— 分区：记忆 ——

function MemorySection({
  cfg,
  onSave,
}: {
  cfg: SettingsConfigShape;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}): React.ReactNode {
  const [mode, setMode] = useState(cfg.memory.mode);
  const [interval, setInterval] = useState(String(cfg.memory.nudgeInterval));
  const apply = (): void => {
    const n = Number(interval);
    if (!Number.isInteger(n) || n < 1 || n > 1000) return;
    void onSave({ memory: { mode, nudgeInterval: n } });
  };
  return (
    <>
      <SettingsSectionBlock title="记忆模式" desc="off/ask/auto 三态（memory.mode）">
        <div className="settings-row">
          {MEMORY_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={`seg${mode === m.value ? ' seg-on' : ''}`}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </SettingsSectionBlock>
      <SettingsSectionBlock title="复盘提醒间隔" desc="nudgeInterval（分钟，1..1000）">
        <input
          className="settings-input"
          type="number"
          min={1}
          max={1000}
          value={interval}
          onChange={(e) => setInterval(e.target.value)}
        />
      </SettingsSectionBlock>
      <SettingsSectionBlock
        title="待审批记忆"
        desc="ask 模式下的暂存条目可在 CLI 中用 harness2 memory pending 查看与审批"
      >
        <p className="settings-note">
          完整管理功能见后续版本（当前经 CLI：harness2 memory pending / approve / reject）
        </p>
      </SettingsSectionBlock>
      <button type="button" className="btn-primary" onClick={apply}>
        保存
      </button>
    </>
  );
}

// —— 分区：浏览器工具 ——

function BrowserSection({
  cfg,
  onSave,
}: {
  cfg: SettingsConfigShape;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}): React.ReactNode {
  const [enabled, setEnabled] = useState(cfg.browser.enabled);
  const [max, setMax] = useState(String(cfg.browser.maxConcurrent));
  const [idle, setIdle] = useState(String(cfg.browser.idleDestroyMs));
  const apply = (): void => {
    const maxN = Number(max);
    const idleN = Number(idle);
    if (!Number.isInteger(maxN) || maxN < 1 || maxN > 8) return;
    if (!Number.isInteger(idleN) || idleN < 1000) return;
    void onSave({ browser: { enabled, maxConcurrent: maxN, idleDestroyMs: idleN } });
  };
  return (
    <>
      <SettingsSectionBlock title="浏览器工具" desc="browser_navigate / browser_snapshot 等浏览器工具">
        <label className="settings-check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用浏览器工具
        </label>
      </SettingsSectionBlock>
      <SettingsSectionBlock title="最大并发数" desc="maxConcurrent（1..8）">
        <input
          className="settings-input"
          type="number"
          min={1}
          max={8}
          value={max}
          onChange={(e) => setMax(e.target.value)}
        />
      </SettingsSectionBlock>
      <SettingsSectionBlock title="空闲销毁时长" desc="idleDestroyMs（毫秒，≥1000）">
        <input
          className="settings-input"
          type="number"
          min={1000}
          value={idle}
          onChange={(e) => setIdle(e.target.value)}
        />
      </SettingsSectionBlock>
      <button type="button" className="btn-primary" onClick={apply}>
        保存
      </button>
    </>
  );
}

// —— 分区：定时任务 / 插件与集成 / 子代理 ——

function CronSection(): React.ReactNode {
  return (
    <SettingsSectionBlock title="定时任务" desc="cron 任务由 CLI 命令管理（harness2 cron add/remove/list）">
      <p className="settings-note">桌面端可视化任务管理见后续版本；当前请在 CLI 中配置定时任务。</p>
    </SettingsSectionBlock>
  );
}

function PluginsSection({ cfg }: { cfg: SettingsConfigShape }): React.ReactNode {
  const mcpNames = Object.keys(cfg.mcpServers);
  return (
    <>
      <SettingsSectionBlock title="已装插件" desc="config.json plugins.allow 白名单">
        <div className="settings-table">
          {cfg.plugins.allow.length === 0 && <div className="settings-desc">无已启用插件</div>}
          {cfg.plugins.allow.map((p) => (
            <div key={p} className="settings-table-row">
              <span className="row-key">{p}</span>
              <span className="row-val">enabled</span>
            </div>
          ))}
        </div>
        <p className="settings-note">插件增删与审批经 CLI：harness2 plugin list / enable / disable</p>
      </SettingsSectionBlock>
      <SettingsSectionBlock title="MCP 服务器" desc="config.json mcpServers（stdio / streamable HTTP）">
        <div className="settings-table">
          {mcpNames.length === 0 && <div className="settings-desc">未配置 MCP 服务器</div>}
          {mcpNames.map((name) => {
            const m = cfg.mcpServers[name] as Record<string, unknown> | undefined;
            const kind =
              m !== undefined && 'command' in m
                ? `${String(m['command'])} ${Array.isArray(m['args']) ? (m['args'] as string[]).join(' ') : ''}`
                : String(m?.['url']);
            return (
              <div key={name} className="settings-table-row">
                <span className="row-key">{name}</span>
                <span className="row-val mono">{kind}</span>
              </div>
            );
          })}
        </div>
        <div className="settings-table">
          <div className="settings-table-row">
            <span className="row-key">Skills</span>
            <span className="row-val">项目级 + 全局级（只读，由 CLI harness2 skill list 查看）</span>
          </div>
        </div>
      </SettingsSectionBlock>
    </>
  );
}

function SubagentSection({
  cfg,
  onSave,
}: {
  cfg: SettingsConfigShape;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}): React.ReactNode {
  const [maxDepth, setMaxDepth] = useState(String(cfg.subagent.maxDepth));
  const [maxTurns, setMaxTurns] = useState(String(cfg.subagent.maxTurns));
  const apply = (): void => {
    const d = Number(maxDepth);
    const t = Number(maxTurns);
    if (!Number.isInteger(d) || d < 1 || d > 10) return;
    if (!Number.isInteger(t) || t < 1 || t > 200) return;
    void onSave({ subagent: { maxDepth: d, maxTurns: t } });
  };
  return (
    <>
      <SettingsSectionBlock title="子代理深度" desc="maxDepth（1..10）">
        <input
          className="settings-input"
          type="number"
          min={1}
          max={10}
          value={maxDepth}
          onChange={(e) => setMaxDepth(e.target.value)}
        />
      </SettingsSectionBlock>
      <SettingsSectionBlock title="子代理最大步数" desc="maxTurns（1..200）">
        <input
          className="settings-input"
          type="number"
          min={1}
          max={200}
          value={maxTurns}
          onChange={(e) => setMaxTurns(e.target.value)}
        />
      </SettingsSectionBlock>
      <SettingsSectionBlock title="子代理模型" desc="roles.subagent 的 channel / model（可在 CLI 配置文件调整）">
        <p className="settings-desc">
          channel: {cfg.roles['subagent']?.channel ?? '未配置'} · model: {cfg.roles['subagent']?.model ?? '未配置'}
        </p>
      </SettingsSectionBlock>
      <button type="button" className="btn-primary" onClick={apply}>
        保存
      </button>
    </>
  );
}

// —— 分区：凭据（IM 网关的 appId/appSecret + 私聊/群策略） ——

function CredentialsSection({
  cfg,
  auth,
  onSaveCfg,
  onSaveAuth,
}: {
  cfg: SettingsConfigShape;
  auth: SettingsAuthMaskedShape;
  onSaveCfg: (patch: Record<string, unknown>) => Promise<void>;
  onSaveAuth: (patch: Record<string, unknown>) => Promise<void>;
}): React.ReactNode {
  const channels = ['qq', 'feishu'] as const;
  const [appId, setAppId] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState<Record<string, string>>({});
  useEffect(() => {
    const next: Record<string, string> = {};
    const nextP: Record<string, string> = {};
    for (const c of channels) {
      next[c] = '';
      const gw = (cfg.gateways?.[c] ?? {}) as Record<string, unknown>;
      nextP[c] = typeof gw['dmPolicy'] === 'string' ? (gw['dmPolicy'] as string) : 'allowlist';
    }
    setAppId(next);
    setSecret(next);
    setPolicy(nextP);
  }, [cfg, channels.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveGateway = (c: (typeof channels)[number]): void => {
    const gatewayPatch: Record<string, unknown> = {};
    if ((appId[c] ?? '').length > 0 || (secret[c] ?? '').length > 0) {
      gatewayPatch[c] = { appId: appId[c] ?? '', appSecret: secret[c] ?? '' };
    }
    void onSaveAuth({ gateways: gatewayPatch });
  };
  const savePolicy = (c: (typeof channels)[number]): void => {
    const current = (cfg.gateways?.[c] ?? {}) as Record<string, unknown>;
    void onSaveCfg({
      gateways: {
        [c]: {
          ...current,
          enabled: current['enabled'] !== false,
          dmPolicy: policy[c] ?? 'allowlist',
          groupPolicy: policy[c] ?? 'allowlist',
          allow: Array.isArray(current['allow']) ? current['allow'] : [],
        },
      },
    });
  };
  return (
    <SettingsSectionBlock title="IM 网关凭据" desc="QQ / 飞书凭据写 auth.json（只显示掩码），私聊/群策略写 config.json">
      {channels.map((c) => {
        const gw = (cfg.gateways?.[c] ?? {}) as Record<string, unknown>;
        const enabled = gw['enabled'] !== false;
        const masked = auth.gateways.find((g) => g.channel === c);
        const appIdMasked = masked?.maskedAppId ?? false;
        const secretMasked = masked?.maskedAppSecret ?? false;
        return (
          <div key={c} className="settings-card">
            <h4>{c.toUpperCase()}</h4>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => void onSaveCfg({ gateways: { [c]: { ...gw, enabled: e.target.checked } } })}
              />
              启用
            </label>
            <div className="settings-row">
              <span className="row-key">AppID</span>
              <input
                className="settings-input"
                placeholder={appIdMasked ? '已配置（掩码）' : ''}
                value={appId[c] ?? ''}
                onChange={(e) => setAppId((p) => ({ ...p, [c]: e.target.value }))}
              />
              <button type="button" className="btn-primary" onClick={() => saveGateway(c)}>
                保存凭据
              </button>
            </div>
            <div className="settings-row">
              <span className="row-key">AppSecret</span>
              <input
                className="settings-input"
                type="password"
                placeholder={secretMasked ? '已配置（掩码）' : ''}
                value={secret[c] ?? ''}
                onChange={(e) => setSecret((p) => ({ ...p, [c]: e.target.value }))}
              />
            </div>
            <div className="settings-row">
              <span className="row-key">私聊/群策略</span>
              {GATEWAY_POLICIES.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  className={`seg${(policy[c] ?? 'allowlist') === p.value ? ' seg-on' : ''}`}
                  onClick={() => setPolicy((prev) => ({ ...prev, [c]: p.value }))}
                >
                  {p.label}
                </button>
              ))}
              <button type="button" className="btn-primary" onClick={() => savePolicy(c)}>
                保存策略
              </button>
            </div>
          </div>
        );
      })}
      <p className="settings-note">连接状态点与断线重连提示属于真机项，见残留手工验收清单。</p>
    </SettingsSectionBlock>
  );
}

// —— 分区：会话与数据 / 诊断 / 快捷键 / 关于 ——

function SessionsSection(): React.ReactNode {
  return (
    <SettingsSectionBlock title="会话与数据" desc="会话以事件溯源日志存储在本地">
      <div className="settings-table">
        <div className="settings-table-row">
          <span className="row-key">存储位置</span>
          <span className="row-val mono">~/.harness2/sessions/</span>
        </div>
        <div className="settings-table-row">
          <span className="row-key">导出 / 回放</span>
          <span className="row-val">CLI：harness2 export &lt;id&gt; · harness2 replay（桌面入口见后续版本）</span>
        </div>
      </div>
      <p className="settings-note">仅本地存储，无遥测上报。</p>
    </SettingsSectionBlock>
  );
}

function DiagnosticsSection(): React.ReactNode {
  const [report, setReport] = useState<SettingsDoctorReportShape | null>(null);
  const [crashes, setCrashes] = useState<SettingsCrashReportShape[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback((): void => {
    setLoading(true);
    setError(null);
    void window.harness2
      .settingsGetDoctorReport()
      .then((r) => setReport(r))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    void window.harness2
      .settingsGetCrashReports()
      .then(setCrashes)
      .catch(() => {});
  }, []);
  useEffect(run, [run]);
  const statusLabel: Record<SettingsDoctorCheck['status'], string> = { ok: 'OK', warn: 'WARN', fail: 'FAIL' };
  return (
    <>
      <SettingsSectionBlock title="doctor 六项检查" desc="复用内核 runDoctor（node/config/home/mcp/sessions/skills）">
        <button type="button" className="btn-primary" onClick={run} disabled={loading}>
          {loading ? '检查中…' : '运行检查'}
        </button>
        {error !== null && <p className="settings-warn">{error}</p>}
        {report !== null && (
          <div className="settings-table">
            {report.checks.map((c) => (
              <div key={c.id} className="settings-table-row">
                <span className={`diag-icon diag-${c.status}`}>{statusLabel[c.status]}</span>
                <span className="row-key">{c.id}</span>
                <span className="row-val">{c.summary}</span>
              </div>
            ))}
          </div>
        )}
      </SettingsSectionBlock>
      <SettingsSectionBlock title="崩溃报告" desc="~/.harness2/crash/（本地，无遥测）">
        <div className="settings-table">
          {crashes.length === 0 && <div className="settings-desc">无崩溃报告</div>}
          {crashes.map((c) => (
            <div key={c.fileName} className="settings-table-row">
              <span className="row-val mono">{c.fileName}</span>
              <span className="row-val">{new Date(c.mtime).toLocaleString()}</span>
              <span className="row-val">{(c.size / 1024).toFixed(1)} KB</span>
            </div>
          ))}
        </div>
      </SettingsSectionBlock>
    </>
  );
}

function ShortcutsSection(): React.ReactNode {
  const rows = [
    ['Enter', '发送当前消息'],
    ['Shift+Enter', '换行（不发送）'],
    ['Ctrl+, / Cmd+,', '打开设置'],
    ['Ctrl+K / Cmd+K', '命令面板'],
    ['Ctrl+N', '新建会话'],
    ['Ctrl+F', '侧栏会话搜索（聚焦搜索框）'],
    ['Ctrl+Shift+I / Cmd+Opt+I', '开发者工具'],
  ];
  return (
    <SettingsSectionBlock title="快捷键" desc="只读列表">
      <div className="settings-table">
        {rows.map(([k, d]) => (
          <div key={k} className="settings-table-row">
            <span className="row-key mono">{k}</span>
            <span className="row-val">{d}</span>
          </div>
        ))}
      </div>
    </SettingsSectionBlock>
  );
}

function AboutSection(): React.ReactNode {
  return (
    <SettingsSectionBlock title="harness2 桌面端" desc="事件溯源 · 单写者 · 崩溃一致 · 仅本地无遥测">
      <div className="settings-table">
        <div className="settings-table-row">
          <span className="row-key">版本</span>
          <span className="row-val">v1.0.0</span>
        </div>
        <div className="settings-table-row">
          <span className="row-key">内核</span>
          <span className="row-val">@harness2/core（会话事件溯源内核）</span>
        </div>
        <div className="settings-table-row">
          <span className="row-key">数据</span>
          <span className="row-val">仅本地存储，无遥测上报</span>
        </div>
        <div className="settings-table-row">
          <span className="row-key">更新</span>
          <span className="row-val">目前无自动更新；需手动下载新安装包或 npm update</span>
        </div>
      </div>
    </SettingsSectionBlock>
  );
}

function LoadingPane(): React.ReactNode {
  return <div className="settings-desc">加载中…</div>;
}

// —— 主弹窗（组合根） ——

export function SettingsDialog({
  open,
  onClose,
  onThemeChange,
}: {
  open: boolean;
  onClose: () => void;
  onThemeChange: (t: SettingsTheme) => void;
}) {
  const [prefs, setPrefs] = useState<SettingsPreferencesShape | null>(null);
  const [cfg, setCfg] = useState<SettingsConfigShape | null>(null);
  const [auth, setAuth] = useState<SettingsAuthMaskedShape | null>(null);
  const [prefsNote, setPrefsNote] = useState<string | null>(null);
  // 当前主题来自壳主题 store（P4/D-15 的真源），不另存一份易漂移的副本
  const theme = useShellTheme();

  const reload = useCallback(async () => {
    try {
      const [p, c, a] = await Promise.all([
        window.harness2.settingsGetPreferences(),
        window.harness2.settingsGetConfig(),
        window.harness2.settingsGetAuthMasked(),
      ]);
      setPrefs(p);
      setCfg(c);
      setAuth(a);
    } catch (e) {
      // 数据载入失败：保持上次状态
      console.error('settings load error', e);
    }
  }, []);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  /** 偏好持久化（全量对象写回；prefs 未载入时不写，避免把未读到的字段刷成默认值） */
  const savePrefsPatch = (patch: Partial<SettingsPreferencesShape>): void => {
    if (prefs === null) {
      setPrefsNote('偏好尚未载入，改动未保存');
      return;
    }
    setPrefsNote(null);
    const next: SettingsPreferencesShape = { ...prefs, ...patch };
    void window.harness2
      .settingsSetPreferences(next)
      .then((saved) => setPrefs(saved))
      .catch((e: Error) => setPrefsNote(`偏好保存失败：${e.message}`));
  };

  const selectTheme = (t: SettingsTheme): void => {
    onThemeChange(t); // 宿主：立即呈现（P4 setShellTheme → D-15 四要素）
    savePrefsPatch({ theme: t });
  };

  const selectNotifyDetails = (d: SettingsNotifyDetails): void => {
    savePrefsPatch({ notifyDetails: d });
  };

  const saveCfg = async (patch: Record<string, unknown>): Promise<void> => {
    const res = await window.harness2.settingsUpdateConfig(patch);
    if (!res.ok) throw new Error(res.error ?? '保存失败');
    if (res.config !== undefined) setCfg(res.config);
  };

  const saveAuth = async (patch: Record<string, unknown>): Promise<void> => {
    const res = await window.harness2.settingsUpdateAuth(patch);
    if (!res.ok) throw new Error(res.error ?? '保存失败');
    setAuth(await window.harness2.settingsGetAuthMasked());
  };

  // B 棒模型页的接入面：注册进 MODELS_SECTION_ID 即接管（props 契约见 models-contract.ts）。
  // 未注册 → 显式占位 + 过渡面板（不 import 不存在的路径，不造假实现）。
  const modelsContribution = findSettingsSection(MODELS_SECTION_ID);

  const sections: readonly SettingsSectionDefinition[] = useMemo(() => {
    const ModelsComponent = modelsContribution?.component;
    const modelsProps: ModelsSettingsProps = {
      active: true,
      ...(cfg !== null ? { config: cfg } : {}),
      onSaveConfig: saveCfg,
      ...(modelsContribution?.props ?? {}),
    };
    return [
      {
        id: 'general',
        label: '通用',
        en: 'General',
        owner: 'ui-settings-general',
        order: 0,
        render: () => (
          <GeneralSettings
            theme={theme}
            onSelectTheme={selectTheme}
            notifyDetails={prefs?.notifyDetails ?? 'minimal'}
            onSelectNotifyDetails={selectNotifyDetails}
            loaded={prefs !== null}
            note={prefsNote}
          />
        ),
      },
      {
        id: MODELS_SECTION_ID,
        label: '模型配置',
        en: 'Models',
        owner: modelsContribution?.owner ?? MODELS_SETTINGS_OWNER,
        order: 10,
        render: () =>
          ModelsComponent !== undefined ? (
            <ModelsComponent {...modelsProps} />
          ) : cfg !== null ? (
            <ModelsTransitionSection cfg={cfg} onSave={saveCfg} />
          ) : (
            <LoadingPane />
          ),
      },
      {
        id: 'credentials',
        label: '凭据',
        en: 'Credentials',
        owner: 'ui-settings',
        order: 20,
        render: () =>
          cfg !== null && auth !== null ? (
            <CredentialsSection cfg={cfg} auth={auth} onSaveCfg={saveCfg} onSaveAuth={saveAuth} />
          ) : (
            <LoadingPane />
          ),
      },
      {
        id: 'approval',
        label: '审批与安全',
        en: 'Approval & Security',
        owner: 'ui-settings',
        order: 30,
        render: () => (cfg !== null ? <ApprovalSettingsSection cfg={cfg} onSave={saveCfg} /> : <LoadingPane />),
      },
      {
        id: 'memory',
        label: '记忆',
        en: 'Memory',
        owner: 'ui-settings',
        order: 40,
        render: () => (cfg !== null ? <MemorySection cfg={cfg} onSave={saveCfg} /> : <LoadingPane />),
      },
      {
        id: 'browser',
        label: '浏览器工具',
        en: 'Browser',
        owner: 'ui-settings',
        order: 50,
        render: () => (cfg !== null ? <BrowserSection cfg={cfg} onSave={saveCfg} /> : <LoadingPane />),
      },
      { id: 'cron', label: '定时任务', en: 'Cron', owner: 'ui-settings', order: 60, render: () => <CronSection /> },
      {
        id: 'plugins',
        label: '插件与集成',
        en: 'Plugins & MCP',
        owner: 'ui-settings',
        order: 70,
        render: () => (cfg !== null ? <PluginsSection cfg={cfg} /> : <LoadingPane />),
      },
      {
        id: 'subagent',
        label: '子代理',
        en: 'Subagent',
        owner: 'ui-settings',
        order: 80,
        render: () => (cfg !== null ? <SubagentSection cfg={cfg} onSave={saveCfg} /> : <LoadingPane />),
      },
      {
        id: 'sessions',
        label: '会话与数据',
        en: 'Sessions & Data',
        owner: 'ui-settings',
        order: 90,
        render: () => <SessionsSection />,
      },
      {
        id: 'diagnostics',
        label: '诊断',
        en: 'Diagnostics',
        owner: 'ui-settings',
        order: 100,
        render: () => <DiagnosticsSection />,
      },
      {
        id: 'shortcuts',
        label: '快捷键',
        en: 'Keyboard Shortcuts',
        owner: 'ui-settings',
        order: 110,
        render: () => <ShortcutsSection />,
      },
      { id: 'about', label: '关于', en: 'About', owner: 'ui-settings', order: 120, render: () => <AboutSection /> },
    ];
    // 分区渲染闭包捕获上述数据/回调；数据未变时不重建分区表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs, cfg, auth, theme, prefsNote, modelsContribution]);

  return <SettingsShell open={open} onClose={onClose} sections={sections} />;
}
