// submit-policy.ts — composer 提交策略纯函数（D-35 繁忙态 Enter / D-36 主指针操作）。
//
// 规格依据：docs/refs/refs-deepseek-harness.md D-35、D-36（含 2026-09-13 修正：繁忙标签
// **不再固定 Queue Send**，而是跟随繁忙态 Enter 投递模式）与上游
// `packages/client/ui-conversation/src/client/input/submission-policy.ts`
// （`resolveSubmitMode`）+ `skeleton/InputBar.tsx` 的主按钮判定 + Agent Note
// `2026-09-04-busy-send-button-follows-enter-setting.zh.md`。
//
//   - D-35：繁忙态 Enter 设置二选 Queue（进 QueueDock）/ Steer（pending-steering）；空闲态
//     进 transcript；
//   - D-36：主按钮在 Stop 与 Send 之间切换（**不并列两个按钮**）；繁忙态可提交时标签跟随
//     Enter 投递模式（排队发送 / 插话发送），Cmd/Ctrl+Enter 恒用**另一**模式；空闲、空草稿与
//     `/` 命令行保留普通 Send（发送）标签。
//
// 本模块只做决策：零 DOM / 零 React / 零 i18n 运行时（标签直接给中文文案，与壳内既有文案一致）。
import type { SubmitIntentShape } from '../../../shared/protocol.js';
import type { SubmissionPlacement } from './composer-state.js';

/** 繁忙态 Enter 的投递偏好（= core `SubmitIntent` / Host `busyEnter` 两态） */
export type BusyEnterBehavior = SubmitIntentShape;
export const DEFAULT_BUSY_ENTER_BEHAVIOR: BusyEnterBehavior = 'queue';

/** 提交手势：普通 Enter（或主 Send 按钮）与 Cmd/Ctrl 加速和弦 */
export type ComposerSubmitGesture = 'enter' | 'accelerated';

/** Enter 投递落点（D-35） */
export type EnterDelivery = 'transcript' | 'enqueue' | 'steer';

/** 主按钮语义（D-36：同一位置在 Stop 与 Send 之间切换） */
export type MainButtonKind = 'stop' | 'send';

/** 标签来源（文案 key 同上游 `input.send` / `input.send.queue` / `input.send.steer` / `input.stop`） */
export type SendLabelKind = 'input.stop' | 'input.send' | 'input.send.queue' | 'input.send.steer';

export interface SubmitPolicyInput {
  /** 当前会话是否有运行中的回合（繁忙） */
  readonly running: boolean;
  /** 繁忙态 Enter 偏好（设置二选） */
  readonly busyEnter: BusyEnterBehavior;
  /** 本会话传输层是否支持 steer（false 时一切投递回退 queue） */
  readonly steeringAvailable: boolean;
  /** 草稿是否有可提交内容（文本非空白**或**带附件） */
  readonly submittable: boolean;
  /** 行首 `/`（未被认领的命令行）：点击走命令裁定，不是消息投递 */
  readonly slashCommand: boolean;
  /** 仍有文件在传（未 ready）：此时按钮禁用、不提交 */
  readonly uploadsPending: boolean;
  /** composer 锁定（无会话 / owner block / parent 离线） */
  readonly locked: boolean;
  /** Stop 操作是否有目标（无活跃 turn 时 Stop 禁用） */
  readonly stopAvailable: boolean;
}

export interface EnterPolicy {
  readonly delivery: EnterDelivery;
  readonly placement: SubmissionPlacement;
  readonly intent: SubmitIntentShape;
}

export interface MainButtonPolicy {
  readonly kind: MainButtonKind;
  /** 面向用户的中文标签（与壳内既有文案一致） */
  readonly label: string;
  readonly labelKind: SendLabelKind;
  readonly disabled: boolean;
  /** 主按钮按 plain Enter 解析出的模式投递（D-36：按钮与 Enter 同模式） */
  readonly submitMode: BusyEnterBehavior;
}

