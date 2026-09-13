// esc-machine.ts — P2-B：Esc 语义状态机（G-14～G-20，纯 reducer，时间注入便于测试）。
//
// 规格依据：docs/refs/refs-grok-build.md「G-3x Esc 语义状态表」（2026-09-13 基线
// 37949780 —— Esc 语义与旧规格相反：回合中 Esc 永不取消，取消统一走 Ctrl+C）。上游
// 实现对照：refs/grok-build xai-grok-pager/src/app/agent_view/prompt.rs 的
// try_handle_esc_policy / suppress_rewind_arm / rewind_arm_suppressed 与
// app_view.rs 的 PendingAction（ESC_DOUBLE_PRESS_TTL=800ms、expired(): now >= arm+ttl）。
//
// ── 决策优先级（一次裸 Esc 按键的自上而下裁决；与上游「卡片层 → arm 命中 → 策略」一致）──
//   1. cardDepth > 0            → exit-card（G-20 逐级退出；退到最后 park + 提示）
//   2. turnState = cancelling   → swallow（G-15 无声吞掉；G-16 负向：绝不产生取消重发）
//   3. turnState = running      → hint-cancel（G-14 提示逐字文案 + 草稿保留 + 宽限推进）
//   4. turnState = idle         → 双击武装/开火（G-17 清空+stash / G-18 rewind picker）
//                                  或吞掉（G-19 宽限期内 / 无可武装）
//
// ── 已钉死的裁决（与上游逐条对齐，含与派工文本的出入，验收时以此为准）────────
//  - G-17 双击窗口边界：开火条件为 `now - lastEscAt < DOUBLE_ESC_MS`（**800ms 整点已过期**）。
//    派工文本写「799ms 不清/800ms 清」，与规格「800ms 内双击」及上游相反而按上游实现：
//    app_view.rs `expired(): Instant::now() >= self.expires_at`（arm+800ms 整点即过期），
//    即 799ms 开火、800ms 过期重新武装。上游证据见报告。
//  - G-19：mid-turn（running **和 cancelling**）的每次 Esc 都把宽限 deadline 推到
//    now+1000ms。cancelling 侧也推（上游 suppress_rewind_arm 在 running‖cancelling 分支
//    无条件调用）：这是「Esc 连打穿越回合结束不误开 rewind」保证的必要条件，否则取消
//    期长的连打会在宽限过期后落到 idle 武装。宽限推送是内部状态，用户不可见，不违反
//    G-15「无声吞掉」/ G-16「纯 no-op」（无提示、无取消重发、无 picker）。
//  - G-19 宽限命中（idle + now < rewindGraceUntil）：Esc 被吞且**不武装**（连打穿越语义：
//    宽限内的按键不构成双击的第一下）。过期 deadline 在被查询时顺手退役（回写 0），
//    对齐上游 rewind_arm_suppressed 的 check-and-retire。
//  - G-14 提示去重（每用户回合最多一条）：本状态机每次 running Esc 都产出 hintCancel
//    （附带 dedupePerTurn: true 标记）；**去重执行在装配层**（fullscreen toast 天然覆盖；
//    minimal 需按回合号记录已写行，对齐上游 minimal_cancel_hint_turn）。通道选择也归
//    装配层：fullscreen = toast，minimal = 滚动区系统行（G-14 原文）。
//  - 双击武装不携带动作类型（上游 arm 捕获 Action，我们简化为开火时按当下状态裁决）：
//    「两次按键间状态不变」的主路径下与上游等价；状态在双击间隙被改写属边界，登记取舍。
//  - G-18「两窗格皆可武装；清草稿限 prompt 窗格」需要知道当前窗格：输入扩展可选字段
//    `pane`（缺省 'prompt'）。scrollback + 草稿非空 = 上游明文吞掉案例（"a scrollback
//    pane with a draft"），不武装清草稿、也不开 rewind。
//  - 卡片退出与 mid-turn Esc 都回写 lastEscAt: null——废弃任何残留的 idle 武装
//    （对齐上游 stale_idle_arm_while_busy：回合运行/取消中 ClearPrompt/RewindShowPicker
//    武装一律作废）。

/** 空闲双击 Esc 的确认窗口（毫秒）：第二击须在 first+800ms **之前**到达（整点已过期）。 */
export const DOUBLE_ESC_MS = 800;

