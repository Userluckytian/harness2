// contract.ts — G-45 状态行 stdin JSON 契约 + G-49 子进程环境（headless 纯逻辑）。
//
// 规格依据：refs-grok-build.md G-45/G-49 与上游 25-status-line.md「Available data」表：
//  - G-45：外部命令脚本经 stdin 收 JSON（**带尾随换行**——上游 Input 节：payload is written
//    to stdin with a trailing newline，read -r line 与 input=$(cat) 均可用），展示其 stdout。
//    契约字段最小集（refs 表）：workspace.repo_root、context_window.context_tokens、
//    context_window.session_usage、transcript_path、prompt_id、trigger = state |
//    refresh_interval。完整形状按上游「Available data」表实现（cwd/session_id/model/
//    cost/context_window 百分比/turn.started_at_ms 等）。
//  - **不造假数据红线**：上游明文「Fields Grok cannot source are omitted rather than sent
//    as placeholders, so the row never shows a fabricated value」——本模块的 builder 对
//    数据源里缺失的字段**直接省略**，绝不填 0/null/占位符；parser 对拿到的 payload 只
//    校验形状、不补造缺省值。
//  - G-49：COLUMNS / LINES 给的是**状态行自身尺寸**（不是窗口）；GIT_OPTIONAL_LOCKS=0；
//    清空 BASH_ENV / ENV。env 构造为纯函数：复制基础 env、绝不原地修改。
//
// 状态行数据源（StatusLineDataSource）由装配层从真实会话状态喂入（core describeCapabilities
// / 会话管理 / provider 元数据），本模块不做任何数据采集——拿不到的字段保持缺省并省略。

/** payload 形状版本（上游：加字段不 bump；删/改类型才 bump。初版 1） */
export const STATUS_LINE_SCHEMA_VERSION = 1;

/** trigger（G-45）：state = 会话状态变化触发；refresh_interval = 定时器触发 */
export type StatusLineTrigger = 'state' | 'refresh_interval';

/** context_window.session_usage（上游表：会话累计，非单回合；首次调用前缺席） */
export interface StatusLineSessionUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

/**
 * stdin JSON payload（G-45；形状 = 上游 25-status-line.md「Available data」表的本仓子集）。
 * 除 cwd / session_id / transcript_path / workspace.current_dir / schema_version / trigger
 * 外均为可选——可 sourced 才出现（不造假）。
 */
export interface StatusLinePayload {
  readonly cwd: string;
  readonly session_id: string;
  /** 会话名（客户端填写；上游：stdin 有、SessionStatus 通知无） */
  readonly session_name?: string;
  /** 仅回合运行中存在（G-45 最小集成员） */
  readonly prompt_id?: string;
  /** 会话更新流文件路径（core 会话目录的 updates.jsonl） */
  readonly transcript_path: string;
  readonly model?: { readonly id: string; readonly display_name: string };
  readonly workspace: {
    readonly current_dir: string;
    /** 仓库根；仓库外缺席（G-45 最小集成员） */
    readonly repo_root?: string;
    /** 分支；detached HEAD 缺席 */
    readonly branch?: string;
  };
  readonly schema_version: number;
  readonly version?: string;
  readonly cost?: {
    readonly total_cost_usd: number;
    readonly total_duration_ms?: number;
    readonly total_api_duration_ms?: number;
  };
  readonly context_window: {
    /** 当前对话占用 tokens（G-45 最小集成员；0 = 空上下文，不可读时整个字段缺席） */
    readonly context_tokens?: number;
    readonly context_window_size?: number;
    /** 0..100 整数；窗口或占用未知时缺席（未知窗口的百分比不是数字） */
    readonly used_percentage?: number;
    readonly remaining_percentage?: number;
    readonly session_input_tokens?: number;
    readonly session_output_tokens?: number;
    /** 会话累计（G-45 最小集成员） */
    readonly session_usage?: StatusLineSessionUsage;
    readonly auto_compact_threshold_percent?: number;
  };
  readonly effort?: { readonly level: string };
  /** 回合中的起始时刻（Unix ms）；回合间缺席 */
  readonly turn?: { readonly started_at_ms: number };
  readonly trigger: StatusLineTrigger;
}

