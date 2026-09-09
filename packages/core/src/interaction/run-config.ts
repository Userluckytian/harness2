// 有效运行配置视图（S7a）：桌面可读的「当前 run 生效配置」只读/脱敏投影。
// 契约（计划 S7 / 验收 #7b）：
//   - 输出：会话 root/cwd、provider/model 与角色、模式/策略、可用工具（名称列表）、
//     连接状态、指令/skill 来源、上下文窗口与预算——只返回脱敏信息；
//   - 生效语义：新 turn 记录配置 revision + 生效时点明确（sealRunConfigSnapshot）；
//     同一次 run 内配置不被后续异步变化静默改写（构建时深拷贝 + 深度冻结）。
// 红线：不新建配置存储（复用 config schema / config load / provider 工厂 / approval policy）；
//       只读投影，不写任何事件；输出经 redactObject 脱敏且深度冻结（Object.freeze）。
import { redactObject } from '../config/redact.js';
import type { ApprovalConfig, ApprovalMode, MemoryMode } from '../config/schema.js';
import {
  RETRY_BACKOFF_SECONDS,
  RETRY_MAX_EXTRA_ATTEMPTS,
  RETRY_MAX_EXTRA_PER_TURN,
  RETRY_MAX_TOTAL_WAIT_SECONDS,
} from './types.js';
import type { RetryBudgetState } from './retry-policy.js';

/** 连接状态：只反映装配/探活给出的真值；缺省 unknown（不猜测 connected） */
export type EffectiveConnectionStatus = 'connected' | 'disconnected' | 'unknown';

/** 每新 turn 递增的配置封存：revision + 采集时点 + 生效时点 */
export interface EffectiveRunConfigSnapshot {
  revision: number;
  /** 快照采集时点（ISO8601） */
  capturedAt: string;
  /** 生效时点（turn 开始；ISO8601） */
  effectiveAt: string;
}

export interface EffectiveRunConfigSkill {
  name: string;
  source: 'project' | 'global';
}

export interface EffectiveRunConfigProvider {
  role: string;
  channel: string;
  model: string;
  protocol: 'openai' | 'anthropic';
  /** provider 标识（channel/model） */
  name: string;
  /** 可选：装配/探活给出的真实连接状态（不提供则如实回 unknown） */
  connectionStatus?: EffectiveConnectionStatus;
}

export interface EffectiveRunConfig {
  readonly session: {
    sessionId: string;
    /** 项目根（hub 全局 cwd） */
    root: string;
    /** 有效执行 cwd：per-session cwd 配置 → header 真值；未配置 → 回退 root */
    cwd: string;
    /** 是否启用 per-session cwd（header 提供真值） */
    perSessionCwd: boolean;
  };
  readonly provider: {
    role: string;
    channel: string;
    model: string;
    protocol: 'openai' | 'anthropic';
    name: string;
  };
  readonly approval: {
    /** 生效审批模式（含运行时覆盖，如 CLI /mode） */
    mode: ApprovalMode;
    /** per-tool 规则（config.approval.tools 装配） */
    tools: Record<string, 'allow' | 'ask' | 'deny'>;
  };
  readonly modes: {
    /** memory 模式（off/ask/auto） */
    memory: MemoryMode;
  };
  /** 可用工具（名称列表；来自装配集，排序拷贝） */
  readonly tools: readonly string[];
  readonly connection: { status: EffectiveConnectionStatus };
  readonly instructions: {
    /** 指令/skill 来源（两级扫描：project / global） */
    skills: readonly EffectiveRunConfigSkill[];
  };
  readonly context: {
    /** roles.main 模型容量（缺省由调用方装配决定；未声明不填） */
    contextWindow?: number;
    maxOutputTokens?: number;
    /** 有界重试预算（S4 默认策略冻结值） */
    retry: {
      maxExtraAttempts: number;
      backoffSeconds: readonly number[];
      maxExtraPerTurn: number;
      maxTotalWaitSeconds: number;
      /**
       * FixC D1（方案二）：最近 turn 的重试预算可读状态（used/remaining/stopReason）。
       * 预算不持久化（per-attempt 会话独立计数是设计语义，重启清零），仅暴露当前可见的
       * 已耗/剩余/停因，桌面据此展示「为什么停」。调用方装配（hub 从 TurnResult 记录）。
       */
      budget?: RetryBudgetState;
    };
  };
  readonly snapshot: EffectiveRunConfigSnapshot;
  /** 契约钉：输出已脱敏 */
  readonly redacted: true;
}

