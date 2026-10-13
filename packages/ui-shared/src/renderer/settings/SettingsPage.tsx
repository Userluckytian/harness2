// 设置页（Z5「设置页」；B2 → P6-C → Z-88 演进：弹窗 → **全屏设置页**）。
// Z7：自 desktop `renderer/components/SettingsPage.tsx` 下沉 ui-shared，数据/能力**全部经 SettingsPorts
// 注入**（不 import 任何壳的桥 / 不读 window.harness2）。各壳只做端口实现（desktop = settings:* IPC；
// web = serve HTTP + 本地外观运行时），设置页本体唯一一份。
//
// 结构（Z-88/Z-89/Z-90 对应物）：
//   壳与内容槽 → `settings/shell`（全屏页骨架 + 分组导航 + 按需挂载 + 能力模块注入面）；
//   分区配置表 → `settings/page-config`（Z-89 数据驱动：只有真实数据的分区才进表）；
//   常规设置   → `settings/general`；外观设置 → `settings/appearance`（Z-90）；
//   模型配置   → `ui-settings-models`（按 props 契约接 `ModelsSettings`；未落地时显式占位 + 过渡面板）；
//   网关 / IM  → `settings/gateway`（Z7：config.gateways + auth.json 掩码凭据）；
//   其余既有分区 → 本文件内（读写经端口注入；缺失即如实降级）。
//
// 主题呈现：选择经端口 onSelectTheme（宿主 → D-15 四要素立即生效），再持久化偏好；
// 字号呈现：提交经端口 onUiFontSizeCommit（宿主写根 --ui-font-size + 例外 #2 持久化）。
// 本文件不自己碰 DOM、不自己碰壳 store。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  SettingsAuthMaskedShape,
  SettingsConfigShape,
  SettingsCrashReportShape,
  SettingsDoctorCheck,
  SettingsDoctorReportShape,
  SettingsNotifyDetails,
  SettingsPreferencesShape,
} from '../../shared/settings.js';
import { UI_FONT_SIZE_DEFAULT } from '../theme/ui-font-size.js';
import {
  applyCodePreferences,
  codePreferencesFromSettings,
  codePreferencesToSettingsPatch,
  hydrateCodePreferences,
  useCodePreferences,
  type CodePreferences,
} from '../code/index.js';
import { AppearanceSettings } from './appearance/index.js';
import { GeneralSettings } from './general/index.js';
import { GatewaySection, GatewayUnavailable } from './gateway/GatewaySection.js';
import { McpServersSection } from './mcp/McpServersSection.js';
import { HooksSection } from './hooks/HooksSection.js';
import { SkillsSection } from './skills/SkillsSection.js';
import {
  MODELS_SECTION_ID,
  SettingsSectionBlock,
  SettingsShell,
  findSettingsSection,
  type ModelsSettingsProps,
  type SettingsSectionDefinition,
} from './shell/index.js';
import { SETTINGS_SECTION_META } from './page-config.js';
import { SettingsPortsProvider, type SettingsPorts } from './ports.js';

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

/** 版本号（About 分区与左栏页脚共用同一事实；ZCode 页脚是账号菜单，我们无账号体系） */
const APP_VERSION_LABEL = 'v1.0.0';

/** 快捷键表一行（键位 + 说明；按壳注入） */
export interface SettingsShortcutRow {
  readonly keys: string;
  readonly label: string;
}

/**
 * 缺省快捷键表（**两壳共同**的真绑定：Ctrl/Cmd+K 命令面板、Ctrl/Cmd+N 新建会话、Ctrl/Cmd+J 终端开合）。
 * 刻意**不含**仅桌面存在的 `Ctrl+,`（打开设置）与开发者工具，也不含未绑定的 `Ctrl+F`
 * （两壳均无该 keydown 处理，故不列 —— 见 App.tsx 的全局键位监听）。
 */
export const DEFAULT_SHORTCUT_ROWS: readonly SettingsShortcutRow[] = [
  { keys: 'Enter', label: '发送当前消息' },
  { keys: 'Shift+Enter', label: '换行（不发送）' },
  { keys: 'Ctrl+K / Cmd+K', label: '命令面板' },
  { keys: 'Ctrl+N / Cmd+N', label: '新建会话' },
  { keys: 'Ctrl+J / Cmd+J', label: '切换终端面板' },
];

/** 缺省定时任务说明（中性且为事实；桌面/web 各自可覆盖更贴合本壳的呈现） */
export const DEFAULT_CRON_NOTE =
  '侧栏「自动化」进入主区视图，可查看定时任务与「定时任务模板」；定时任务由 CLI 命令管理（harness2 cron add/remove/list）。';

