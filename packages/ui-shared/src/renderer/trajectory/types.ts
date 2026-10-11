// 轨迹视图数据模型（D-41/D-42/D-44/D-47）。
//
// 本文件只有类型与常量：**投影**（事件流 → 模型）在 projection.ts，呈现组件只读模型。
// 口径三条（与 SPEC D-4x 对齐）：
//   1. 模型字段只来自**真实数据**（事件 payload / ts / 明确的观测注入）；
//   2. 「未知」一律用 null（不是 0、不是估算）—— UI 据此留空（D-47：进行中的行不虚构耗时）；
//   3. 嵌套子工具的行位由**真实 payload 的父引用**决定（args.parentCallId），无引用不发明层级。
import type { TurnEndInfo } from '../chat-model.js';

/** 步骤角色：用户 / 助手 / 工具 / 嵌套子工具 / 轮次之间（独立压缩请求，D-47） */
export type TrajectoryStepRole = 'user' | 'assistant' | 'tool' | 'subtool' | 'between-turns';

/** 步骤终态：ok=已完成；failed=失败（attempt/工具失败）；running=进行中；cancelled=被取消 */
export type TrajectoryStepState = 'ok' | 'failed' | 'running' | 'cancelled';

/** token 用量（字段缺失即 undefined —— 不补 0，UI 显示「未记录」） */
export interface TrajectoryUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/** 附件摘要（只统计真实出现在 payload 里的条目；缺数据 = 空数组，UI 显示「无」） */
export interface TrajectoryAttachment {
  readonly kind: 'image' | 'file';
  readonly name?: string;
  readonly mimeType?: string;
  /** 图片附件的会话内标识（D-39 图片 URL 缓存的键） */
  readonly id?: string;
}

/**
 * 时间三元组（真实开始时间 / 结束时间 / 耗时）。
 * `endedAtMs === null` 表示「未结束」—— 进行中的行**不虚构耗时**（D-47）。
 */
export interface TrajectoryTiming {
  readonly startedAtMs: number | null;
  readonly endedAtMs: number | null;
  readonly durationMs: number | null;
  /** 助手行：首 token 延迟（TTFT）；数据不足 = null，UI 留空 */
  readonly ttftMs: number | null;
  /** 助手行：解码段（首 token → 末 token）；数据不足 = null */
  readonly decodeMs: number | null;
}

export interface TrajectoryStep {
  /** 稳定语义行键（跨重渲染/补页不变；虚拟化与 ARIA 索引用它，而不用数组下标） */
  readonly key: string;
  readonly role: TrajectoryStepRole;
  /** 缩进层级：0=顶层，>0=嵌套子工具 */
  readonly depth: number;
  /** 轮次内紧凑步骤序号（1 起；D-41「行内紧凑标记」） */
  readonly stepMarker: number;
  readonly seq: number;
  readonly turnId?: string;
  readonly label: string;
  readonly state: TrajectoryStepState;
  readonly timing: TrajectoryTiming;
  readonly text?: string;
  readonly reasoning?: string;
  readonly model?: string;
  readonly usage?: TrajectoryUsage;
  readonly callId?: string;
  readonly tool?: string;
  readonly args?: unknown;
  readonly output?: string;
  readonly error?: string;
  /** 子会话跳转（subagent 工具的真实 childSessionId；缺 = undefined） */
  readonly childSessionId?: string;
  /** 归属的模型 step（step/start 的 stepId）—— TTFT 观测的键 */
  readonly modelStepId?: string;
  /** 真实附件（无 = 空数组，UI 显示「无」） */
  readonly attachments: readonly TrajectoryAttachment[];
}

export interface TrajectoryTurn {
  readonly id: string;
  /** 轮次序号（1 起） */
  readonly index: number;
  readonly label: string;
  readonly startSeq: number;
  readonly endSeq: number;
  readonly timing: TrajectoryTiming;
  /** 进行中（会话 running 且是本轮）—— 该轮不虚构结束时间/耗时 */
  readonly running: boolean;
  readonly steps: readonly TrajectoryStep[];
  /** 轮次 token 合计（仅在有真实 usage 时给出对应字段） */
  readonly usage: TrajectoryUsage;
  /** 来自 turn-end 帧的终态（无 = 纯重放，不发明 stopReason） */
  readonly turnEnd?: TurnEndInfo;
}

/** 独立压缩请求（D-47：`compaction/applied` 归入 Between turns 区段） */
export interface TrajectoryBetweenTurnEntry {
  readonly key: string;
  readonly seq: number;
  readonly summary: string;
  readonly coveredUpToSeq: number;
  readonly timing: TrajectoryTiming;
}

/** 记录表行（虚拟化的单位；键全部语义稳定） */
export type TrajectoryRow =
  | {
      readonly kind: 'turn-boundary';
      readonly key: string;
      readonly turnIndex: number;
      readonly turn: TrajectoryTurn;
    }
  | {
      readonly kind: 'step';
      readonly key: string;
      readonly turnIndex: number;
      readonly step: TrajectoryStep;
    }
  | {
      readonly kind: 'between-turns-boundary';
      readonly key: string;
    }
  | {
      readonly kind: 'between-turns';
      readonly key: string;
      readonly entry: TrajectoryBetweenTurnEntry;
    };

export interface TrajectoryModel {
  readonly sessionId: string;
  readonly turns: readonly TrajectoryTurn[];
  readonly betweenTurns: readonly TrajectoryBetweenTurnEntry[];
  readonly rows: readonly TrajectoryRow[];
  /** 模型里是否含进行中的步骤（UI 据此标注「进行中，耗时待定」） */
  readonly hasRunningSteps: boolean;
}

/** 无轮次归属事件（旧日志缺 turnId）的合成轮次 id */
export const UNASSIGNED_TURN_ID = '(未归属轮次)';

/** Between turns 区段的显示标题（D-47 原文用词，不翻译以免对不上上游） */
export const BETWEEN_TURNS_LABEL = 'Between turns';
