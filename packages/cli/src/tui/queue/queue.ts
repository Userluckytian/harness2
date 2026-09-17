// queue.ts — G-26 运行中回合的 follow-up 队列纯 reducer（headless 可测，零旧壳 / 零时钟依赖）。
//
// 规格依据：docs/refs/refs-grok-build.md「G-5x 运行中回合（队列 / 转向）」（2026-09-13 基线
// 37949780）与上游 03-keyboard-shortcuts.md「Follow-ups mid-turn」节。本文件只做**纯数据层**：
// 队列本体、FIFO 保序、容量红线、`[ui].follow_up_behavior` 两态在 reducer 层的表达、以及
// steer 请求的纯构造。接线（Enter 分发、SessionSteerSink.push、turn 收尾 drain）归
// wiring-contract.ts 的状态机与下一棒的装配层。
//
// ── 与 core steer 契约的关系（复用，不复刻）────────────────────────────────────
//  - steer 语义的单一实现是 core 的 SessionSteerSink（interaction/steer-sink.ts，解冻窗口
//    #2 加性导出）：push 去重 / take 在安全 step 边界 / resolve 回帧 accepted|stale|rejected。
//    本模块不复制这些语义，只通过 cli 侧纯函数 makeSteerId / buildSteerRequest（src/steer.ts，
//    甲轨收敛产物）构造 SteerRequest——turnId 未知或文本空白返回 null（绝不猜 turnId），
//    构造出的请求交装配层 push 进 SessionSteerSink。P5 桌面壳复用同一套。
//  - 队列容量复用 core 的 QUEUE_MAX_DEFAULT / queueHasSlot（interaction/types.ts），
//    超限语义与 core 注释一致：保留 draft 并提示，不静默丢弃。
//
// ── follow_up_behavior 两态（G-26）─────────────────────────────────────────────
//  - 'queue'（缺省）：回合运行中 Enter 把草稿入队，不打断当前回合；turn 收尾后按序执行。
//  - 'steer'：同一 Enter **仍然入队展示**（上游：「the same Enter still shows the row in the
//    queue」），但装配层同时把该文本经 buildSteerRequest + SessionSteerSink 在下一个安全
//    step 边界注入当前回合。展示行何时随 accepted/stale 回帧移除/保留由装配层按
//    observeSteer 回帧决定（stale = 草稿保留 = 行留在队列），本层提供 removeFollowUpById。
import {
  FOLLOW_UP_BEHAVIORS,
  QUEUE_MAX_DEFAULT,
  queueHasSlot,
  type FollowUpBehavior,
  type SteerRequest,
} from '@harness2/core';
import { buildSteerRequest, makeSteerId } from '../../steer.js';

/** follow-up 行为（G-26）：`[ui].follow_up_behavior = queue | steer`（单一来源 = core schema） */
export type { FollowUpBehavior };

/** 合法取值（P2-3：直接来自 core schema，壳层不再自持第二份枚举） */
export { FOLLOW_UP_BEHAVIORS };

/** 缺省行为（G-26：queue 默认，入队不打断） */
export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = 'queue';

/** 配置路径（与 refs-grok-build.md G-26 的 TOML 记法一致） */
export const FOLLOW_UP_CONFIG_PATH = 'ui.follow_up_behavior';

/** 一条排队 follow-up（展示/取消/发送都以稳定 id 定位；seq 是 FIFO 保序的证明） */
export interface QueuedFollowUp {
  readonly id: string;
  readonly text: string;
  /** 会话内单调递增入队序号（enqueue 顺序 = seq 顺序；测试据此钉死 FIFO） */
  readonly seq: number;
}

/** 队列状态（纯数据；entries[0] = 队首 = 下一个执行） */
export interface QueueState {
  readonly behavior: FollowUpBehavior;
  readonly entries: readonly QueuedFollowUp[];
  /** 容量红线（core QUEUE_MAX_DEFAULT = 20，core 注释「可配置」） */
  readonly max: number;
  /** 下一条入队的 seq（单调递增，不随 dequeue 回退） */
  readonly nextSeq: number;
}

/** 队列初始状态（容量缺省 = core QUEUE_MAX_DEFAULT） */
export function createQueueState(
  behavior: FollowUpBehavior = DEFAULT_FOLLOW_UP_BEHAVIOR,
  max: number = QUEUE_MAX_DEFAULT,
): QueueState {
  return { behavior, entries: [], max, nextSeq: 1 };
}

/** 队列条目 id（会话内唯一即可；`fu-<seq>`，seq 由 state 单调保证） */
export function followUpId(seq: number): string {
  return `fu-${seq}`;
}

/** 行为切换事件（G-26 两态；幂等：同值切换返回原引用） */
export interface FollowUpBehaviorSwitchedEvent {
  readonly type: 'follow-up-behavior-switched';
  readonly from: FollowUpBehavior;
  readonly to: FollowUpBehavior;
}

export function setFollowUpBehavior(
  state: QueueState,
  behavior: FollowUpBehavior,
): {
  state: QueueState;
  event: FollowUpBehaviorSwitchedEvent | null;
} {
  if (behavior === state.behavior) return { state, event: null };
  return {
    state: { ...state, behavior },
    event: { type: 'follow-up-behavior-switched', from: state.behavior, to: behavior },
  };
}