/** mid-turn Esc 宽限（毫秒，G-19）：每按一次 Esc 把 rewind 武装压制 deadline 推到 now+该值。
 * 必须大于 DOUBLE_ESC_MS（宽限要能吸收整个双击手势；上游 esc_cancel_rewind_grace_outlives_double_press_ttl）。 */
export const ESC_CANCEL_REWIND_GRACE = 1000;

/** G-14 提示文案（逐字）：`Press {cancel_key} to cancel the turn`，cancel_key 默认 Ctrl+C。 */
export const ESC_CANCEL_HINT_TEXT = 'Press Ctrl+C to cancel the turn';

/** G-20 退完卡片的 park 提示（规格未钉文案；装配层可覆盖） */
export const ESC_PARK_HINT_TEXT = '已退出阻塞卡片，焦点停在滚动区（Tab 回输入框）';

/** 回合状态：running = 回合执行中；cancelling = 已请求取消、等待收尾；idle = 无回合 */
export type TurnState = 'running' | 'cancelling' | 'idle';

/** 焦点窗格（与 focus.ts/keymaps.ts 同构，独立定义避免环依赖） */
export type EscPane = 'prompt' | 'scrollback';

export interface EscMachineInput {
  readonly turnState: TurnState;
  /** 当前草稿长度（0 = 空；图片 chip 不在模型内，🟡 P7） */
  readonly draftLength: number;
  /** 打开的阻塞卡片层级数（G-21～G-25 四件套栈深；0 = 无） */
  readonly cardDepth: number;
  /** 可 rewind 的用户回合数（历史消息数） */
  readonly historyCount: number;
  /** 当前时刻（注入时钟，测试确定性） */
  readonly now: number;
  /** 上一次 idle Esc 武装时刻（双击第一击）；null = 未武装 */
  readonly lastEscAt: number | null;
  /** rewind 武装压制 deadline（G-19 绝对时刻；0 = 无） */
  readonly rewindGraceUntil: number;
  /** 当前焦点窗格（G-18 清草稿限 prompt 窗格；缺省 'prompt'） */
  readonly pane?: EscPane;
}

/** 动作 id（G-14 hint-cancel / G-15 swallow / G-17 clear-stash / G-18 open-rewind /
 *  G-20 exit-card；'none' = 仅内部状态变化——双击第一击的武装） */
export type EscActionId = 'hint-cancel' | 'swallow' | 'clear-stash' | 'open-rewind' | 'exit-card' | 'none';

/** 副作用声明（装配层执行；本机不执行 I/O、不持定时器）。**不存在任何「取消重发」字段**——
 * G-16 废除路径在类型层面不可表达（负向断言见测试：sideEffects 键集合白名单）。 */
export interface EscSideEffects {
  /** G-14：显示取消提示。fullscreen=toast、minimal=滚动区系统行；dedupePerTurn=true 表示
   * 每用户回合最多一条（去重执行在装配层）。running 分支每次都产出，装配层负责去重。 */
  readonly hintCancel?: { readonly text: string; readonly dedupePerTurn: true };
  /** G-20：退出一层卡片。parkedToScrollback=true 表示退的是最后一层，焦点 park 到
   * scrollback 并提示（文案 ESC_PARK_HINT_TEXT，装配层可覆盖）。 */
  readonly exitCard?: { readonly remainingDepth: number; readonly parkedToScrollback: boolean };
  /** G-17：清空草稿并 stash（草稿进 stash、绝不进历史——上游 "the cleared draft goes to
   * the stash, never to the history"）。 */
  readonly clearStash?: { readonly stashedDraftLength: number };
  /** G-18：打开 rewind picker（与 /rewind 同入口；两窗格皆可武装） */
  readonly openRewind?: { readonly armedFrom: EscPane };
  /** G-19：回写宽限 deadline（now+ESC_CANCEL_REWIND_GRACE）；退役时回写 0 */
  readonly rewindGraceUntil?: number;
  /** 回写双击武装时刻：武装 = now；开火/卡片退出/mid-turn = null（废弃残留武装） */
  readonly lastEscAt?: number | null;
}

export interface EscDecision {
  readonly action: EscActionId;
  readonly sideEffects: EscSideEffects;
}

/** 双击窗口判定：now - arm < 800ms 开火（arm+800 整点已过期，见文件头裁决）。 */
export function withinDoubleEscWindow(lastEscAt: number, now: number): boolean {
  return now - lastEscAt < DOUBLE_ESC_MS;
}