/**
 * 按壳注入的措辞（Z-措辞纠偏）：桌面与 web 的**真实情形不同**（偏好文件、打开设置键位、
 * 快捷键表、关于标题、定时任务呈现），故由各壳注入；**缺省必须是中性且正确的**（不在缺省里再写 desktop 专属事实）。
 */
export interface SettingsCopy {
  /** 关于分区标题（缺省「harness2」；桌面「harness2 桌面端」/ web「harness2 Web」） */
  readonly aboutTitle?: string;
  /** 偏好文件 / 存储介质措辞（缺省「本机偏好文件」） */
  readonly preferencesFileLabel?: string;
  /** 「打开本设置」键位提示（缺省不显示；桌面注入 'Ctrl+,'，web 未绑定则不传） */
  readonly openSettingsKeys?: string;
  /** 快捷键表行（缺省 = DEFAULT_SHORTCUT_ROWS：两壳共同真绑定） */
  readonly shortcutRows?: readonly SettingsShortcutRow[];
  /** 定时任务分区说明（缺省 = DEFAULT_CRON_NOTE） */
  readonly cronNote?: string;
}

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
        desc="该分区已按 props 契约预留（组件名 ModelsSettings，见 settings/shell/models-contract.ts）"
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

// —— 分区：审批与安全 / 记忆 / 浏览器 / 定时任务 / 插件 / 子代理 / 会话 / 诊断 / 快捷键 / 关于 ——

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

function CronSection({ note }: { note?: string }): React.ReactNode {
  return (
    <SettingsSectionBlock title="定时任务" desc="cron 任务由 CLI 命令管理（harness2 cron add/remove/list）">
      <p className="settings-note">{note ?? DEFAULT_CRON_NOTE}</p>
    </SettingsSectionBlock>
  );
}

