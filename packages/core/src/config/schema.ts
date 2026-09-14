// 配置契约（v1，本阶段冻结）——纯数据层：schema 校验，不感知文件来源与密钥。
// 红线：密钥只存 auth.json 与环境变量，绝不入 config（这里没有 key 字段，类型层面钉死）。
// 未知字段忽略（记告警）；校验错误消息出口前经 redactSecrets 过滤（纵深防御）。
import { redactSecrets } from './redact.js';
// plugins/types 对本模块只有 type-only 引用（编译期擦除），此处反向引入其名称常量不构成运行时环
import { PLUGIN_NAME_PATTERN } from '../plugins/types.js';

/** 模型条目（仅容量元数据；协议行为由 provider 实现决定） */
export interface ModelEntry {
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** provider 渠道配置（channel） */
export interface ProviderConfig {
  /** openai = OpenAI-compatible（DeepSeek/智谱等）；anthropic = Messages API 原生 */
  protocol: 'openai' | 'anthropic';
  /** openai: {baseUrl}/chat/completions；anthropic: {baseUrl}/v1/messages（不含 /v1） */
  baseUrl: string;
  /** 可选：key 的环境变量名（解析顺序 auth.json > env；缺省时只查 auth.json） */
  envKey?: string;
  /** 可选：渠道可用模型及容量元数据；roles 引用的 model 必须在此声明（若声明了 models） */
  models?: Record<string, ModelEntry>;
}

/** 角色 → 渠道/模型（Tokeny 式 {channelId, model}） */
export interface RoleConfig {
  channel: string;
  model: string;
}

export type ApprovalMode = 'default' | 'acceptEdits' | 'bypass' | 'plan';
export type ApprovalToolRule = 'allow' | 'ask' | 'deny';

/** 审批配置：三 mode + per-tool 规则（per-tool 优先于 mode 推导） */
export interface ApprovalConfig {
  mode?: ApprovalMode;
  /** 未列出的工具按 safe=allow / unsafe=ask 处理（安全集见 approval/policy.ts） */
  tools?: Record<string, ApprovalToolRule>;
}

/**
 * 记忆开关（阶段 6，用户点名三态）：off = 零写入零注入零工具注册（默认，尊重隐私）；
 * ask = 模型写记忆先进 pending 暂存、人工审批后落盘；auto = 直接写入。
 * nudgeInterval = 每 N 个用户 turn 触发一次后台复盘（mode≠off 时生效）。
 */
export type MemoryMode = 'off' | 'ask' | 'auto';

export interface MemoryConfig {
  mode: MemoryMode;
  nudgeInterval: number;
}

export const MEMORY_MODES: readonly MemoryMode[] = ['off', 'ask', 'auto'];
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = { mode: 'off', nudgeInterval: 10 };

/**
 * 浏览器工具配置（阶段 7）：enabled=false 不注册浏览器工具；
 * idleDestroyMs/maxConcurrent 传入 BrowserPool（资源红线默认：空闲 5min 销毁、并发 2）。
 */
export interface BrowserConfig {
  enabled: boolean;
  idleDestroyMs: number;
  maxConcurrent: number;
}

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = { enabled: true, idleDestroyMs: 300_000, maxConcurrent: 2 };

/**
 * bash 工具配置（A1-1）：shell = 显式指定的 shell 可执行文件（最高优先级，覆盖自动探测）。
 * 缺省不指定（undefined）= 自动探测：Windows 优先 Git Bash（GIT_BASH / 常见路径），
 * 找不到回退 cmd.exe；POSIX 走 /bin/sh。值以 cmd/cmd.exe 结尾时按 cmd 口径解释。
 */
export interface BashConfig {
  shell?: string;
}

export const DEFAULT_BASH_CONFIG: BashConfig = {};

/**
 * 插件配置（阶段 8）：enabled = 总开关；allow = 已批准装载的插件名（装载审批结果记录处）。
 * 缺省 allow = []：不审批任何插件不装载（最小授权）；enabled 缺省 true，实际装载仍被
 * allow 门控，故默认安全。
 */
export interface PluginsConfig {
  enabled: boolean;
  allow: string[];
}

export const DEFAULT_PLUGINS_CONFIG: PluginsConfig = { enabled: true, allow: [] };

/**
 * MCP 服务器配置（阶段 8）：stdio（command 子进程）或 url（Streamable HTTP）二选一。
 * 服务器名将拼进 namespaced 工具名 `mcp__<server>__<tool>`，必须满足 ^[a-z0-9_]+$
 * （与工具名约束一致，schema 层提前拦截）。
 */
export interface McpStdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpUrlServerConfig {
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = (McpStdioServerConfig & { command: string }) | (McpUrlServerConfig & { url: string });

/** 缺省 = 无 MCP 服务器（零 MCP 行为） */
export type McpServersConfig = Record<string, McpServerConfig>;

/**
 * Subagent 配置（阶段 8）：maxDepth = 子会话递归深度上限（1 = 子会话内无 subagent 工具）；
 * maxTurns = 子会话单 turn 最大 step 数。roles.subagent 复用既有角色配置选择子会话模型。
 */
export interface SubagentConfig {
  maxDepth: number;
  maxTurns: number;
}

export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = { maxDepth: 1, maxTurns: 25 };

/**
 * IM 网关渠道配置（阶段 9）：DM/群策略三态，缺省 allowlist（防滥用）。
 * appId 非密钥可入 config；appSecret 只存 auth.json.gateways（或 env 经 appSecretEnvKey）。
 */
export type GatewayPolicy = 'open' | 'allowlist' | 'disabled';

export interface GatewayChannelConfig {
  /** 缺省 true：配置了该渠道即视为启用（显式关闭用 false） */
  enabled: boolean;
  /** QQ 开放平台 appid / 飞书 appId（非密钥，可入 config） */
  appId: string;
  /** appSecret 的环境变量名（解析顺序 auth.json.gateways > env；缺省只查 auth.json） */
  appSecretEnvKey?: string;
  /** 私聊策略（缺省 allowlist） */
  dmPolicy: GatewayPolicy;
  /** 群聊策略（缺省 allowlist） */
  groupPolicy: GatewayPolicy;
  /** allowlist 策略生效时的 chat id 白名单（openid/chat_id） */
  allow: string[];
}

export interface GatewaysConfig {
  qq?: GatewayChannelConfig;
  feishu?: GatewayChannelConfig;
}

/** 网关渠道名（与 GATEWAY_CHANNELS 对齐的类型形态） */
export type GatewayChannelName = 'qq' | 'feishu';

/**
 * follow-up 行为（G-26 加性枚举）：回合运行中普通 Enter 的路由——
 * queue = 入队不打断（缺省）；steer = 仍入队展示，但由壳在安全 step 边界经
 * core SessionSteerSink 实时转向注入。取值与 cli 侧 tui/queue/queue.ts 的
 * FOLLOW_UP_BEHAVIORS 同域。
 */
export type FollowUpBehavior = 'queue' | 'steer';

export const FOLLOW_UP_BEHAVIORS: readonly FollowUpBehavior[] = ['queue', 'steer'];

/**
 * 状态行类型（G-42 加性枚举）：builtin = 内置段；command = 外部命令脚本（stdin JSON 契约）；
 * disabled = 关闭（缺省）。off / none / hidden 是 disabled 的同义拼写——schema 归一为
 * 'disabled' 存储（上游 25-status-line.md：「off, none, and hidden are accepted as
 * spellings of disabled」）。
 */
export type StatusLineType = 'builtin' | 'command' | 'disabled';

export const STATUS_LINE_TYPES: readonly StatusLineType[] = ['builtin', 'command', 'disabled'];

/** disabled 的同义拼写（G-42；校验接受、归一为 'disabled'） */
export const STATUS_LINE_DISABLED_SYNONYMS: readonly string[] = ['off', 'none', 'hidden'];

/** 内置状态行条目全集（G-43；items 只能取其中的名字，顺序即渲染顺序） */
export const STATUS_LINE_BUILTIN_ITEMS: readonly string[] = [
  'cwd',
  'model',
  'context',
  'cost',
  'turn-timer',
  'session-name',
];

/** 状态行配置（G-42～G-46 加性段）：字段语义见 refs-grok-build.md G-42～G-49。 */
export interface StatusLineConfig {
  /** builtin / command / disabled（off/none/hidden 归一为 disabled）；缺省 disabled */
  type?: StatusLineType;
  /** builtin 段清单；缺省 ['cwd', 'model', 'context']（G-43） */
  items?: string[];
  /** command 型脚本命令（支持 ~/ 前缀，展开归壳层） */
  command?: string;
  /** 水平每侧留白字符数；>16 钳到 16（G-46「padding 上限 16」），负数报错 */
  padding?: number;
  /** command 型定时刷新秒数；1–86400 整数（G-46），缺省 = 纯事件驱动 */
  refresh_interval?: number;
}

/**
 * UI 渲染配置（P2-C 加性段）：screen_mode = 壳渲染模式初值（fullscreen = 接管屏幕 /
 * minimal = 终端原生滚动，不接管）。取值与 cli 侧 tui/render/mode.ts 钉死的
 * RENDER_MODES 对齐；缺省 fullscreen（壳层缺省语义，schema 不复制缺省常量）。
 * 仅 next 渲染层消费；其余壳忽略（未知段不加告警——段本身已登记）。
 * P3-C 加性：follow_up_behavior（G-26 队列/转向路由）与 status_line（G-42～G-49 状态行）。
 */
export interface UiConfig {
  screen_mode?: 'fullscreen' | 'minimal';
  /** 回合运行中 Enter 的 follow-up 路由（G-26）；缺省 queue（壳层裁定） */
  follow_up_behavior?: FollowUpBehavior;
  /** 状态行配置（G-42～G-49）；缺省 type=disabled 即整行不渲染 */
  status_line?: StatusLineConfig;
}

/**
 * 滚动转录配置（P2-C 加性段）：scroll.respect_manual_folds = 自动折叠是否覆盖手动折叠
 * （缺省 true = 尊重手动折叠；与 cli tui/render/folds.ts 的
 * RESPECT_MANUAL_FOLDS_CONFIG_PATH 同一路径）。仅 next 渲染层消费。
 */
export interface ScrollbackConfig {
  scroll?: { respect_manual_folds?: boolean };
}

/** 合并+校验后的配置（唯一合法形态） */
export interface HarnessConfig {
  providers: Record<string, ProviderConfig>;
  roles: Record<string, RoleConfig>;
  approval: ApprovalConfig;
  memory: MemoryConfig;
  browser: BrowserConfig;
  /** bash 工具配置（A1-1；缺省/未配置 = 自动探测，兼容旧 HarnessConfig 字面量） */
  bash?: BashConfig;
  plugins: PluginsConfig;
  mcpServers: McpServersConfig;
  subagent: SubagentConfig;
  /** IM 网关配置（阶段 9；可选——缺省/未配置 = 零网关行为） */
  gateways?: GatewaysConfig;
  /** UI 渲染配置（P2-C 加性；可选——缺省/未配置 = 壳层缺省 fullscreen） */
  ui?: UiConfig;
  /** 滚动转录配置（P2-C 加性；可选——缺省/未配置 = respect_manual_folds true） */
  scrollback?: ScrollbackConfig;
}

/** 配置错误（工厂/CLI 对其做一行友好输出；消息不携带密钥） */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const APPROVAL_MODES: readonly ApprovalMode[] = ['default', 'acceptEdits', 'bypass', 'plan'];
export const APPROVAL_TOOL_RULES: readonly ApprovalToolRule[] = ['allow', 'ask', 'deny'];
export const PROTOCOLS: readonly ProviderConfig['protocol'][] = ['openai', 'anthropic'];
export const GATEWAY_POLICIES: readonly GatewayPolicy[] = ['open', 'allowlist', 'disabled'];
/** 网关渠道名（qq / feishu；新平台 = 这里加一个名字 + gateway 包新增适配器） */
export const GATEWAY_CHANNELS: readonly string[] = ['qq', 'feishu'];
export const DEFAULT_GATEWAY_CHANNEL: Omit<GatewayChannelConfig, 'appId'> = {
  enabled: true,
  dmPolicy: 'allowlist',
  groupPolicy: 'allowlist',
  allow: [],
};

export interface ConfigParseResult {
  /** 校验通过时为合并后的配置；有任何 error 时为 null */
  config: HarnessConfig | null;
  /** 致命错误（存在即视为配置不可用） */
  errors: string[];
  /** 非致命告警（未知字段、缺省补全、未解析的 ${VAR} 等） */
  warnings: string[];
}

type Dict = Record<string, unknown>;

function isPlainObject(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return isPlainObject(v) && Object.values(v).every((x) => typeof x === 'string');
}

/** schema 内已知的顶层字段（其余忽略并告警） */
const KNOWN_TOP_KEYS = new Set([
  'providers',
  'roles',
  'approval',
  'memory',
  'browser',
  'bash',
  'plugins',
  'mcpServers',
  'subagent',
  'gateways',
  'ui',
  'scrollback',
]);

function collectUnknownKeys(obj: Dict, known: ReadonlySet<string>, where: string, warnings: string[]): void {
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) warnings.push(`${where}: 未知字段 "${k}" 已忽略`);
  }
}