/**
 * Esc 语义裁决（G-14～G-20 逐行复刻；纯函数，时间/窗格由输入注入）。
 * 只裁决**裸 Esc**（无修饰键的 escape 键）；带修饰的 Esc（Alt+Esc 等）不经此入口。
 */
export function reduceEsc(input: EscMachineInput): EscDecision {
  const pane = input.pane ?? 'prompt';

  // 1. 阻塞卡片打开（G-20）：逐级退出，退到最后 park 到 scrollback 并提示。
  //    卡片层优先于回合状态（上游卡片 Esc 处理先于 esc policy）；卡片退出期间不武装。
  if (input.cardDepth > 0) {
    const parked = input.cardDepth === 1;
    return {
      action: 'exit-card',
      sideEffects: {
        exitCard: { remainingDepth: input.cardDepth - 1, parkedToScrollback: parked },
        lastEscAt: null, // 卡片按键废弃任何 idle 武装（对齐 stale_idle_arm_while_busy）
      },
    };
  }

  // 2. 取消中（G-15/G-16）：无声吞掉（连提示也不给），绝不产生取消重发。
  //    但宽限 deadline 照推（见文件头裁决：长取消期连打的必要保护；内部状态不可见）。
  if (input.turnState === 'cancelling') {
    return {
      action: 'swallow',
      sideEffects: {
        rewindGraceUntil: input.now + ESC_CANCEL_REWIND_GRACE,
        lastEscAt: null,
      },
    };
  }

  // 3. 回合运行中（G-14）：永不取消——提示逐字文案；草稿原样保留（不产任何草稿变更
  //    副作用）；宽限推进（G-19）。提示去重由装配层按 dedupePerTurn 执行。
  if (input.turnState === 'running') {
    return {
      action: 'hint-cancel',
      sideEffects: {
        hintCancel: { text: ESC_CANCEL_HINT_TEXT, dedupePerTurn: true },
        rewindGraceUntil: input.now + ESC_CANCEL_REWIND_GRACE,
        lastEscAt: null, // 废弃任何 idle 残留武装（回合中不开火，见 stale_idle_arm_while_busy）
      },
    };
  }

  // ── 4. 空闲（G-17/G-18/G-19）──
  // 4a. G-19 宽限查询：宽限期内吞掉且不武装（Esc 连打穿越回合结束不误开 rewind）；
  //     过期 deadline 顺手退役（回写 0，对齐上游 check-and-retire）。
  if (input.rewindGraceUntil > 0) {
    if (input.now < input.rewindGraceUntil) {
      return { action: 'swallow', sideEffects: {} };
    }
    // 过期：退役后继续走常规武装裁决（退役副作用与武装副作用合并）
    return idleEscDecision(input, pane, { rewindGraceUntil: 0 });
  }
  return idleEscDecision(input, pane, {});
}

/** 空闲 Esc 的武装/开火/吞掉裁决（gracePrelude = 宽限退役等前置副作用） */
function idleEscDecision(input: EscMachineInput, pane: EscPane, gracePrelude: EscSideEffects): EscDecision {
  const armed = input.lastEscAt !== null && withinDoubleEscWindow(input.lastEscAt, input.now);

  // 4b. 双击开火：清草稿限 prompt 窗格（G-18 括注）；rewind 两窗格皆可（G-18）。
  if (armed && input.lastEscAt !== null) {
    if (pane === 'prompt' && input.draftLength > 0) {
      return {
        action: 'clear-stash',
        sideEffects: { ...gracePrelude, clearStash: { stashedDraftLength: input.draftLength }, lastEscAt: null },
      };
    }
    if (input.draftLength === 0 && input.historyCount > 0) {
      return {
        action: 'open-rewind',
        sideEffects: { ...gracePrelude, openRewind: { armedFrom: pane }, lastEscAt: null },
      };
    }
    // 武装后状态被改写（如清了草稿 / 历史清空）：不误开火，落到下方重新武装/吞掉
  }

  // 4c. 武装第一击（静默）：prompt+非空草稿（G-17 预备）；空草稿+有历史（G-18 预备，两窗格）。
  const canArmClear = pane === 'prompt' && input.draftLength > 0;
  const canArmRewind = input.draftLength === 0 && input.historyCount > 0;
  if (canArmClear || canArmRewind) {
    return { action: 'none', sideEffects: { ...gracePrelude, lastEscAt: input.now } };
  }

  // 4d. 无可武装：吞掉（scrollback+非空草稿 / 空草稿无历史——上游明文案例）。
  return { action: 'swallow', sideEffects: gracePrelude };
}