function PluginsSection({ cfg }: { cfg: SettingsConfigShape }): React.ReactNode {
  return (
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

function DiagnosticsSection({
  runDoctor,
  listCrashes,
}: {
  runDoctor?: (() => Promise<SettingsDoctorReportShape>) | undefined;
  listCrashes?: (() => Promise<SettingsCrashReportShape[]>) | undefined;
}): React.ReactNode {
  const [report, setReport] = useState<SettingsDoctorReportShape | null>(null);
  const [crashes, setCrashes] = useState<SettingsCrashReportShape[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = runDoctor !== undefined || listCrashes !== undefined;
  const run = useCallback((): void => {
    setLoading(true);
    setError(null);
    if (runDoctor !== undefined) {
      void runDoctor()
        .then((r) => setReport(r))
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false));
    } else {
      setError('此壳未提供诊断数据通道（getDoctorReport）');
      setLoading(false);
    }
    if (listCrashes !== undefined)
      void listCrashes()
        .then(setCrashes)
        .catch(() => {});
  }, [runDoctor, listCrashes]);
  useEffect(run, [run]);
  const statusLabel: Record<SettingsDoctorCheck['status'], string> = { ok: 'OK', warn: 'WARN', fail: 'FAIL' };
  if (!available) {
    return (
      <SettingsSectionBlock title="诊断" desc="本壳未提供诊断数据通道">
        <p className="settings-desc" data-diagnostics-unavailable>
          此壳未提供 doctor / 崩溃报告通道（getDoctorReport / getCrashReports）——不摆假结果。
        </p>
      </SettingsSectionBlock>
    );
  }
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

function ShortcutsSection({ rows }: { rows: readonly SettingsShortcutRow[] }): React.ReactNode {
  return (
    <SettingsSectionBlock title="快捷键" desc="只读列表；仅列本壳**真实绑定**的键位">
      <div className="settings-table">
        {rows.map((r) => (
          <div key={`${r.keys}\u0000${r.label}`} className="settings-table-row">
            <span className="row-key mono">{r.keys}</span>
            <span className="row-val">{r.label}</span>
          </div>
        ))}
      </div>
    </SettingsSectionBlock>
  );
}

function AboutSection({ title }: { title: string }): React.ReactNode {
  return (
    <SettingsSectionBlock title={title} desc="事件溯源 · 单写者 · 崩溃一致 · 仅本地无遥测">
      <div className="settings-table">
        <div className="settings-table-row">
          <span className="row-key">版本</span>
          <span className="row-val">{APP_VERSION_LABEL}</span>
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

/** 配置/数据读失败的如实错误态（红线⑩：不谎称成功、不假装空数据、不停在「加载中…」） */
function LoadErrorPane({ message }: { message: string }): React.ReactNode {
  return (
    <SettingsSectionBlock title="数据载入失败" desc="配置读取出错——分区内容不可用，如实报错">
      <p className="settings-warn" data-settings-load-error>
        无法读取设置数据：{message}
      </p>
      <p className="settings-note">排查：确认 serve / 主进程可用后重开设置页；错误原文如上，未做任何掩饰。</p>
    </SettingsSectionBlock>
  );
}

/** 数据面不可用时的如实占位（缺端口 = 该壳未提供，不摆假控件） */
function UnavailablePane({ what }: { what: string }): React.ReactNode {
  return (
    <SettingsSectionBlock title="数据面不可用" desc={`此壳未提供 ${what}`}>
      <p className="settings-desc" data-settings-unavailable>
        此壳未提供 {what} 通道——分区内容如实为空，不摆假控件。
      </p>
    </SettingsSectionBlock>
  );
}

export interface SettingsPageProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 数据 / 能力端口面（各壳注入；缺失成员 = 如实降级） */
  readonly ports: SettingsPorts;
  /**
   * 本次打开要落到的分区 id（Z3-04：composer「管理模型」直达模型配置页）。
   * 只在**打开时**生效（调用方配 key 重挂载让壳采纳）；undefined = 跟随壳默认分区。
   */
  readonly defaultSectionId?: string;
  /**
   * 按壳注入的措辞（Z-措辞纠偏；缺省 = 中性且正确，见 `SettingsCopy`）。
   * 桌面 / web 各自传自身真实情形，避免在共享页写死某壳专属事实。
   */
  readonly copy?: SettingsCopy;
}

export function SettingsPage({ open, onClose, ports, defaultSectionId, copy }: SettingsPageProps): React.ReactNode {
  const [prefs, setPrefs] = useState<SettingsPreferencesShape | null>(null);
  const [cfg, setCfg] = useState<SettingsConfigShape | null>(null);
  const [auth, setAuth] = useState<SettingsAuthMaskedShape | null>(null);
  const [prefsNote, setPrefsNote] = useState<string | null>(null);
  /** 数据载入失败的可读错误（红线⑩）：非 null 时 cfg 相关分区显示错误态而非停留在「加载中…」 */
  const [loadError, setLoadError] = useState<string | null>(null);

  // 端口面经 ref 读取：宿主每次渲染可传新对象而不触发重载循环（只在 open 变化时重新取数）。
  const portsRef = useRef(ports);
  portsRef.current = ports;

  // 外观真源：宿主注入（桌面 = 壳主题 store + ui-font-size 运行时；web = 本地主题/字号运行时）。
  const theme = ports.theme ?? 'system';
  const uiFontSize = ports.uiFontSize ?? UI_FONT_SIZE_DEFAULT;
  // 代码偏好真源：共享运行时 store（Z10-7）——订阅它，设置卡/预览卡随 store 变化即时重渲。
  const codePreferences = useCodePreferences();

  // 措辞真源：宿主注入的 copy（缺省中性且正确，不含任何壳专属事实）。
  const aboutTitle = copy?.aboutTitle ?? 'harness2';
  const shortcutRows = copy?.shortcutRows ?? DEFAULT_SHORTCUT_ROWS;

  const reload = useCallback(async () => {
    const p = portsRef.current;
    try {
      const [pr, c, a] = await Promise.all([
        p.getPreferences?.() ?? Promise.resolve(null),
        p.getConfig?.() ?? Promise.resolve(null),
        p.getAuthMasked?.() ?? Promise.resolve(null),
      ]);
      if (pr !== null) {
        setPrefs(pr);
        // Z10-7：把持久化偏好灌进代码偏好运行时 store（查看器/预览卡即时消费；缺省字段回落默认）。
        // 用 hydrate（不镜像浏览器本地存储）：加载路径不写第二个存储 key，只有用户显式改动才镜像。
        hydrateCodePreferences(codePreferencesFromSettings(pr));
      }
      if (c !== null) setCfg(c);
      if (a !== null) setAuth(a);
      setLoadError(null);
    } catch (e) {
      // 数据载入失败：把错误暴露到界面（分区级错误态），不再只 console.error 后停留在「加载中…」
      console.error('settings load error', e);
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  /** 偏好持久化（全量对象写回；端口缺失 / prefs 未载入时不写，避免把未读到的字段刷成默认值） */
  const savePrefsPatch = (patch: Partial<SettingsPreferencesShape>): void => {
    const setFn = portsRef.current.setPreferences;
    if (setFn === undefined || prefs === null) {
      setPrefsNote('偏好通道不可用，改动未保存');
      return;
    }
    setPrefsNote(null);
    const next: SettingsPreferencesShape = { ...prefs, ...patch };
    void setFn(next)
      .then((saved) => setPrefs(saved))
      .catch((e: Error) => setPrefsNote(`偏好保存失败：${e.message}`));
  };

  const selectTheme = (t: SettingsPageProps['ports']['theme']): void => {
    if (t === undefined) return;
    portsRef.current.onSelectTheme?.(t); // 宿主：立即呈现（D-15 四要素）
    savePrefsPatch({ theme: t });
  };

  const commitUiFontSize = (px: number): void => {
    portsRef.current.onUiFontSizeCommit?.(px);
  };

  /** Z10-7：代码偏好改动 —— 先写运行时 store（查看器/预览卡即时消费），再经偏好通道持久化。 */
  const changeCodePreferences = (patch: Partial<CodePreferences>): void => {
    const next = applyCodePreferences(patch);
    savePrefsPatch(codePreferencesToSettingsPatch(next));
  };

  const selectNotifyDetails = (d: SettingsNotifyDetails): void => {
    savePrefsPatch({ notifyDetails: d });
  };

  const saveCfg = async (patch: Record<string, unknown>): Promise<void> => {
    const fn = portsRef.current.updateConfig;
    if (fn === undefined) throw new Error('此壳不提供配置写入通道');
    const res = await fn(patch);
    if (!res.ok) throw new Error(res.error ?? '保存失败');
    if (res.config !== undefined) setCfg(res.config);
  };

  const saveAuth = async (patch: Record<string, unknown>): Promise<void> => {
    const fn = portsRef.current.updateAuth;
    if (fn === undefined) throw new Error('此壳不提供凭据写入通道');
    const res = await fn(patch);
    if (!res.ok) throw new Error(res.error ?? '保存失败');
    const masked = portsRef.current.getAuthMasked;
    if (masked !== undefined) setAuth(await masked());
  };

  // B 棒模型页的接入面：注册进 MODELS_SECTION_ID 即接管（props 契约见 shell/models-contract.ts）。
  const modelsContribution = findSettingsSection(MODELS_SECTION_ID);

  // 分区装配：配置表（page-config，数据驱动）提供 id/label/en/group/order/icon；
  // 本装配层只补 render 闭包（内容组件不改内部实现，只换组织）。
  const allow = ports.sectionAllowList;
  const sections: readonly SettingsSectionDefinition[] = useMemo(() => {
    const ownerById: Record<string, string> = {
      general: 'ui-settings-general',
      appearance: 'ui-settings-appearance',
    };
    const ModelsComponent = modelsContribution?.component;
    const modelsProps: ModelsSettingsProps = {
      active: true,
      ...(cfg !== null ? { config: cfg } : {}),
      onSaveConfig: saveCfg,
      ...(modelsContribution?.props ?? {}),
    };
    // cfg 依赖分区的统一门：有数据 → 渲染正文；读失败 → 如实错误态；否则「加载中…」。
    const cfgPane = (render: (c: SettingsConfigShape) => React.ReactNode): React.ReactNode =>
      cfg !== null ? render(cfg) : loadError !== null ? <LoadErrorPane message={loadError} /> : <LoadingPane />;
    const metas =
      allow === undefined ? SETTINGS_SECTION_META : SETTINGS_SECTION_META.filter((m) => allow.includes(m.id));
    return metas.map((meta): SettingsSectionDefinition => {
      const owner = ownerById[meta.id] ?? meta.owner;
      switch (meta.id) {
        case 'general':
          if (ports.setPreferences === undefined) {
            return { ...meta, owner, render: () => <UnavailablePane what="桌面偏好读写" /> };
          }
          return {
            ...meta,
            owner,
            render: () => (
              <GeneralSettings
                notifyDetails={prefs?.notifyDetails ?? 'minimal'}
                onSelectNotifyDetails={selectNotifyDetails}
                loaded={prefs !== null}
                note={prefsNote}
                {...(copy?.preferencesFileLabel !== undefined
                  ? { preferencesFileLabel: copy.preferencesFileLabel }
                  : {})}
                {...(copy?.openSettingsKeys !== undefined ? { openSettingsKeys: copy.openSettingsKeys } : {})}
              />
            ),
          };
        case 'appearance':
          return {
            ...meta,
            owner,
            render: () => (
              <AppearanceSettings
                theme={theme}
                onSelectTheme={selectTheme}
                uiFontSize={uiFontSize}
                onUiFontSizeCommit={commitUiFontSize}
                codePreferences={codePreferences}
                onCodePreferencesChange={changeCodePreferences}
                loaded
                note={prefsNote}
              />
            ),
          };
        case MODELS_SECTION_ID:
          return {
            ...meta,
            owner: modelsContribution?.owner ?? meta.owner,
            render: () =>
              ModelsComponent !== undefined ? (
                <ModelsComponent {...modelsProps} />
              ) : (
                cfgPane((c) => <ModelsTransitionSection cfg={c} onSave={saveCfg} />)
              ),
          };
        case 'approval':
          return { ...meta, render: () => cfgPane((c) => <ApprovalSettingsSection cfg={c} onSave={saveCfg} />) };
        case 'memory':
          return { ...meta, render: () => cfgPane((c) => <MemorySection cfg={c} onSave={saveCfg} />) };
        case 'browser':
          return { ...meta, render: () => cfgPane((c) => <BrowserSection cfg={c} onSave={saveCfg} />) };
        case 'cron':
          return {
            ...meta,
            render: () => <CronSection {...(copy?.cronNote !== undefined ? { note: copy.cronNote } : {})} />,
          };
        case 'plugins':
          return { ...meta, render: () => cfgPane((c) => <PluginsSection cfg={c} />) };
        case 'mcp':
          return { ...meta, render: () => cfgPane((c) => <McpServersSection cfg={c} />) };
        case 'skill':
          return { ...meta, render: () => <SkillsSection /> };
        case 'hooks':
          return { ...meta, render: () => cfgPane((c) => <HooksSection cfg={c} />) };
        case 'subagent':
          return { ...meta, render: () => cfgPane((c) => <SubagentSection cfg={c} onSave={saveCfg} />) };
        case 'gateway':
          return {
            ...meta,
            render: () => {
              if (cfg === null || auth === null) {
                // 无 config/auth 数据面（如 web 未接端口）→ 如实「只读指引」态，不摆假条目/假开关（红线⑩）。
                if (ports.getConfig === undefined || ports.getAuthMasked === undefined) {
                  return <GatewayUnavailable guidance={ports.gatewayGuidance} />;
                }
                // 端口在但读取失败 → 如实错误态（不再停在「加载中…」）
                return loadError !== null ? <LoadErrorPane message={loadError} /> : <LoadingPane />;
              }
              const writeCfg = ports.updateConfig !== undefined ? saveCfg : undefined;
              const writeAuth =
                ports.updateAuth !== undefined
                  ? (patch: Record<string, unknown>): Promise<void> => saveAuth(patch)
                  : undefined;
              return (
                <GatewaySection
                  cfg={cfg}
                  auth={auth}
                  onSaveCfg={writeCfg}
                  onSaveAuth={writeAuth}
                  guidance={ports.gatewayGuidance}
                />
              );
            },
          };
        case 'sessions':
          return { ...meta, render: () => <SessionsSection /> };
        case 'diagnostics':
          return {
            ...meta,
            render: () => <DiagnosticsSection runDoctor={ports.getDoctorReport} listCrashes={ports.getCrashReports} />,
          };
        case 'shortcuts':
          return { ...meta, render: () => <ShortcutsSection rows={shortcutRows} /> };
        case 'about':
          return { ...meta, render: () => <AboutSection title={aboutTitle} /> };
        default:
          throw new Error(`设置分区配置表有未装配的分区: ${String(meta.id)}（先改 SettingsPage 再进表）`);
      }
    });
    // 分区渲染闭包捕获上述数据/回调；数据未变时不重建分区表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs, cfg, auth, theme, uiFontSize, codePreferences, prefsNote, loadError, modelsContribution, allow, copy]);

  // 左栏页脚（Z-88 底部）：ZCode 是账号菜单（仅可用项）；我们无账号体系 → 只放版本号（About 数据）
  const version = ports.versionLabel ?? APP_VERSION_LABEL;
  const footer = (
    <span data-settings-footer-version title={`harness2 ${version}`}>
      {version}
    </span>
  );

  return (
    <SettingsPortsProvider value={ports}>
      <SettingsShell
        open={open}
        onClose={onClose}
        sections={sections}
        footer={footer}
        {...(defaultSectionId !== undefined ? { defaultSectionId } : {})}
      />
    </SettingsPortsProvider>
  );
}
