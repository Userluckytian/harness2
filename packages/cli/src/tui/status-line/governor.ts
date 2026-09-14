// governor.ts — 状态行刷新调度与失败降级（G-46 / G-47 / G-48，纯状态机，时钟注入）。
//
// 规格依据：refs-grok-build.md G-46～G-48 与上游 25-status-line.md「How it works /
// Refresh runs」节。本机是**纯 reducer**：时间全部由调用方注入（事件携带 nowMs），
// 不持有任何真实 timer —— 装配层按 directives 起真实定时器/子进程，再以事件回填结果。
// 装配层契约：`start-run` 指令 = 立即用该 trigger 构造 payload 启动脚本（状态机已把
// runActive 记为 true，无需回填 run-started 事件）；`schedule-*` 指令 = 到期后回填
// 对应事件（debounce-elapsed / timer-fire）；`started` 事件 = 装配完成时发一次，自举
// refresh_interval 的首个定时器（否则 schedule-timer 无初始来源，见 reduceStarted）。语义逐条对齐：
//
//  G-46 刷新策略：
//   - 事件驱动 + 300ms 防抖（urgent 100ms：resize / 新快照 / 切换 agent）；
//   - **运行中的脚本永不取消**：进行中到达的变化累积为 dirty（urgent 优先），脚本结束后
//     再排一次防抖；
//   - refresh_interval（仅 command 型）定时重跑；**错过的火并作一次**（owed ≤ 1，
//     「never a burst for the fires a suspend or a long turn skipped」）；火等脚本让位，
//     节奏按到期点续算（cadence 不漂移）；
//   - 火的归属：出发时 owed > 0 的运行携带 trigger='refresh_interval'（「a state change
//     landing while a timer fire is owed rides that run」），否则 'state'。
//
//  G-47 输出与超时：
//   - 脚本成功但零输出 → **收掉整行**（row taken away），绝不回退 builtin（上游明文）；
//   - 超时是失败的一种，画行文案 = STATUS_LINE_TIMEOUT_TEXT（'[status line: timed out]'）。
//
//  G-48 失败降级：
//   - **每一次失败都产生 log-failure 指令**（装配层写 unified 日志；G-48「失败写
//     ~/.grok/logs/unified.jsonl」——本仓按 .harness2 家目录约定落盘，见 runner.ts）；
//   - **state 触发的失败立刻画错误行**（上游：A run triggered by session state still
//     reports its failure at once, as ever）；
//   - **refresh 触发的失败保住上一次输出**（keep the last output），连续三次失败才画错误；
//   - refresh 失败但**从未成功回答过**（无 last output 可保）→ 立刻画（nothing to keep）；
//   - 连续失败计数跨 state/refresh 累计（三次 = 连续不成功运行的总账；任一次成功清零）。
import {
  STATUS_LINE_DEBOUNCE_MS,
  STATUS_LINE_URGENT_DEBOUNCE_MS,
  STATUS_LINE_TIMEOUT_TEXT,
  type ResolvedStatusLineSettings,
} from './config.js';
import type { StatusLineTrigger } from './contract.js';

/** 状态机输入事件（装配层注入；nowMs 全部显式传入——本模块零时钟依赖） */
export type StatusLineGovernorEvent =
  | { type: 'state-changed'; urgent?: boolean; nowMs: number }
  /** 装配完成（G-46 自举）：command 型首次武装 refresh_interval 节奏——见 reduceStarted */
  | { type: 'started'; nowMs: number }
  | { type: 'timer-fire'; nowMs: number }
  | { type: 'debounce-elapsed'; nowMs: number }
  | { type: 'run-finished'; outcome: StatusLineRunOutcome; nowMs: number };

/** 一次运行的结果（runner.ts 的产出投影） */
export type StatusLineRunOutcome =
  { ok: true; lines: readonly string[] } | { ok: false; timedOut?: boolean; error: string };