const PROVIDER_KNOWN_KEYS = new Set(['protocol', 'baseUrl', 'envKey', 'models']);
const MODEL_KNOWN_KEYS = new Set(['contextWindow', 'maxOutputTokens']);
const ROLE_KNOWN_KEYS = new Set(['channel', 'model']);
const APPROVAL_KNOWN_KEYS = new Set(['mode', 'tools']);
const MEMORY_KNOWN_KEYS = new Set(['mode', 'nudgeInterval']);
const BROWSER_KNOWN_KEYS = new Set(['enabled', 'idleDestroyMs', 'maxConcurrent']);
const BASH_KNOWN_KEYS = new Set(['shell']);
const PLUGINS_KNOWN_KEYS = new Set(['enabled', 'allow']);
const MCP_SERVER_KNOWN_KEYS = new Set(['command', 'args', 'env', 'cwd', 'url', 'headers']);
const SUBAGENT_KNOWN_KEYS = new Set(['maxDepth', 'maxTurns']);
const GATEWAYS_KNOWN_KEYS = new Set(['qq', 'feishu']);
const GATEWAY_CHANNEL_KNOWN_KEYS = new Set(['enabled', 'appId', 'appSecretEnvKey', 'dmPolicy', 'groupPolicy', 'allow']);
const UI_KNOWN_KEYS = new Set(['screen_mode', 'follow_up_behavior', 'status_line']);
const STATUS_LINE_KNOWN_KEYS = new Set(['type', 'items', 'command', 'padding', 'refresh_interval']);
const SCROLLBACK_KNOWN_KEYS = new Set(['scroll']);
const SCROLLBACK_SCROLL_KNOWN_KEYS = new Set(['respect_manual_folds']);

