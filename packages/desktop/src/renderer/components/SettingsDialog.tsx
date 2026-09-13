// 设置弹窗（B2）：居中 dialog + 左侧 14 类导航 + 右侧内容区。
// 数据读取一律经 window.harness2 的 settings:* IPC（渲染进程零 Node，不碰文件系统）。
// 第 1/2/13/14 类纯本地/静态（desktop-preferences.json）；第 3/4/6/9/10 类真实读写
// config.json/auth.json（与 CLI 共用同一份）；复杂类（记忆待审批/插件/MCP/定时/诊断细化）
// 先只读展示并标注「完整管理功能见后续版本」。
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  SettingsAuthMaskedShape,
  SettingsConfigShape,
  SettingsCrashReportShape,
  SettingsDoctorCheck,
  SettingsDoctorReportShape,
  SettingsPreferencesShape,
  SettingsTheme,
} from '../../shared/protocol.js';

type NotifyDetails = 'minimal' | 'full';

interface SettingsCategory {
  id: string;
  label: string;
  en: string;
}

const CATEGORIES: SettingsCategory[] = [
  { id: 'general', label: '通用', en: 'General' },
  { id: 'appearance', label: '外观', en: 'Appearance' },
  { id: 'providers', label: '模型与角色', en: 'Providers & Models' },
  { id: 'approval', label: '审批与安全', en: 'Approval & Security' },
  { id: 'memory', label: '记忆', en: 'Memory' },
  { id: 'browser', label: '浏览器工具', en: 'Browser' },
  { id: 'cron', label: '定时任务', en: 'Cron' },
  { id: 'plugins', label: '插件与集成', en: 'Plugins & MCP' },
  { id: 'subagent', label: '子代理', en: 'Subagent' },
  { id: 'gateway', label: 'IM 网关', en: 'Gateway' },
  { id: 'sessions', label: '会话与数据', en: 'Sessions & Data' },
  { id: 'diagnostics', label: '诊断', en: 'Diagnostics' },
  { id: 'shortcuts', label: '快捷键', en: 'Keyboard Shortcuts' },
  { id: 'about', label: '关于', en: 'About' },
];

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

// —— 子组件：每类一个小节，接收数据 + 保存回调 ——

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="settings-section">
      <h3>{title}</h3>
      {desc !== undefined && <p className="settings-desc">{desc}</p>}
      {children}
    </div>
  );
}

function GeneralSection({
  prefs,
  onSave,
}: {
  prefs: SettingsPreferencesShape;
  onSave: (p: SettingsPreferencesShape) => Promise<void>;
}) {
  const [count, setCount] = useState(prefs.defaultPaneCount);
  const [notify, setNotify] = useState<NotifyDetails>(prefs.notifyDetails);
  const save = (): Promise<void> => onSave({ ...prefs, defaultPaneCount: count, notifyDetails: notify });
  return (
    <>
      <Section title="启动默认分栏数" desc="新建会话自动打入的分栏数（1..3）">
        <div className="settings-row">
          {[1, 2, 3].map((n) => (
            <button key={n} type="button" className={`seg${count === n ? ' seg-on' : ''}`} onClick={() => setCount(n)}>
              {n} 栏
            </button>
          ))}
        </div>
      </Section>
      <Section title="通知详情级别" desc="任务完成系统通知里附带的内容粒度（仅影响桌面通知文案）">
        <div className="settings-row">
          <button
            type="button"
            className={`seg${notify === 'minimal' ? ' seg-on' : ''}`}
            onClick={() => setNotify('minimal')}
          >
            精简（仅标题）
          </button>
          <button
            type="button"
            className={`seg${notify === 'full' ? ' seg-on' : ''}`}
            onClick={() => setNotify('full')}
          >
            完整（含回复摘要）
          </button>
        </div>
      </Section>
      <Section title="发送快捷键">
        <p className="settings-desc">Enter 发送 · Shift+Enter 换行 · Ctrl+K 命令面板 · Ctrl+, 打开本设置</p>
      </Section>
      <button type="button" className="btn-primary" onClick={() => void save()}>
        保存偏好
      </button>
    </>
  );
}

