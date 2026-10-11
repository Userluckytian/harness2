// A09 hook 运行器：把配置里的 hook 条目按事件匹配后**顺序**执行，解析输出，聚合决策。
//
// 输出/失败语义（对齐 ZCode 调研结论，见报告）：
//   - 正常结束（exit 0）：stdout 若以 `{` 开头则尝试 JSON 解析（解析失败按诊断文本处理，
//     **不让 hook 打日志导致动作失败**）；JSON 字段解释见 interpretHookOutput。
//   - exit code 2：拦截（preTool → blocked）；原因取 stderr/stdout 预览。
//   - 其它非零 / spawn 失败 / 超时：**fail-open**——不阻断、不改写输入，记 failed/timeout/
//     spawn_error 记录 + 一条告警（走 warn sink），当前动作照常继续。
//   - async: true 的条目 fire-and-forget：不等待、不捕获输出、不进 invocations（其结果
//     无法保证在 turn 结束前落账）；失败仅经 warn 告知（如实登记为限制，见报告）。
//
// 安全：预览一律经 redactSecrets 脱敏 + 长度截断；env 用 buildHookEnv 白名单。
import { redactSecrets } from '../config/redact.js';
import type { HookEntry, HooksConfig } from '../config/schema.js';
import { matchHookMatcher } from './matcher.js';
import { buildHookEnv, defaultSpawnHook, type HookSpawnHook, type HookSpawnResult } from './executor.js';
import type { HookInvocationRecord, HookOutcome, HookRunPayload, HookRunResult, HookRunner } from './types.js';

/** 记录层预览字符上限（先截断再脱敏；extension 层再裁到 2000） */
const PREVIEW_MAX_CHARS = 4000;

export interface HookRunnerOptions {
  /** hooks 配置段（undefined/未配置 = 零 hook 行为） */
  config: HooksConfig | undefined;
  /** 执行器缝（测试注入 mock；缺省真实 shell spawn） */
  spawnHook?: HookSpawnHook;
  /** 环境基底（缺省 process.env；测试可注入确定性环境） */
  env?: Record<string, string | undefined>;
  /** 告警 sink（fail-open 时如实记）；缺省写 stderr（一行一条） */
  warn?: (message: string) => void;
  /**
   * 执行门控（对齐 ZCode workspace-hook admission 缝）：返回 false 的条目被跳过（不执行、
   * 不落记录）。缺省全放行——config 里的 hook 与权限 DSL 同级信任（用户自撰）。
   */
  admit?: (entry: HookEntry) => boolean;
}

/** 事件是否为「工具事件」（matcher 匹配工具名） */
function isToolEvent(event: string): boolean {
  return event === 'preTool' || event === 'postTool';
}