/**
 * 校验合并后的原始 JSON（展开 ${VAR} 之后的形态），产出 HarnessConfig。
 * 不抛错：错误收集进 errors（调用方决定一行输出 / exit 1）。
 */
export function parseConfig(raw: unknown): ConfigParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isPlainObject(raw)) {
    return { config: null, errors: ['config 根节点必须是对象'], warnings };
  }
  collectUnknownKeys(raw, KNOWN_TOP_KEYS, 'config', warnings);

  // —— providers ——
  const providers: Record<string, ProviderConfig> = {};
  const rawProviders = raw['providers'];
  if (rawProviders === undefined) {
    errors.push('config.providers 缺失');
  } else if (!isPlainObject(rawProviders)) {
    errors.push('config.providers 必须是对象');
  } else {
    for (const [channel, v] of Object.entries(rawProviders)) {
      if (!isPlainObject(v)) {
        errors.push(`providers.${channel} 必须是对象`);
        continue;
      }
      collectUnknownKeys(v, PROVIDER_KNOWN_KEYS, `providers.${channel}`, warnings);
      const protocol = v['protocol'];
      if (typeof protocol !== 'string' || !PROTOCOLS.includes(protocol as ProviderConfig['protocol'])) {
        errors.push(
          `providers.${channel}.protocol 必须是 ${PROTOCOLS.join(' | ')}，实际为 ${JSON.stringify(protocol)}`,
        );
        continue;
      }
      const baseUrl = v['baseUrl'];
      if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
        errors.push(`providers.${channel}.baseUrl 必须是非空字符串`);
        continue;
      }
      const envKey = v['envKey'];
      if (envKey !== undefined && (typeof envKey !== 'string' || envKey.trim() === '')) {
        errors.push(`providers.${channel}.envKey 必须是非空字符串`);
        continue;
      }
      const models: Record<string, ModelEntry> = {};
      const rawModels = v['models'];
      if (rawModels !== undefined) {
        if (!isPlainObject(rawModels)) {
          errors.push(`providers.${channel}.models 必须是对象`);
          continue;
        }
        let modelsOk = true;
        for (const [model, mv] of Object.entries(rawModels)) {
          if (mv === undefined || mv === null) {
            models[model] = {};
            continue;
          }
          if (!isPlainObject(mv)) {
            errors.push(`providers.${channel}.models.${model} 必须是对象`);
            modelsOk = false;
            continue;
          }
          collectUnknownKeys(mv, MODEL_KNOWN_KEYS, `providers.${channel}.models.${model}`, warnings);
          const entry: ModelEntry = {};
          for (const field of ['contextWindow', 'maxOutputTokens'] as const) {
            const num = mv[field];
            if (num === undefined) continue;
            if (typeof num !== 'number' || !Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
              errors.push(`providers.${channel}.models.${model}.${field} 必须是正整数`);
              modelsOk = false;
            } else {
              entry[field] = num;
            }
          }
          if (modelsOk) models[model] = entry;
        }
        if (modelsOk)
          providers[channel] = {
            protocol: protocol as ProviderConfig['protocol'],
            baseUrl,
            ...(envKey !== undefined ? { envKey } : {}),
            models,
          };
      } else {
        providers[channel] = {
          protocol: protocol as ProviderConfig['protocol'],
          baseUrl,
          ...(envKey !== undefined ? { envKey } : {}),
        };
      }
    }
  }

  // —— roles ——
  const roles: Record<string, RoleConfig> = {};
  const rawRoles = raw['roles'];
  if (rawRoles === undefined) {
    errors.push('config.roles 缺失');
  } else if (!isPlainObject(rawRoles)) {
    errors.push('config.roles 必须是对象');
  } else {
    for (const [role, v] of Object.entries(rawRoles)) {
      if (!isPlainObject(v)) {
        errors.push(`roles.${role} 必须是对象`);
        continue;
      }
      collectUnknownKeys(v, ROLE_KNOWN_KEYS, `roles.${role}`, warnings);
      const channel = v['channel'];
      const model = v['model'];
      if (typeof channel !== 'string' || channel.trim() === '') {
        errors.push(`roles.${role}.channel 必须是非空字符串`);
        continue;
      }
      if (typeof model !== 'string' || model.trim() === '') {
        errors.push(`roles.${role}.model 必须是非空字符串`);
        continue;
      }
      roles[role] = { channel, model };
    }
  }

  // —— approval（缺省 = {}，策略层有全缺省语义）——
  const approval: ApprovalConfig = {};
  const rawApproval = raw['approval'];
  if (rawApproval !== undefined) {
    if (!isPlainObject(rawApproval)) {
      errors.push('config.approval 必须是对象');
    } else {
      collectUnknownKeys(rawApproval, APPROVAL_KNOWN_KEYS, 'approval', warnings);
      const mode = rawApproval['mode'];
      if (mode !== undefined) {
        if (typeof mode !== 'string' || !APPROVAL_MODES.includes(mode as ApprovalMode)) {
          errors.push(`approval.mode 必须是 ${APPROVAL_MODES.join(' | ')}，实际为 ${JSON.stringify(mode)}`);
        } else {
          approval.mode = mode as ApprovalMode;
        }
      }
      const tools = rawApproval['tools'];
      if (tools !== undefined) {
        if (!isPlainObject(tools)) {
          errors.push('approval.tools 必须是对象');
        } else {
          approval.tools = {};
          for (const [tool, rule] of Object.entries(tools)) {
            if (typeof rule !== 'string' || !APPROVAL_TOOL_RULES.includes(rule as ApprovalToolRule)) {
              errors.push(
                `approval.tools.${tool} 必须是 ${APPROVAL_TOOL_RULES.join(' | ')}，实际为 ${JSON.stringify(rule)}`,
              );
              continue;
            }
            approval.tools[tool] = rule as ApprovalToolRule;
          }
        }
      }
    }
  }

  // —— memory（缺省 = off，尊重用户默认隐私）——
  const memory: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG };
  const rawMemory = raw['memory'];
  if (rawMemory !== undefined) {
    if (!isPlainObject(rawMemory)) {
      errors.push('config.memory 必须是对象');
    } else {
      collectUnknownKeys(rawMemory, MEMORY_KNOWN_KEYS, 'memory', warnings);
      const mode = rawMemory['mode'];
      if (mode !== undefined) {
        if (typeof mode !== 'string' || !MEMORY_MODES.includes(mode as MemoryMode)) {
          errors.push(`memory.mode 必须是 ${MEMORY_MODES.join(' | ')}，实际为 ${JSON.stringify(mode)}`);
        } else {
          memory.mode = mode as MemoryMode;
        }
      }
      const nudgeInterval = rawMemory['nudgeInterval'];
      if (nudgeInterval !== undefined) {
        if (
          typeof nudgeInterval !== 'number' ||
          !Number.isInteger(nudgeInterval) ||
          nudgeInterval < 1 ||
          nudgeInterval > 1000
        ) {
          errors.push('memory.nudgeInterval 必须是 1..1000 的整数');
        } else {
          memory.nudgeInterval = nudgeInterval;
        }
      }
    }
  }

  // —— browser（缺省 = enabled + 默认资源红线；enabled=false 才完全关闭）——
  const browser: BrowserConfig = { ...DEFAULT_BROWSER_CONFIG };
  const rawBrowser = raw['browser'];
  if (rawBrowser !== undefined) {
    if (!isPlainObject(rawBrowser)) {
      errors.push('config.browser 必须是对象');
    } else {
      collectUnknownKeys(rawBrowser, BROWSER_KNOWN_KEYS, 'browser', warnings);
      const enabled = rawBrowser['enabled'];
      if (enabled !== undefined) {
        if (typeof enabled !== 'boolean') {
          errors.push('browser.enabled 必须是布尔值');
        } else {
          browser.enabled = enabled;
        }
      }
      const idleDestroyMs = rawBrowser['idleDestroyMs'];
      if (idleDestroyMs !== undefined) {
        if (typeof idleDestroyMs !== 'number' || !Number.isInteger(idleDestroyMs) || idleDestroyMs < 1000) {
          errors.push('browser.idleDestroyMs 必须是 >= 1000 的整数（毫秒）');
        } else {
          browser.idleDestroyMs = idleDestroyMs;
        }
      }
      const maxConcurrent = rawBrowser['maxConcurrent'];
      if (maxConcurrent !== undefined) {
        if (
          typeof maxConcurrent !== 'number' ||
          !Number.isInteger(maxConcurrent) ||
          maxConcurrent < 1 ||
          maxConcurrent > 8
        ) {
          errors.push('browser.maxConcurrent 必须是 1..8 的整数');
        } else {
          browser.maxConcurrent = maxConcurrent;
        }
      }
    }
  }

  // —— bash（A1-1；缺省 = 自动探测，见 tools/shell.ts）——
  const bash: BashConfig = { ...DEFAULT_BASH_CONFIG };
  const rawBash = raw['bash'];
  if (rawBash !== undefined) {
    if (!isPlainObject(rawBash)) {
      errors.push('config.bash 必须是对象');
    } else {
      collectUnknownKeys(rawBash, BASH_KNOWN_KEYS, 'bash', warnings);
      const shell = rawBash['shell'];
      if (shell !== undefined) {
        if (typeof shell !== 'string' || shell.trim().length === 0) {
          errors.push('bash.shell 必须是非空字符串（shell 可执行文件路径）');
        } else {
          bash.shell = shell;
        }
      }
    }
  }

  // —— plugins（阶段 8；缺省 = enabled + 空 allow：不审批任何插件即不装载）——
  const plugins: PluginsConfig = { ...DEFAULT_PLUGINS_CONFIG };
  const rawPlugins = raw['plugins'];
  if (rawPlugins !== undefined) {
    if (!isPlainObject(rawPlugins)) {
      errors.push('config.plugins 必须是对象');
    } else {
      collectUnknownKeys(rawPlugins, PLUGINS_KNOWN_KEYS, 'plugins', warnings);
      const enabled = rawPlugins['enabled'];
      if (enabled !== undefined) {
        if (typeof enabled !== 'boolean') {
          errors.push('plugins.enabled 必须是布尔值');
        } else {
          plugins.enabled = enabled;
        }
      }
      const allow = rawPlugins['allow'];
      if (allow !== undefined) {
        if (!Array.isArray(allow) || !allow.every((n) => typeof n === 'string' && PLUGIN_NAME_PATTERN.test(n))) {
          errors.push('plugins.allow 必须是插件名数组（每个名字匹配 ^[a-z0-9][a-z0-9_-]{0,63}$）');
        } else {
          plugins.allow = [...(allow as string[])];
        }
      }
    }
  }

  // —— mcpServers（阶段 8；缺省 = {}：零 MCP 行为）——
  // server 名必须满足 ^[a-z0-9_]+$（拼进 mcp__<server>__<tool> 工具名）；stdio（command）
  // 与 url 二选一，双填/都不填均报错。
  const mcpServers: McpServersConfig = {};
  const rawMcp = raw['mcpServers'];
  if (rawMcp !== undefined) {
    if (!isPlainObject(rawMcp)) {
      errors.push('config.mcpServers 必须是对象');
    } else {
      const MCP_NAME_PATTERN = /^[a-z0-9_]+$/;
      for (const [serverName, v] of Object.entries(rawMcp)) {
        if (!MCP_NAME_PATTERN.test(serverName)) {
          errors.push(`mcpServers.${serverName} 服务器名必须匹配 ^[a-z0-9_]+$（拼进工具名 mcp__<server>__<tool>）`);
          continue;
        }
        if (!isPlainObject(v)) {
          errors.push(`mcpServers.${serverName} 必须是对象`);
          continue;
        }
        collectUnknownKeys(v, MCP_SERVER_KNOWN_KEYS, `mcpServers.${serverName}`, warnings);
        const command = v['command'];
        const url = v['url'];
        if (command !== undefined && url !== undefined) {
          errors.push(`mcpServers.${serverName} 的 command 与 url 只能二选一`);
          continue;
        }
        if (typeof command === 'string') {
          if (command.trim() === '') {
            errors.push(`mcpServers.${serverName}.command 必须是非空字符串`);
            continue;
          }
          const cfg: McpStdioServerConfig = { command };
          const args = v['args'];
          if (args !== undefined) {
            if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
              errors.push(`mcpServers.${serverName}.args 必须是字符串数组`);
              continue;
            }
            cfg.args = [...args];
          }
          const env = v['env'];
          if (env !== undefined) {
            if (!isStringRecord(env)) {
              errors.push(`mcpServers.${serverName}.env 必须是字符串到字符串的映射`);
              continue;
            }
            cfg.env = { ...env };
          }
          const cwd = v['cwd'];
          if (cwd !== undefined) {
            if (typeof cwd !== 'string' || cwd.trim() === '') {
              errors.push(`mcpServers.${serverName}.cwd 必须是非空字符串`);
              continue;
            }
            cfg.cwd = cwd;
          }
          mcpServers[serverName] = cfg;
          continue;
        }
        if (typeof url === 'string') {
          if (!/^https?:\/\//.test(url)) {
            errors.push(`mcpServers.${serverName}.url 必须是 http(s) 地址，实际为 ${JSON.stringify(url)}`);
            continue;
          }
          const cfg: McpUrlServerConfig = { url };
          const headers = v['headers'];
          if (headers !== undefined) {
            if (!isStringRecord(headers)) {
              errors.push(`mcpServers.${serverName}.headers 必须是字符串到字符串的映射`);
              continue;
            }
            cfg.headers = { ...headers };
          }
          mcpServers[serverName] = cfg;
          continue;
        }
        errors.push(`mcpServers.${serverName} 必须提供 command（stdio）或 url（Streamable HTTP）`);
      }
    }
  }

  // —— subagent（阶段 8；缺省 = maxDepth 1 / maxTurns 25 深度红线）——
  const subagent: SubagentConfig = { ...DEFAULT_SUBAGENT_CONFIG };
  const rawSubagent = raw['subagent'];
  if (rawSubagent !== undefined) {
    if (!isPlainObject(rawSubagent)) {
      errors.push('config.subagent 必须是对象');
    } else {
      collectUnknownKeys(rawSubagent, SUBAGENT_KNOWN_KEYS, 'subagent', warnings);
      // P1-2：maxDepth 与 maxTurns 分开校验（语义不同：递归深度红线 vs 子会话单 turn 步数）。
      // maxTurns 上限 200——缺省即 25（计划契约示例同值），旧上限 10 会令照抄契约的合法配置报错。
      const depth = rawSubagent['maxDepth'];
      if (depth !== undefined) {
        if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1 || depth > 10) {
          errors.push('subagent.maxDepth 必须是 1..10 的整数');
        } else {
          subagent.maxDepth = depth;
        }
      }
      const turns = rawSubagent['maxTurns'];
      if (turns !== undefined) {
        if (typeof turns !== 'number' || !Number.isInteger(turns) || turns < 1 || turns > 200) {
          errors.push('subagent.maxTurns 必须是 1..200 的整数');
        } else {
          subagent.maxTurns = turns;
        }
      }
    }
  }

  // —— gateways（阶段 9；缺省 = {}：零网关行为）——
  // 渠道名白名单（GATEWAY_CHANNELS）；DM/群策略缺省 allowlist（防滥用）；
  // appId 非密钥可入 config，appSecret 只走 auth.json.gateways / env（这里不校验密钥本身）。
  const gateways: GatewaysConfig = {};
  const rawGateways = raw['gateways'];
  if (rawGateways !== undefined) {
    if (!isPlainObject(rawGateways)) {
      errors.push('config.gateways 必须是对象');
    } else {
      collectUnknownKeys(rawGateways, GATEWAYS_KNOWN_KEYS, 'gateways', warnings);
      for (const [name, v] of Object.entries(rawGateways)) {
        if (!GATEWAY_CHANNELS.includes(name)) {
          warnings.push(`gateways: 未知渠道 "${name}" 已忽略（支持：${GATEWAY_CHANNELS.join('、')}）`);
          continue;
        }
        if (!isPlainObject(v)) {
          errors.push(`gateways.${name} 必须是对象`);
          continue;
        }
        collectUnknownKeys(v, GATEWAY_CHANNEL_KNOWN_KEYS, `gateways.${name}`, warnings);
        const appId = v['appId'];
        if (typeof appId !== 'string' || appId.trim() === '') {
          errors.push(`gateways.${name}.appId 必须是非空字符串`);
          continue;
        }
        const channel: GatewayChannelConfig = { ...DEFAULT_GATEWAY_CHANNEL, appId };
        const enabled = v['enabled'];
        if (enabled !== undefined) {
          if (typeof enabled !== 'boolean') {
            errors.push(`gateways.${name}.enabled 必须是布尔值`);
            continue;
          }
          channel.enabled = enabled;
        }
        const envKey = v['appSecretEnvKey'];
        if (envKey !== undefined) {
          if (typeof envKey !== 'string' || envKey.trim() === '') {
            errors.push(`gateways.${name}.appSecretEnvKey 必须是非空字符串`);
            continue;
          }
          channel.appSecretEnvKey = envKey;
        }
        let channelOk = true;
        for (const field of ['dmPolicy', 'groupPolicy'] as const) {
          const policy = v[field];
          if (policy === undefined) continue;
          if (typeof policy !== 'string' || !GATEWAY_POLICIES.includes(policy as GatewayPolicy)) {
            errors.push(
              `gateways.${name}.${field} 必须是 ${GATEWAY_POLICIES.join(' | ')}，实际为 ${JSON.stringify(policy)}`,
            );
            channelOk = false;
            continue;
          }
          channel[field] = policy as GatewayPolicy;
        }
        const allow = v['allow'];
        if (allow !== undefined) {
          if (!Array.isArray(allow) || !allow.every((x) => typeof x === 'string' && x.trim() !== '')) {
            errors.push(`gateways.${name}.allow 必须是非空字符串数组`);
            channelOk = false;
          } else {
            channel.allow = [...(allow as string[])];
          }
        }
        if (channelOk) gateways[name as GatewayChannelName] = channel;
      }
    }
  }

  // —— ui（P2-C 加性；缺省 = 未配置，壳层回退 fullscreen）——
  // screen_mode 只认 fullscreen | minimal（与 cli tui/render/mode.ts 的 RENDER_MODES 同域）；
  // 其余类型/值报致命错误（走 config 报错通道，缺省回退由壳层负责）。
  const ui: UiConfig = {};
  const rawUi = raw['ui'];
  let uiConfigured = false;
  if (rawUi !== undefined) {
    if (!isPlainObject(rawUi)) {
      errors.push('config.ui 必须是对象');
    } else {
      uiConfigured = true; // 段配置即透出（可能为空对象——字段缺省语义由壳层裁定）
      collectUnknownKeys(rawUi, UI_KNOWN_KEYS, 'ui', warnings);
      const screenMode = rawUi['screen_mode'];
      if (screenMode !== undefined) {
        if (typeof screenMode !== 'string' || (screenMode !== 'fullscreen' && screenMode !== 'minimal')) {
          errors.push(`ui.screen_mode 必须是 fullscreen | minimal，实际为 ${JSON.stringify(screenMode)}`);
        } else {
          ui.screen_mode = screenMode;
        }
      }
      // —— follow_up_behavior（P3-C 加性；G-26：queue | steer，缺省由壳层裁定 queue）——
      const followUp = rawUi['follow_up_behavior'];
      if (followUp !== undefined) {
        if (typeof followUp !== 'string' || !FOLLOW_UP_BEHAVIORS.includes(followUp as FollowUpBehavior)) {
          errors.push(
            `ui.follow_up_behavior 必须是 ${FOLLOW_UP_BEHAVIORS.join(' | ')}，实际为 ${JSON.stringify(followUp)}`,
          );
        } else {
          ui.follow_up_behavior = followUp as FollowUpBehavior;
        }
      }
      // —— status_line（P3-C 加性；G-42～G-46）——
      // type 接受 off/none/hidden 同义拼写并归一为 'disabled'；items 是闭合枚举；
      // padding 钳到 0..16（G-46「上限 16」是钳制语义，不报错）；refresh_interval 1..86400。
      const rawStatusLine = rawUi['status_line'];
      if (rawStatusLine !== undefined) {
        if (!isPlainObject(rawStatusLine)) {
          errors.push('ui.status_line 必须是对象');
        } else {
          const statusLine: StatusLineConfig = {};
          collectUnknownKeys(rawStatusLine, STATUS_LINE_KNOWN_KEYS, 'ui.status_line', warnings);
          const rawType = rawStatusLine['type'];
          if (rawType !== undefined) {
            if (typeof rawType !== 'string') {
              errors.push(
                `ui.status_line.type 必须是 ${STATUS_LINE_TYPES.join(' | ')}，实际为 ${JSON.stringify(rawType)}`,
              );
            } else if ((STATUS_LINE_TYPES as readonly string[]).includes(rawType)) {
              statusLine.type = rawType as StatusLineType;
            } else if (STATUS_LINE_DISABLED_SYNONYMS.includes(rawType)) {
              statusLine.type = 'disabled'; // G-42：同义拼写归一
            } else {
              errors.push(
                `ui.status_line.type 必须是 ${[...STATUS_LINE_TYPES, ...STATUS_LINE_DISABLED_SYNONYMS].join(' | ')}，实际为 ${JSON.stringify(rawType)}`,
              );
            }
          }
          const rawItems = rawStatusLine['items'];
          if (rawItems !== undefined) {
            if (!Array.isArray(rawItems) || !rawItems.every((x) => typeof x === 'string')) {
              errors.push('ui.status_line.items 必须是字符串数组');
            } else {
              const bad = (rawItems as string[]).filter((x) => !STATUS_LINE_BUILTIN_ITEMS.includes(x));
              if (bad.length > 0) {
                errors.push(
                  `ui.status_line.items 含未知条目 ${JSON.stringify(bad)}（可选：${STATUS_LINE_BUILTIN_ITEMS.join('、')}）`,
                );
              } else {
                statusLine.items = [...(rawItems as string[])];
              }
            }
          }
          const rawCommand = rawStatusLine['command'];
          if (rawCommand !== undefined) {
            if (typeof rawCommand !== 'string' || rawCommand.trim() === '') {
              errors.push('ui.status_line.command 必须是非空字符串');
            } else {
              statusLine.command = rawCommand;
            }
          }
          const rawPadding = rawStatusLine['padding'];
          if (rawPadding !== undefined) {
            if (typeof rawPadding !== 'number' || !Number.isInteger(rawPadding) || rawPadding < 0) {
              errors.push('ui.status_line.padding 必须是 >= 0 的整数');
            } else {
              statusLine.padding = Math.min(rawPadding, 16); // G-46：上限 16 = 钳制语义
            }
          }
          const rawRefresh = rawStatusLine['refresh_interval'];
          if (rawRefresh !== undefined) {
            if (
              typeof rawRefresh !== 'number' ||
              !Number.isInteger(rawRefresh) ||
              rawRefresh < 1 ||
              rawRefresh > 86_400
            ) {
              errors.push('ui.status_line.refresh_interval 必须是 1..86400 的整数（秒）');
            } else {
              statusLine.refresh_interval = rawRefresh;
            }
          }
          if (statusLine.type === 'command' && statusLine.command === undefined) {
            errors.push('ui.status_line.type 为 command 时必须提供 command（脚本命令）');
          }
          ui.status_line = statusLine;
        }
      }
    }
  }

  // —— scrollback（P2-C 加性；缺省 = 未配置，壳层回退 respect_manual_folds=true）——
  const scrollback: ScrollbackConfig = {};
  const rawScrollback = raw['scrollback'];
  let scrollbackConfigured = false;
  if (rawScrollback !== undefined) {
    if (!isPlainObject(rawScrollback)) {
      errors.push('config.scrollback 必须是对象');
    } else {
      scrollbackConfigured = true; // 段配置即透出（可能为空对象）
      collectUnknownKeys(rawScrollback, SCROLLBACK_KNOWN_KEYS, 'scrollback', warnings);
      const scroll = rawScrollback['scroll'];
      if (scroll !== undefined) {
        if (!isPlainObject(scroll)) {
          errors.push('scrollback.scroll 必须是对象');
        } else {
          collectUnknownKeys(scroll, SCROLLBACK_SCROLL_KNOWN_KEYS, 'scrollback.scroll', warnings);
          const respect = scroll['respect_manual_folds'];
          if (respect !== undefined) {
            if (typeof respect !== 'boolean') {
              errors.push('scrollback.scroll.respect_manual_folds 必须是布尔值');
            } else {
              scrollback.scroll = { respect_manual_folds: respect };
            }
          }
        }
      }
    }
  }

  // —— 交叉引用校验（roles 引用存在的 channel/model）——
  for (const [role, rc] of Object.entries(roles)) {
    const provider = providers[rc.channel];
    if (provider === undefined) {
      if (providers && rawProviders && isPlainObject(rawProviders) && rawProviders[rc.channel] !== undefined) {
        // channel 存在但自身校验失败：错误已在上面报过，不重复
        continue;
      }
      errors.push(`roles.${role}.channel "${rc.channel}" 不存在于 providers`);
      continue;
    }
    if (provider.models !== undefined && provider.models[rc.model] === undefined) {
      errors.push(`roles.${role}.model "${rc.model}" 未在 providers.${rc.channel}.models 中声明`);
    }
  }

  // 出口统一脱敏：错误消息可能回显配置值（如非法枚举的实际值），绝不携带疑似密钥内容
  const safeErrors = errors.map(redactSecrets);
  const safeWarnings = warnings.map(redactSecrets);
  if (safeErrors.length > 0) return { config: null, errors: safeErrors, warnings: safeWarnings };
  return {
    config: {
      providers,
      roles,
      approval,
      memory,
      browser,
      bash,
      plugins,
      mcpServers,
      subagent,
      gateways,
      ...(uiConfigured ? { ui } : {}),
      ...(scrollbackConfigured ? { scrollback } : {}),
    },
    errors: safeErrors,
    warnings: safeWarnings,
  };
}