/** 一次「应该被画的行」的裁决结果（run-finished 时给出；装配层据此上屏/收行/画错误） */
export type StatusLinePaint = { kind: 'output'; lines: readonly string[] } | { kind: 'error'; message: string };

/** 装配层动作指令（reducer 的输出；装配层据此驱动真实 timer / 子进程 / 日志） */
export type StatusLineDirective =
  | { kind: 'schedule-debounce'; fireAtMs: number }
  | { kind: 'schedule-timer'; fireAtMs: number }
  | { kind: 'start-run'; trigger: StatusLineTrigger }
  | { kind: 'log-failure'; message: string; timedOut: boolean };

export interface StatusLineGovernorState {
  readonly settings: ResolvedStatusLineSettings;
  /** 上一次成功输出；null = 从未成功回答（首绘前） */
  readonly lastOutput: readonly string[] | null;
  /** 连续失败计数（任一次成功清零；G-48 三连败阈值） */
  readonly consecutiveFailures: number;
  readonly runActive: boolean;
  /** 本次运行由哪种触发出发（G-48 失败分派按它判定 state / refresh） */
  readonly runTrigger: StatusLineTrigger | null;
  /** 脚本运行期间到达的变更（urgent 取过一次就保持——后到的普通变更不降级） */
  readonly dirty: boolean;
  readonly dirtyUrgent: boolean;
  /** 防抖到期时刻（null = 无待办） */
  readonly debounceDeadline: number | null;
  /** 定时器到期时刻（null = 未启用 refresh_interval） */
  readonly timerDeadline: number | null;
  /** 错过未消费的 timer 火（并发合并，恒 ≤ 1） */
  readonly owedTimerFires: number;
}

/** G-48：连续三次失败才在状态行画错误（refresh 触发失败保输出的放行上限） */
export const CONSECUTIVE_FAILURES_BEFORE_ERROR = 3;

/** 初始状态（disabled / builtin 行永不跑脚本、不排定时器） */
export function createStatusLineGovernorState(settings: ResolvedStatusLineSettings): StatusLineGovernorState {
  return {
    settings,
    lastOutput: null,
    consecutiveFailures: 0,
    runActive: false,
    runTrigger: null,
    dirty: false,
    dirtyUrgent: false,
    debounceDeadline: null,
    timerDeadline: null,
    owedTimerFires: 0,
  };
}

/** 该行是否运行外部脚本（G-46：refresh_interval under builtin schedules nothing） */
export function runsScript(state: StatusLineGovernorState): boolean {
  return state.settings.type === 'command' && state.settings.command !== undefined;
}

/** reduction 结果：新状态 + 指令 + 可选的画行裁决（run-finished 才有） */
export interface StatusLineGovernorReduction {
  readonly state: StatusLineGovernorState;
  readonly directives: readonly StatusLineDirective[];
  readonly paint: StatusLinePaint | null;
}

const NO_PAINT = null;

/**
 * 事件归约（纯函数；同输入恒同输出）。
 * 事件流 = 装配层的真实世界：state 变化 → 防抖到期 → 出发 run → 回填结果 →
 * （dirty/owed → 下一轮，指令与状态同步给出）。
 */
export function reduceStatusLineGovernor(
  state: StatusLineGovernorState,
  event: StatusLineGovernorEvent,
): StatusLineGovernorReduction {
  switch (event.type) {
    case 'state-changed':
      return reduceStateChanged(state, event.urgent === true, event.nowMs);
    case 'started':
      return reduceStarted(state, event.nowMs);
    case 'timer-fire':
      return reduceTimerFire(state, event.nowMs);
    case 'debounce-elapsed':
      return reduceDebounceElapsed(state);
    case 'run-finished':
      return reduceRunFinished(state, event.outcome, event.nowMs);
  }
}

/**
 * 出发一次 run：trigger 由 owed 决定（G-46 火的归属）；出发即消费 owed、清防抖待办、
 * 记 runTrigger（run-finished 的 state/refresh 失败分派依据）。
 */