export interface EffectiveRunConfigInput {
  session: {
    sessionId: string;
    root: string;
    cwd: string;
    /** header 是否提供 per-session cwd 真值 */
    cwdFromHeader: boolean;
  };
  provider: EffectiveRunConfigProvider;
  /** config.approval（装配来源） */
  approval?: ApprovalConfig;
  /** 生效审批模式（运行时可覆盖 mode；缺省取 approval.mode ?? 'default'） */
  approvalMode?: ApprovalMode;
  memoryMode: MemoryMode;
  /** 装配好的可用工具（名称列表） */
  tools: readonly string[];
  /** 指令/skill 来源（SkillStore.scan().skills 投影为 name+source） */
  skills?: ReadonlyArray<{ name: string; source: 'project' | 'global' }>;
  contextWindow?: number;
  maxOutputTokens?: number;
  snapshot: EffectiveRunConfigSnapshot;
  /** FixC D1：最近 turn 的重试预算可读状态（缺省 = 未发生/未记录，不臆造） */
  retryBudget?: RetryBudgetState;
}

/**
 * 配置封存：revision 每新 turn 递增（prev 为空 → 1）；capturedAt/effectiveAt 缺省取
 * 当前时刻（测试可注入确定时点）。生效时点显式 = 该 turn 开始生效的配置版本。
 */
export function sealRunConfigSnapshot(
  prev?: EffectiveRunConfigSnapshot,
  now?: { capturedAt?: string; effectiveAt?: string },
): EffectiveRunConfigSnapshot {
  const capturedAt = now?.capturedAt ?? new Date().toISOString();
  const effectiveAt = now?.effectiveAt ?? capturedAt;
  return {
    revision: (prev?.revision ?? 0) + 1,
    capturedAt,
    effectiveAt,
  };
}

/**
 * 连接状态：反映 provider 侧给出的真值；未提供 → fallback（默认 unknown），不臆造 connected。
 * 典型来源 = 装配层探活结果（真实 provider 健康检查）或 provider 自身暴露的连接位。
 */
export function reflectProviderConnection(
  provider: Readonly<{ connectionStatus?: EffectiveConnectionStatus }>,
  fallback: EffectiveConnectionStatus = 'unknown',
): EffectiveConnectionStatus {
  return provider.connectionStatus ?? fallback;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const k of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[k]);
  }
  return Object.freeze(value);
}

/**
 * 构建有效运行配置只读视图：深拷贝输入（同 run 内不受后续输入变化改写）、
 * 出口经 redactObject 脱敏（敏感字段名与 sk-/token 形态串替换为 [REDACTED]）、深度冻结。
 */
export function buildEffectiveRunConfig(input: EffectiveRunConfigInput): EffectiveRunConfig {
  const visible: EffectiveRunConfig = {
    session: {
      sessionId: input.session.sessionId,
      root: input.session.root,
      cwd: input.session.cwdFromHeader ? input.session.cwd : input.session.root,
      perSessionCwd: input.session.cwdFromHeader,
    },
    provider: {
      role: input.provider.role,
      channel: input.provider.channel,
      model: input.provider.model,
      protocol: input.provider.protocol,
      name: input.provider.name,
    },
    approval: {
      mode: input.approvalMode ?? input.approval?.mode ?? 'default',
      tools: { ...(input.approval?.tools ?? {}) },
    },
    modes: { memory: input.memoryMode },
    tools: [...input.tools].sort(),
    connection: { status: reflectProviderConnection(input.provider) },
    instructions: {
      skills: (input.skills ?? []).map((s) => ({ name: s.name, source: s.source })),
    },
    context: {
      ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
      ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
      retry: {
        maxExtraAttempts: RETRY_MAX_EXTRA_ATTEMPTS,
        backoffSeconds: [...RETRY_BACKOFF_SECONDS],
        maxExtraPerTurn: RETRY_MAX_EXTRA_PER_TURN,
        maxTotalWaitSeconds: RETRY_MAX_TOTAL_WAIT_SECONDS,
        ...(input.retryBudget !== undefined ? { budget: input.retryBudget } : {}),
      },
    },
    snapshot: { ...input.snapshot },
    redacted: true,
  };
  return deepFreeze(redactObject(visible));
}

/** 类型守卫：合法视图必须带契约钉（readOnly/redacted 语义由结构保证） */
export function isEffectiveRunConfig(v: unknown): v is EffectiveRunConfig {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return c.redacted === true && typeof c.session === 'object' && c.session !== null;
}