/** 预览：截断 + 脱敏（空白清理后） */
function preview(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const clipped = trimmed.length > PREVIEW_MAX_CHARS ? trimmed.slice(0, PREVIEW_MAX_CHARS) : trimmed;
  return redactSecrets(clipped);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** stdout → JSON（仅当 trim 后以 `{` 开头；解析失败返回 undefined，按诊断文本处理） */
export function parseHookOutput(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

interface OutputAccumulator {
  blocked?: { reason: string };
  updatedInput?: unknown;
  contexts: string[];
}

/**
 * 解释一条 hook 的 JSON 输出（ZCode HookJSONOutput 的**子集**）：
 *   - continue === false / decision === 'block' → 拦截（preTool 生效）；
 *   - hookSpecificOutput.permissionDecision === 'deny' → 拦截；
 *   - hookSpecificOutput.updatedInput（或顶层 updatedInput）→ 改写输入（preTool 生效）；
 *   - additionalContext / additional_context / hookSpecificOutput.additionalContext → 回注段。
 * 非 preTool 事件只取回注段（block 记录但不改道——无「阻止 turn」语义，见报告未做项）。
 */
export function interpretHookOutput(
  event: string,
  output: Record<string, unknown> | undefined,
  acc: OutputAccumulator,
): void {
  if (output === undefined) return;
  const reason =
    asNonEmptyString(output['stopReason']) ??
    asNonEmptyString(output['reason']) ??
    asNonEmptyString(output['systemMessage']);
  const wantsBlock = output['continue'] === false || output['decision'] === 'block';
  if (wantsBlock && event === 'preTool') {
    acc.blocked = { reason: reason ?? 'Hook blocked tool execution' };
  }
  const pushContext = (value: unknown): void => {
    const text = asNonEmptyString(value);
    if (text !== undefined) acc.contexts.push(text);
  };
  pushContext(output['additionalContext']);
  pushContext(output['additional_context']);
  if (output['updatedInput'] !== undefined && event === 'preTool') {
    acc.updatedInput = output['updatedInput'];
  }
  const specific = output['hookSpecificOutput'];
  if (isPlainObject(specific)) {
    // 事件名不符的 hookSpecificOutput 直接忽略（不臆造跨事件语义）
    const specificEvent = asNonEmptyString(specific['hookEventName']);
    if (specificEvent === undefined || specificEvent === event) {
      if (specific['permissionDecision'] === 'deny' && event === 'preTool') {
        acc.blocked = {
          reason: asNonEmptyString(specific['permissionDecisionReason']) ?? reason ?? 'Hook denied tool execution',
        };
      }
      if (specific['updatedInput'] !== undefined && event === 'preTool') {
        acc.updatedInput = specific['updatedInput'];
      }
      pushContext(specific['additionalContext']);
      pushContext(specific['additional_context']);
    }
  }
}

/** 单条 hook 执行结果 → 记录（含输出解释对 acc 的副作用） */
function classifySpawnResult(result: HookSpawnResult): HookOutcome {
  if (result.status === 'timeout') return 'timeout';
  if (result.status === 'error') return 'spawn_error';
  return (result.exitCode ?? 0) === 0 ? 'success' : 'failed';
}

/** 生成 stdin 注入的 JSON（对齐 ZCode 的 snake_case alias 子集，保留 camelCase 主契约） */
export function buildHookStdin(payload: HookRunPayload): string {
  const common: Record<string, unknown> = {
    hookEventName: payload.event,
    hook_event_name: payload.event,
    cwd: payload.cwd,
  };
  if (payload.sessionId !== undefined) {
    common['sessionId'] = payload.sessionId;
    common['session_id'] = payload.sessionId;
  }
  if (payload.turnId !== undefined) common['turnId'] = payload.turnId;
  common['agent_type'] = 'harness2';
  if (isToolEvent(payload.event)) {
    if (payload.toolName !== undefined) {
      common['toolName'] = payload.toolName;
      common['tool_name'] = payload.toolName;
    }
    if (payload.args !== undefined) {
      common['toolInput'] = payload.args;
      common['tool_input'] = payload.args;
    }
    if (payload.event === 'postTool') {
      common['toolResponse'] = payload.output;
      common['tool_response'] = payload.output;
      common['ok'] = payload.ok ?? false;
    }
  }
  if (payload.event === 'turnEnd' && payload.stopReason !== undefined) {
    common['stopReason'] = payload.stopReason;
  }
  return `${JSON.stringify(common)}\n`;
}

/** 解析单条 hook 的执行结果并累加决策/记录 */
function applyResult(
  entry: HookEntry,
  target: string | undefined,
  result: HookSpawnResult,
  durationMs: number,
  acc: OutputAccumulator,
  invocations: HookInvocationRecord[],
): void {
  const outcome: HookOutcome = classifySpawnResult(result);
  const stderrPreview = preview(result.stderr);
  const stdoutPreview = preview(result.stdout);
  const record: HookInvocationRecord = {
    event: entry.event,
    command: entry.command,
    exitCode: result.exitCode,
    durationMs,
    outcome,
    ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(stdoutPreview !== undefined ? { stdoutPreview } : {}),
    ...(stderrPreview !== undefined ? { stderrPreview } : {}),
  };

  if (outcome === 'success') {
    interpretHookOutput(entry.event, parseHookOutput(result.stdout), acc);
    if (entry.event !== 'preTool' && acc.contexts.length > 0) record.contextCount = acc.contexts.length;
  } else if (result.exitCode === 2) {
    // exit 2 = 显式拦截（preTool 改道为 blocked；其余事件如实记为 blocked 但不改道）
    const reason = stderrPreview ?? stdoutPreview ?? 'Hook blocked tool execution';
    if (entry.event === 'preTool') acc.blocked = { reason };
    record.outcome = 'blocked';
    record.blockReason = reason;
    record.exitCode = 2;
  }
  invocations.push(record);
}

export function createHookRunner(options: HookRunnerOptions): HookRunner {
  const config = options.config;
  const spawnHook = options.spawnHook ?? defaultSpawnHook;
  const baseEnv = options.env ?? process.env;
  const warn = options.warn ?? ((message: string): void => console.warn(message));
  const admit = options.admit;
  const entries = config?.enabled === true ? (config.entries ?? []) : [];

  return {
    async run(payload: HookRunPayload): Promise<HookRunResult> {
      const result: HookRunResult = { additionalContexts: [], invocations: [] };
      if (entries.length === 0) return result;
      const target = isToolEvent(payload.event) ? payload.toolName : undefined;
      const stdin = buildHookStdin(payload);
      const env = buildHookEnv(baseEnv, {
        event: payload.event,
        cwd: payload.cwd,
        ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
      });
      for (const entry of entries) {
        if (entry.event !== payload.event) continue;
        if (entry.enabled === false) continue;
        if (admit !== undefined && !admit(entry)) continue;
        if (!matchHookMatcher(entry.matcher, target)) continue;
        const timeoutMs = entry.timeoutMs ?? config?.timeoutMs ?? 30_000;
        const maxOutputBytes = config?.maxOutputBytes ?? 32_768;
        const acc: OutputAccumulator = { contexts: [] };
        const startedAt = Date.now();
        if (entry.async === true) {
          // fire-and-forget：不等待、不落记录（结果可能晚于 turn 结束，无法保证落账窗口）
          void spawnHook({
            command: entry.command,
            stdin,
            cwd: payload.cwd,
            env,
            timeoutMs,
            maxOutputBytes,
          }).catch((e: unknown) => {
            warn(`hook(async) 执行异常：${(e as Error)?.message ?? String(e)}`);
          });
          continue;
        }
        let spawnResult: HookSpawnResult;
        try {
          spawnResult = await spawnHook({
            command: entry.command,
            stdin,
            cwd: payload.cwd,
            env,
            timeoutMs,
            maxOutputBytes,
          });
        } catch (e) {
          spawnResult = {
            status: 'error',
            exitCode: null,
            stdout: '',
            stderr: '',
            errorMessage: (e as Error)?.message ?? String(e),
          };
        }
        const durationMs = Date.now() - startedAt;
        applyResult(entry, target, spawnResult, durationMs, acc, result.invocations);
        const last = result.invocations[result.invocations.length - 1];
        // fail-open 告警（success/blocked 不算失败；记录已如实落账）
        if (
          last !== undefined &&
          (last.outcome === 'failed' || last.outcome === 'timeout' || last.outcome === 'spawn_error')
        ) {
          warn(
            `hook 执行失败（fail-open，未阻断）：event=${entry.event} outcome=${last.outcome} command=${entry.command}`,
          );
        }
        result.additionalContexts.push(...acc.contexts);
        if (acc.blocked !== undefined) {
          result.blocked = acc.blocked;
          // 拦截是确定性决策：记录已 push，后续 hook 仍执行以完整落账（读侧可见全过程）
        }
        if (acc.updatedInput !== undefined) result.updatedInput = acc.updatedInput;
      }
      return result;
    },
  };
}

/** 空运行器（未配置 hooks 时的零行为实例；避免调用方到处判空） */
export const noopHookRunner: HookRunner = {
  run: () => Promise.resolve({ additionalContexts: [], invocations: [] }),
};

/** 便捷断言：config 是否声明了任何可执行 hook */
export function hasConfiguredHooks(config: HooksConfig | undefined): boolean {
  return config !== undefined && config.enabled === true && (config.entries?.length ?? 0) > 0;
}

/**
 * 回注段拼接（对齐 ZCode formatHookAdditionalContexts 的措辞）：postTool 的
 * additionalContext 追加到该 tool/result 的 output/error 尾部，随事件落盘（可从日志重建）。
 */
export function formatHookAdditionalContexts(contexts: readonly string[]): string {
  return ['[Hook additional context]', ...contexts.map((context, index) => `#${index + 1}\n${context}`)].join('\n');
}