function startRun(state: StatusLineGovernorState): { state: StatusLineGovernorState; directive: StatusLineDirective } {
  const trigger: StatusLineTrigger = state.owedTimerFires > 0 ? 'refresh_interval' : 'state';
  return {
    state: { ...state, runActive: true, runTrigger: trigger, debounceDeadline: null, owedTimerFires: 0 },
    directive: { kind: 'start-run', trigger },
  };
}

/** state-changed：运行中 → 记 dirty；空闲 → 排防抖（urgent 100 / 普通 300，取更早者） */
function reduceStateChanged(
  state: StatusLineGovernorState,
  urgent: boolean,
  nowMs: number,
): StatusLineGovernorReduction {
  if (!runsScript(state)) return { state, directives: [], paint: NO_PAINT };
  if (state.runActive) {
    const dirtyUrgent = state.dirtyUrgent || urgent;
    return { state: { ...state, dirty: true, dirtyUrgent }, directives: [], paint: NO_PAINT };
  }
  const target = nowMs + (urgent ? STATUS_LINE_URGENT_DEBOUNCE_MS : STATUS_LINE_DEBOUNCE_MS);
  const deadline = state.debounceDeadline === null ? target : Math.min(state.debounceDeadline, target);
  return {
    state: { ...state, debounceDeadline: deadline },
    directives: [{ kind: 'schedule-debounce', fireAtMs: deadline }],
    paint: NO_PAINT,
  };
}

/**
 * started（G-46 自举）：command 型状态行装配完成时排下**首个** refresh_interval 定时器。
 *
 * 缺口修复说明：`schedule-timer` 原本只由 timer-fire 产出，而装配层只为「已排定的定时器」
 * 回填 timer-fire——首个定时器没有任何来源（鸡生蛋），refresh_interval 在真实 harness 中
 * 从不生效。本事件补上这个初始来源：装配层启动时发一次 started，由此排出第一火。
 *
 * 语义边界（不改 G-47/G-48 分派）：不发 start-run（首次绘制仍由 state 变化的事件驱动路径
 * 负责，避免首个运行被打上 refresh 触发而与上游「首次由会话状态触发」口径不符）；builtin /
 * disabled 或未配 refresh_interval 不排；已有定时器（重入）不重排。
 */
function reduceStarted(state: StatusLineGovernorState, nowMs: number): StatusLineGovernorReduction {
  if (!runsScript(state) || state.settings.refreshIntervalSec === undefined || state.timerDeadline !== null) {
    return { state, directives: [], paint: NO_PAINT };
  }
  const fireAtMs = nowMs + state.settings.refreshIntervalSec * 1000;
  return {
    state: { ...state, timerDeadline: fireAtMs },
    directives: [{ kind: 'schedule-timer', fireAtMs }],
    paint: NO_PAINT,
  };
}

/** timer-fire：火到期 → 续算下一火（cadence 按到期点）；脚本/防抖占位时欠火，否则立即出发 */
function reduceTimerFire(state: StatusLineGovernorState, nowMs: number): StatusLineGovernorReduction {
  if (!runsScript(state) || state.settings.refreshIntervalSec === undefined) {
    return { state, directives: [], paint: NO_PAINT };
  }
  const nextTimer = nowMs + state.settings.refreshIntervalSec * 1000;
  const directives: StatusLineDirective[] = [{ kind: 'schedule-timer', fireAtMs: nextTimer }];
  const withTimer: StatusLineGovernorState = { ...state, timerDeadline: nextTimer };
  // 火不 stack：运行中 / 防抖待办里先欠着（owed ≤ 1），下一次 run 出发时消费
  if (withTimer.runActive || withTimer.debounceDeadline !== null) {
    return { state: { ...withTimer, owedTimerFires: 1 }, directives, paint: NO_PAINT };
  }
  const started = startRun({ ...withTimer, owedTimerFires: 1 });
  return { state: started.state, directives: [...directives, started.directive], paint: NO_PAINT };
}