/** builder 的数据源（装配层从真实会话状态喂入；缺失字段 = 省略，绝不造假） */
export interface StatusLineDataSource {
  readonly cwd: string;
  readonly sessionId: string;
  readonly sessionName?: string;
  /** 仅回合运行中提供 */
  readonly promptId?: string;
  readonly transcriptPath: string;
  readonly modelId?: string;
  readonly modelDisplayName?: string;
  readonly repoRoot?: string;
  readonly branch?: string;
  readonly version?: string;
  /** 会话费用（未知 = 缺席——上游：treat an absent cost as unknown rather than as zero） */
  readonly costUsd?: number;
  readonly totalDurationMs?: number;
  readonly totalApiDurationMs?: number;
  readonly contextTokens?: number;
  readonly contextWindowSize?: number;
  readonly autoCompactThresholdPercent?: number;
  readonly sessionInputTokens?: number;
  readonly sessionOutputTokens?: number;
  readonly sessionUsage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheCreationInputTokens?: number;
    readonly cacheReadInputTokens?: number;
  };
  readonly effortLevel?: string;
  readonly turnStartedAtMs?: number;
}

/** 0..100 整数百分比；非有限数值返回 undefined（不造假） */
function wholePercent(part: number | undefined, whole: number | undefined): number | undefined {
  if (part === undefined || whole === undefined) return undefined;
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return undefined;
  return Math.min(100, Math.max(0, Math.round((part / whole) * 100)));
}

/** 数据源 → stdin payload（省略不可 sourced 字段；G-45 最小集全落地） */
export function buildStatusLinePayload(source: StatusLineDataSource, trigger: StatusLineTrigger): StatusLinePayload {
  const usedPercentage = wholePercent(source.contextTokens, source.contextWindowSize);
  const remainingPercentage =
    usedPercentage === undefined ? undefined : Math.min(100, Math.max(0, 100 - usedPercentage));
  return {
    cwd: source.cwd,
    session_id: source.sessionId,
    ...(source.sessionName !== undefined ? { session_name: source.sessionName } : {}),
    ...(source.promptId !== undefined ? { prompt_id: source.promptId } : {}),
    transcript_path: source.transcriptPath,
    ...(source.modelId !== undefined && source.modelDisplayName !== undefined
      ? { model: { id: source.modelId, display_name: source.modelDisplayName } }
      : {}),
    workspace: {
      current_dir: source.cwd,
      ...(source.repoRoot !== undefined ? { repo_root: source.repoRoot } : {}),
      ...(source.branch !== undefined ? { branch: source.branch } : {}),
    },
    schema_version: STATUS_LINE_SCHEMA_VERSION,
    ...(source.version !== undefined ? { version: source.version } : {}),
    ...(source.costUsd !== undefined
      ? {
          cost: {
            total_cost_usd: source.costUsd,
            ...(source.totalDurationMs !== undefined ? { total_duration_ms: source.totalDurationMs } : {}),
            ...(source.totalApiDurationMs !== undefined ? { total_api_duration_ms: source.totalApiDurationMs } : {}),
          },
        }
      : {}),
    context_window: {
      ...(source.contextTokens !== undefined ? { context_tokens: source.contextTokens } : {}),
      ...(source.contextWindowSize !== undefined ? { context_window_size: source.contextWindowSize } : {}),
      ...(usedPercentage !== undefined ? { used_percentage: usedPercentage } : {}),
      ...(remainingPercentage !== undefined ? { remaining_percentage: remainingPercentage } : {}),
      ...(source.sessionInputTokens !== undefined ? { session_input_tokens: source.sessionInputTokens } : {}),
      ...(source.sessionOutputTokens !== undefined ? { session_output_tokens: source.sessionOutputTokens } : {}),
      ...(source.sessionUsage !== undefined
        ? {
            session_usage: {
              input_tokens: source.sessionUsage.inputTokens,
              output_tokens: source.sessionUsage.outputTokens,
              ...(source.sessionUsage.cacheCreationInputTokens !== undefined
                ? { cache_creation_input_tokens: source.sessionUsage.cacheCreationInputTokens }
                : {}),
              ...(source.sessionUsage.cacheReadInputTokens !== undefined
                ? { cache_read_input_tokens: source.sessionUsage.cacheReadInputTokens }
                : {}),
            },
          }
        : {}),
      ...(source.autoCompactThresholdPercent !== undefined
        ? { auto_compact_threshold_percent: source.autoCompactThresholdPercent }
        : {}),
    },
    ...(source.effortLevel !== undefined ? { effort: { level: source.effortLevel } } : {}),
    ...(source.turnStartedAtMs !== undefined ? { turn: { started_at_ms: source.turnStartedAtMs } } : {}),
    trigger,
  };
}