export type EnqueueOutcome =
  | { kind: 'enqueued'; entry: QueuedFollowUp }
  | { kind: 'rejected'; reason: 'blank' | 'full'; draftKept: true; message: string };

/**
 * 入队一条 follow-up（G-26 queue 语义；纯函数，不改原 state）。
 * 边界（与 steer 构造同口径）：
 *  - 空白文本 → rejected('blank')，草稿保留（绝不入队空条目）；
 *  - 容量满（core queueHasSlot）→ rejected('full')，草稿保留并提示（core QUEUE_MAX 注释语义）。
 */
export function enqueueFollowUp(state: QueueState, text: string): { state: QueueState; outcome: EnqueueOutcome } {
  if (text.trim().length === 0) {
    return {
      state,
      outcome: { kind: 'rejected', reason: 'blank', draftKept: true, message: '空白文本不入队（草稿保留）' },
    };
  }
  if (!queueHasSlot(state.entries.length, state.max)) {
    return {
      state,
      outcome: {
        kind: 'rejected',
        reason: 'full',
        draftKept: true,
        message: `队列已满（上限 ${state.max} 条）：本条保留为草稿，未入队`,
      },
    };
  }
  const entry: QueuedFollowUp = { id: followUpId(state.nextSeq), text, seq: state.nextSeq };
  return {
    state: { ...state, entries: [...state.entries, entry], nextSeq: state.nextSeq + 1 },
    outcome: { kind: 'enqueued', entry },
  };
}

export interface DequeueHeadResult {
  readonly state: QueueState;
  /** 队首条目；空队列时 undefined（调用方据此判定「无可发送」） */
  readonly entry: QueuedFollowUp | undefined;
}

/** 出队队首（G-27：空 composer 再 Enter 发送队首一条；turn 收尾 drain 同用此原语）。 */
export function dequeueHead(state: QueueState): DequeueHeadResult {
  const head = state.entries[0];
  return { state: head === undefined ? state : { ...state, entries: state.entries.slice(1) }, entry: head };
}

/** 按 id 移除一条（面板取消 / steer 回帧 accepted 后移除展示行共用）；无此 id 返回原引用。 */
export function removeFollowUpById(
  state: QueueState,
  id: string,
): { state: QueueState; removed: QueuedFollowUp | undefined } {
  const index = state.entries.findIndex((e) => e.id === id);
  if (index < 0) return { state, removed: undefined };
  const entries = [...state.entries];
  const [removed] = entries.splice(index, 1);
  return { state: { ...state, entries }, removed };
}

/** 队列是否为空 */
export function isQueueEmpty(state: QueueState): boolean {
  return state.entries.length === 0;
}

/**
 * steer 请求纯构造（G-26 steer 态；**复用 cli steer.ts 的 buildSteerRequest / makeSteerId**，
 * 不在壳里复刻 turnId/text 校验语义）。返回 null = 不可转向（turnId 未知或文本空白），
 * 调用方据此保留草稿并报告，绝不猜 turnId——与 chat-setup.submitSteer 的 unknown 语义同源。
 */
export function buildFollowUpSteer(params: {
  turnId: string | undefined;
  seq: number;
  text: string;
  now?: number;
}): SteerRequest | null {
  return buildSteerRequest(params.turnId, makeSteerId(params.seq, params.now), params.text);
}

/** 配置读取的形状（core schema 落地 ui.follow_up_behavior 后的消费端视图） */
export interface UiFollowUpSection {
  ui?: { follow_up_behavior?: unknown };
}

export interface FollowUpBehaviorConfigResult {
  /** 配置里的合法行为；未配置或非法值均为 null（非法值看 warning） */
  readonly behavior: FollowUpBehavior | null;
  /** 非法值时的一行告警（风格对齐 mode.ts 的 parseScreenModeConfig）；合法/未配置为 null */
  readonly warning: string | null;
}

/**
 * 校验 [ui] follow_up_behavior 的原始值（防御性消费端解析：core schema 已报致命错误，
 * 这里对「绕过 schema 的调用方」兜底——非法值回退缺省 + 告警，不做致命拦截）。
 */
export function parseFollowUpBehaviorConfig(raw: unknown): FollowUpBehaviorConfigResult {
  if (raw === undefined) return { behavior: null, warning: null };
  if (typeof raw === 'string' && (FOLLOW_UP_BEHAVIORS as readonly string[]).includes(raw)) {
    return { behavior: raw as FollowUpBehavior, warning: null };
  }
  const shown = typeof raw === 'string' ? `"${raw}"` : String(raw);
  return {
    behavior: null,
    warning: `config.${FOLLOW_UP_CONFIG_PATH}: 未知值 ${shown}，回退 ${DEFAULT_FOLLOW_UP_BEHAVIOR}`,
  };
}

/** 配置对象里解析 follow_up 行为：合法值生效；未配置/非法 → 缺省 queue（+ 告警） */
export function resolveFollowUpBehavior(config: UiFollowUpSection | undefined): {
  behavior: FollowUpBehavior;
  warning: string | null;
} {
  const parsed = parseFollowUpBehaviorConfig(config?.ui?.follow_up_behavior);
  return { behavior: parsed.behavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR, warning: parsed.warning };
}