/** 防抖到期：出发 run（owed > 0 则本次运行携带 refresh_interval——火搭车） */
function reduceDebounceElapsed(state: StatusLineGovernorState): StatusLineGovernorReduction {
  if (!runsScript(state) || state.runActive) return { state, directives: [], paint: NO_PAINT };
  const started = startRun(state);
  return { state: started.state, directives: [started.directive], paint: NO_PAINT };
}

/**
 * run-finished：画行裁决（G-47/G-48）+ 记账 + 视 dirty/owed 安排后续。
 * 运行永不取消（G-46）——本事件是唯一让 runActive 翻回 false 的路径。
 */
function reduceRunFinished(
  state: StatusLineGovernorState,
  outcome: StatusLineRunOutcome,
  nowMs: number,
): StatusLineGovernorReduction {
  if (!runsScript(state) || !state.runActive) return { state, directives: [], paint: NO_PAINT };
  const settled: StatusLineGovernorState = {
    ...state,
    runActive: false,
    runTrigger: null,
    dirty: false,
    dirtyUrgent: false,
    debounceDeadline: null,
  };
  const directives: StatusLineDirective[] = [];

  if (outcome.ok) {
    // 记账成功：lastOutput 覆盖（可为空数组 = 收行）、连败清零，再安排后续
    const follow = followUpTransition(state, nowMs);
    const nextState: StatusLineGovernorState = {
      ...settled,
      lastOutput: [...outcome.lines],
      consecutiveFailures: 0,
      ...follow.stateDelta,
    };
    directives.push(...follow.directives);
    return { state: nextState, directives, paint: { kind: 'output', lines: [...outcome.lines] } };
  }

  const timedOut = outcome.timedOut === true;
  const message = timedOut ? STATUS_LINE_TIMEOUT_TEXT : outcome.error;
  const consecutiveFailures = state.consecutiveFailures + 1;
  directives.push({ kind: 'log-failure', message: outcome.error, timedOut });

  // 画行裁决（G-48 + 上游 Refresh runs 节）：
  // state 触发 → 立刻画；refresh 触发 → 有 last output 且未三连败 → 保住；否则立刻画。
  const isRefreshRun = state.runTrigger === 'refresh_interval';
  let paint: StatusLinePaint;
  if (!isRefreshRun) {
    paint = { kind: 'error', message };
  } else if (state.lastOutput !== null && consecutiveFailures < CONSECUTIVE_FAILURES_BEFORE_ERROR) {
    paint = { kind: 'output', lines: state.lastOutput }; // keep the last output
  } else {
    paint = { kind: 'error', message };
  }

  const follow = followUpTransition(state, nowMs);
  const failedState: StatusLineGovernorState = {
    ...settled,
    consecutiveFailures,
    // 保住 last output 的失败不覆盖 lastOutput（脚本没回答，旧行仍在画）
    lastOutput: state.lastOutput,
    ...follow.stateDelta,
  };
  directives.push(...follow.directives);
  return { state: failedState, directives, paint };
}

/**
 * 运行结束后的后续转移：dirty → 排防抖（脚本运行期间的变更不丢）；无 dirty 但 owed →
 * 立即出发下一次 run（状态机同步记 runActive——指令即执行，无需回填）。
 * 参数 state = 运行结束前的状态（dirty/owed 记账都在它身上）。
 */
function followUpTransition(
  state: StatusLineGovernorState,
  nowMs: number,
): { stateDelta: Partial<StatusLineGovernorState>; directives: StatusLineDirective[] } {
  if (state.dirty) {
    const at = nowMs + (state.dirtyUrgent ? STATUS_LINE_URGENT_DEBOUNCE_MS : STATUS_LINE_DEBOUNCE_MS);
    return { stateDelta: { debounceDeadline: at }, directives: [{ kind: 'schedule-debounce', fireAtMs: at }] };
  }
  if (state.owedTimerFires > 0) {
    const started = startRun(state);
    return { stateDelta: started.state, directives: [started.directive] };
  }
  return { stateDelta: {}, directives: [] };
}