/** payload → stdin 文本（JSON + 尾随换行；上游 Input 节契约） */
export function serializeStatusLinePayload(payload: StatusLinePayload): string {
  return `${JSON.stringify(payload)}\n`;
}

export type StatusLinePayloadParseResult = { ok: true; payload: StatusLinePayload } | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 解析 stdin 文本 → payload（契约校验器；供快照测试 / 脚本自检 / 诊断消费）。
 * 只校验形状与类型：缺字段按契约视为「不可 sourced」原样通过，绝不补造缺省值；
 * 类型不符 / 结构非法 → 明确报错。
 */
export function parseStatusLinePayload(text: string): StatusLinePayloadParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `payload 不是合法 JSON：${(e as Error).message}` };
  }
  if (!isPlainObject(raw)) return { ok: false, error: 'payload 根节点必须是对象' };
  for (const key of ['cwd', 'session_id', 'transcript_path'] as const) {
    if (typeof raw[key] !== 'string') return { ok: false, error: `payload.${key} 必须是字符串` };
  }
  const schemaVersion = raw['schema_version'];
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    return { ok: false, error: 'payload.schema_version 必须是 >= 1 的整数（脚本应以 >= 判定而非 ===）' };
  }
  const trigger = raw['trigger'];
  if (trigger !== 'state' && trigger !== 'refresh_interval') {
    return { ok: false, error: `payload.trigger 必须是 state | refresh_interval，实际为 ${JSON.stringify(trigger)}` };
  }
  const workspace = raw['workspace'];
  if (!isPlainObject(workspace) || typeof workspace['current_dir'] !== 'string') {
    return { ok: false, error: 'payload.workspace.current_dir 必须是字符串' };
  }
  const contextWindow = raw['context_window'];
  if (!isPlainObject(contextWindow)) return { ok: false, error: 'payload.context_window 必须是对象' };
  const usage = contextWindow['session_usage'];
  if (
    usage !== undefined &&
    (!isPlainObject(usage) || typeof usage['input_tokens'] !== 'number' || typeof usage['output_tokens'] !== 'number')
  ) {
    return { ok: false, error: 'payload.context_window.session_usage 必须含数值型 input_tokens / output_tokens' };
  }
  return { ok: true, payload: raw as unknown as StatusLinePayload };
}

/**
 * G-49 子进程环境：COLUMNS / LINES = **状态行自身尺寸**（非窗口尺寸；首绘前行高未知的
 * 缺省尺寸由装配层按「last painted, or 80x1」口径传入）；GIT_OPTIONAL_LOCKS=0（防 git
 * 索引锁争用）；清空 BASH_ENV / ENV（上游：No shell rc files run）。纯函数——复制基础
 * env，绝不原地修改；其余变量原样继承（会话环境是脚本的现实运行环境）。
 */
export function statusLineChildEnv(base: NodeJS.ProcessEnv, size: { cols: number; rows: number }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  env['COLUMNS'] = String(Math.max(1, Math.floor(size.cols)));
  env['LINES'] = String(Math.max(1, Math.floor(size.rows)));
  env['GIT_OPTIONAL_LOCKS'] = '0';
  delete env['BASH_ENV']; // G-49：不跑 shell rc
  delete env['ENV'];
  return env;
}