/**
 * 提交模式裁决（上游 `resolveSubmitMode` 同形）：
 * 非繁忙或本会话不支持 steer → 恒 queue；否则普通 Enter 用偏好、加速和弦用**相反**模式。
 */
export function resolveSubmitMode(
  preferred: BusyEnterBehavior,
  running: boolean,
  gesture: ComposerSubmitGesture,
  steeringAvailable: boolean,
): BusyEnterBehavior {
  if (!running || !steeringAvailable) return 'queue';
  if (gesture === 'enter') return preferred;
  return preferred === 'queue' ? 'steer' : 'queue';
}

/** Enter（或主按钮）投递裁决：空闲 → transcript；繁忙 Queue → enqueue；繁忙 Steer → steer（D-35）。 */
export function resolveEnterPolicy(input: SubmitPolicyInput, gesture: ComposerSubmitGesture = 'enter'): EnterPolicy {
  const mode = resolveSubmitMode(input.busyEnter, input.running, gesture, input.steeringAvailable);
  if (!input.running) return { delivery: 'transcript', placement: 'transcript', intent: 'queue' };
  if (mode === 'queue') return { delivery: 'enqueue', placement: 'queue-dock', intent: 'queue' };
  return { delivery: 'steer', placement: 'pending-steering', intent: 'steer' };
}

/**
 * 主按钮裁决（D-36，上游 `InputBar` 的 `primaryStops` / `primaryLabel` 判定同构）：
 *   - 繁忙且（空草稿 / 锁定）→ **Stop**（同一位置，绝不并列两按钮）；
 *   - 否则 → **Send**：繁忙可提交、支持 steer、无待传文件、非 `/` 命令行 → 标签跟随 Enter
 *     模式（排队发送 / 插话发送）；空闲、空草稿、`/` 命令行、有待传文件、不支持 steer →
 *     普通「发送」。
 * 禁用：Stop 无目标时禁用；Send 在不可提交 / 锁定 / 待传文件时禁用。
 */
export function resolveMainButton(input: SubmitPolicyInput): MainButtonPolicy {
  const submitMode = resolveSubmitMode(input.busyEnter, input.running, 'enter', input.steeringAvailable);
  if (input.running && (!input.submittable || input.locked)) {
    return { kind: 'stop', label: '停止', labelKind: 'input.stop', disabled: !input.stopAvailable, submitMode };
  }
  const disabled = !input.submittable || input.locked || input.uploadsPending;
  const plainMessageDraft = input.submittable && !input.slashCommand;
  const followMode =
    input.running && input.steeringAvailable && !input.locked && !input.uploadsPending && plainMessageDraft;
  if (followMode) {
    return submitMode === 'steer'
      ? { kind: 'send', label: '插话发送', labelKind: 'input.send.steer', disabled, submitMode }
      : { kind: 'send', label: '排队发送', labelKind: 'input.send.queue', disabled, submitMode };
  }
  return { kind: 'send', label: '发送', labelKind: 'input.send', disabled, submitMode };
}

/** 当前是否允许发起一次提交（空草稿 / 锁定 / 待传文件一律不提交） */
export function canSubmit(input: SubmitPolicyInput): boolean {
  return !input.locked && !input.uploadsPending && input.submittable;
}

/**
 * 提交落点的用户可见文案（P2-1：`PendingSubmission.placement` 的**真实消费方** ——
 * 主按钮旁的状态行）。三态一一对应 D-35 的投递落点，不猜、不含糊。
 */
export function placementNotice(placement: SubmissionPlacement): string {
  switch (placement) {
    case 'transcript':
      return '已发送（transcript），等待服务端确认…';
    case 'queue-dock':
      return '已排队（queue-dock），等待服务端确认…';
    case 'pending-steering':
      return '已插话（pending-steering），等待本步边界生效…';
  }
}