function AppearanceSection({
  prefs,
  onSave,
}: {
  prefs: SettingsPreferencesShape;
  onSave: (p: SettingsPreferencesShape) => Promise<void>;
}) {
  const themes: Array<{ value: SettingsTheme; label: string }> = [
    { value: 'warmPaper', label: '暖纸浅色' },
    { value: 'dark', label: '深色' },
    { value: 'system', label: '跟随系统' },
  ];
  return (
    <Section title="主题" desc="切换即时生效，无需重启应用">
      <div className="settings-row">
        {themes.map((t) => (
          <button
            key={t.value}
            type="button"
            className={`seg${prefs.theme === t.value ? ' seg-on' : ''}`}
            onClick={() => void onSave({ ...prefs, theme: t.value })}
          >
            {t.label}
          </button>
        ))}
      </div>
    </Section>
  );
}

function ProvidersSection({
  cfg,
  onSave,
}: {
  cfg: SettingsConfigShape;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
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
    <Section title="模型与角色" desc="channel 列表与 roles 映射（config.json 同一份，与 CLI 共用）">
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
    </Section>
  );
}

function ApprovalSection({
  cfg,
  onSave,
}: {
  cfg: SettingsConfigShape;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [mode, setMode] = useState(cfg.approval.mode);
  const [feedback, setFeedback] = useState<string | null>(null);
  const apply = (): void => {
    void onSave({ approval: { mode } })
      .then(() => setFeedback('已保存'))
      .catch((e: Error) => setFeedback(e.message));
  };
  return (
    <Section title="审批模式" desc="与 CLI config.json 的 approval.mode 同一字段">
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
        <Section title="工具级规则（只读展示）" desc="按工具粒度 allow/ask/deny，见 config.json approval.tools">
          <div className="settings-table">
            {Object.entries(cfg.approval.tools).map(([tool, rule]) => (
              <div key={tool} className="settings-table-row">
                <span className="row-key">{tool}</span>
                <span className="row-val">{rule}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
      <div className="settings-row">
        <button type="button" className="btn-primary" onClick={apply}>
          保存
        </button>
        {feedback !== null && <span className="settings-feedback">{feedback}</span>}
      </div>
    </Section>
  );
}

function MemorySection({
  cfg,
  onSave,
}: {
  cfg: SettingsConfigShape;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [mode, setMode] = useState(cfg.memory.mode);
  const [interval, setInterval] = useState(String(cfg.memory.nudgeInterval));
  const apply = (): void => {
    const n = Number(interval);
    if (!Number.isInteger(n) || n < 1 || n > 1000) return;
    void onSave({ memory: { mode, nudgeInterval: n } });
  };
  return (
    <>
      <Section title="记忆模式" desc="off/ask/auto 三态（memory.mode）">
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
      </Section>
      <Section title="复盘提醒间隔" desc="nudgeInterval（分钟，1..1000）">
        <input
          className="settings-input"
          type="number"
          min={1}
          max={1000}
          value={interval}
          onChange={(e) => setInterval(e.target.value)}
        />
      </Section>
      <Section title="待审批记忆" desc="ask 模式下的暂存条目可在 CLI 中用 harness2 memory pending 查看与审批">
        <p className="settings-note">
          完整管理功能见后续版本（当前经 CLI：harness2 memory pending / approve / reject）
        </p>
      </Section>
      <button type="button" className="btn-primary" onClick={apply}>
        保存
      </button>
    </>
  );
}

function BrowserSection({
  cfg,
  onSave,
}: {
  cfg: SettingsConfigShape;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
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
      <Section title="浏览器工具" desc="browser_navigate / browser_snapshot 等浏览器工具">
        <label className="settings-check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用浏览器工具
        </label>
      </Section>
      <Section title="最大并发数" desc="maxConcurrent（1..8）">
        <input
          className="settings-input"
          type="number"
          min={1}
          max={8}
          value={max}
          onChange={(e) => setMax(e.target.value)}
        />
      </Section>
      <Section title="空闲销毁时长" desc="idleDestroyMs（毫秒，≥1000）">
        <input
          className="settings-input"
          type="number"
          min={1000}
          value={idle}
          onChange={(e) => setIdle(e.target.value)}
        />
      </Section>
      <button type="button" className="btn-primary" onClick={apply}>
        保存
      </button>
    </>
  );
}

function CronSection() {
  return (
    <Section title="定时任务" desc="cron 任务由 CLI 命令管理（harness2 cron add/remove/list）">
      <p className="settings-note">桌面端可视化任务管理见后续版本；当前请在 CLI 中配置定时任务。</p>
    </Section>
  );
}

function PluginsSection({ cfg }: { cfg: SettingsConfigShape }) {
  const mcpNames = Object.keys(cfg.mcpServers);
  return (
    <>
      <Section title="已装插件" desc="config.json plugins.allow 白名单">
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
      </Section>
      <Section title="MCP 服务器" desc="config.json mcpServers（stdio / streamable HTTP）">
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
      </Section>
    </>
  );
}

function SubagentSection({
  cfg,
  onSave,
}: {
  cfg: SettingsConfigShape;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
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
      <Section title="子代理深度" desc="maxDepth（1..10）">
        <input
          className="settings-input"
          type="number"
          min={1}
          max={10}
          value={maxDepth}
          onChange={(e) => setMaxDepth(e.target.value)}
        />
      </Section>
      <Section title="子代理最大步数" desc="maxTurns（1..200）">
        <input
          className="settings-input"
          type="number"
          min={1}
          max={200}
          value={maxTurns}
          onChange={(e) => setMaxTurns(e.target.value)}
        />
      </Section>
      <Section title="子代理模型" desc="roles.subagent 的 channel / model（可在 CLI 配置文件调整）">
        <p className="settings-desc">
          channel: {cfg.roles['subagent']?.channel ?? '未配置'} · model: {cfg.roles['subagent']?.model ?? '未配置'}
        </p>
      </Section>
      <button type="button" className="btn-primary" onClick={apply}>
        保存
      </button>
    </>
  );
}

function GatewaySection({
  cfg,
  auth,
  onSaveCfg,
  onSaveAuth,
}: {
  cfg: SettingsConfigShape;
  auth: SettingsAuthMaskedShape;
  onSaveCfg: (patch: Record<string, unknown>) => Promise<void>;
  onSaveAuth: (patch: Record<string, unknown>) => Promise<void>;
}) {
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
    <Section title="IM 网关" desc="QQ / 飞书凭据写 auth.json（只显示掩码），私聊/群策略写 config.json">
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
    </Section>
  );
}

function SessionsSection() {
  return (
    <>
      <Section title="会话与数据" desc="会话以事件溯源日志存储在本地">
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
      </Section>
    </>
  );
}

function DiagnosticsSection() {
  const [report, setReport] = useState<SettingsDoctorReportShape | null>(null);
  const [crashes, setCrashes] = useState<SettingsCrashReportShape[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (): void => {
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
  };
  useEffect(run, []); // eslint-disable-line react-hooks/exhaustive-deps
  const statusLabel: Record<SettingsDoctorCheck['status'], string> = { ok: 'OK', warn: 'WARN', fail: 'FAIL' };
  return (
    <>
      <Section title="doctor 六项检查" desc="复用内核 runDoctor（node/config/home/mcp/sessions/skills）">
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
      </Section>
      <Section title="崩溃报告" desc="~/.harness2/crash/（本地，无遥测）">
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
      </Section>
    </>
  );
}

function ShortcutsSection() {
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
    <Section title="快捷键" desc="只读列表">
      <div className="settings-table">
        {rows.map(([k, d]) => (
          <div key={k} className="settings-table-row">
            <span className="row-key mono">{k}</span>
            <span className="row-val">{d}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function AboutSection() {
  return (
    <>
      <Section title="harness2 桌面端" desc="事件溯源 · 单写者 · 崩溃一致 · 仅本地无遥测">
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
      </Section>
    </>
  );
}

// —— 主弹窗 ——

export function SettingsDialog({
  open,
  onClose,
  onThemeChange,
}: {
  open: boolean;
  onClose: () => void;
  onThemeChange: (t: SettingsTheme) => void;
}) {
  const [active, setActive] = useState('general');
  const [prefs, setPrefs] = useState<SettingsPreferencesShape | null>(null);
  const [cfg, setCfg] = useState<SettingsConfigShape | null>(null);
  const [auth, setAuth] = useState<SettingsAuthMaskedShape | null>(null);

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

  const savePrefs = async (next: SettingsPreferencesShape): Promise<void> => {
    const saved = await window.harness2.settingsSetPreferences(next);
    setPrefs(saved);
    if (saved.theme !== prefs?.theme) onThemeChange(saved.theme);
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

  const sections: Record<string, React.ReactNode> = useMemo(
    () => ({
      general: prefs !== null ? <GeneralSection key="g" prefs={prefs} onSave={savePrefs} /> : <LoadingPane />,
      appearance: prefs !== null ? <AppearanceSection key="a" prefs={prefs} onSave={savePrefs} /> : <LoadingPane />,
      providers: cfg !== null ? <ProvidersSection key="p" cfg={cfg} onSave={saveCfg} /> : <LoadingPane />,
      approval: cfg !== null ? <ApprovalSection key="ap" cfg={cfg} onSave={saveCfg} /> : <LoadingPane />,
      memory: cfg !== null ? <MemorySection key="m" cfg={cfg} onSave={saveCfg} /> : <LoadingPane />,
      browser: cfg !== null ? <BrowserSection key="b" cfg={cfg} onSave={saveCfg} /> : <LoadingPane />,
      cron: <CronSection key="c" />,
      plugins: cfg !== null ? <PluginsSection key="pl" cfg={cfg} /> : <LoadingPane />,
      subagent: cfg !== null ? <SubagentSection key="s" cfg={cfg} onSave={saveCfg} /> : <LoadingPane />,
      gateway:
        cfg !== null && auth !== null ? (
          <GatewaySection key="g2" cfg={cfg} auth={auth} onSaveCfg={saveCfg} onSaveAuth={saveAuth} />
        ) : (
          <LoadingPane />
        ),
      sessions: <SessionsSection key="se" />,
      diagnostics: <DiagnosticsSection key="d" />,
      shortcuts: <ShortcutsSection key="k" />,
      about: <AboutSection key="ab" />,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefs, cfg, auth, active],
  );

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-dialog" role="dialog" aria-label="设置" onClick={(e) => e.stopPropagation()}>
        <div className="settings-nav">
          <div className="settings-nav-title">设置</div>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`settings-nav-item${active === c.id ? ' on' : ''}`}
              onClick={() => setActive(c.id)}
            >
              <span className="nav-cn">{c.label}</span>
              <span className="nav-en">{c.en}</span>
            </button>
          ))}
        </div>
        <div className="settings-content">
          <div className="settings-content-head">
            <span className="settings-head-title">{CATEGORIES.find((c) => c.id === active)?.label}</span>
            <button type="button" className="btn-close" onClick={onClose} aria-label="关闭">
              ✕
            </button>
          </div>
          <div className="settings-body">{sections[active]}</div>
        </div>
      </div>
    </div>
  );
}

function LoadingPane() {
  return <div className="settings-desc">加载中…</div>;
}
