// turn-work.tsx — Z-97（T4b）轮次耗时行「工作中 {duration} / 已工作 {duration} / 已停止」。
//
// 规格依据：refs-zcode.md Z-97「轮次级耗时」（ConversationTurnGroup.tsx:655-675 的三态标签：
// interrupted →「已停止」优先于耗时；running →「工作中 {duration}」；completed →「已工作
// {duration}」）+ denia-ui-analysis.md ⑤ WorkIndicator 段的三个工程点：
//   1. **memo 叶子自持 tick**：1s interval 只在 running 期间存在（卸载/终态即停），
//      `now` 是叶子内部 state —— 时间流逝不重投影 items、不重渲染父链（tick 纪律）；
//   2. **起点取事件 ts**（epoch ms，派生层 workStartedAt）：切会话往返重放后计时不重置；
//   3. **完成态锁协议事实**：durationMs = turnEndedAt − startedAt 在派生层一次算死，
//      不随 tick 漂移（ZCode conversationTurnWorkSegments 同口径）；数字 tabular-nums 防抖。
//
// 红线⑩（不显示假值）：起点 ts 缺失 / 终态时刻缺失 → 字段缺省 → 本组件返回 null，
// 不渲染「undefined / NaN / 0 秒」。刻意**无动画**（Z-97：工具行不用旋转 spinner 的同一
// 纪律延伸到本行；纯文案无 keyframes → 无需 prefers-reduced-motion 降级块）。
// T4a 合成终态（synthetic）文案「已停止（无响应超时）」与真停「已停止」区分。
import { memo, useEffect, useState } from 'react';
import { formatWorkDuration } from '../chat-model.js';

/** running 计时 tick 间隔（ZCode ConversationTimeline.tsx:112 RUNNING_WORK_DURATION_TICK_MS 同值） */
export const WORK_TICK_MS = 1_000;

// U2-C3 停因归因拆分（读 chat-model/store 语义的结论，登记于此；替代原
// `STOPPED_REASONS = Set{cancelled, interrupted}` 的合并口径）：
//   - `cancelled` = **用户主动停止**——唯一生产者：core loop.ts 的 signal abort（ws `op:'abort'`
//     / stop 按钮 / stopAll）。「新消息」**不会** abort 运行中 turn：运行中提交走 queue/steer
//     意图（S6 安全 step 边界消费 steer），turn 不因此终止 → 文案「已停止」；
//   - `interrupted` 在本仓只有合成来源：store 悬挂收敛（synthetic=true，恒配 interrupted）
//     → 由更早的 synthetic 分支给「已停止（无响应超时）」；
//     非合成的 interrupted 属协议前向兼容预留位（本仓 core TurnStopReason 暂无生产者；
//     语义待协议方生产后按归因细化）→ 此处给中性文案「已停止」。
//   其余终态（end_turn/error/max_steps/…）走「已工作 {duration}」。

export interface WorkIndicatorProps {
  /** 本轮首事件墙钟（epoch ms；派生层自事件 ts 解析，旧数据缺省） */
  startedAt?: number;
  /** running 中（会话 running 且本轮无终态；派生层回填） */
  running?: boolean;
  /** 终态锁定耗时（ms；派生层 = turnEndedAt − startedAt，数据不足缺省） */
  durationMs?: number;
  /** T4a：终态为本地合成（悬挂收敛 interrupted，仅 UI 态） */
  synthetic?: boolean;
  /** 终态 stopReason（协议事实；synthetic 时恒为 interrupted） */
  stopReason?: string;
}

/**
 * Z-97 轮次耗时标签（memo 叶子；tick 只重渲染本组件）。
 * 三态优先级（ZCode ConversationTurnGroup.tsx:655-675 同序）：
 *   synthetic →「已停止（无响应超时）」；真停 →「已停止」；running →「工作中 {现算}」；
 *   其余终态有锁定耗时 →「已工作 {duration}」；数据不足 → null（不显示假值）。
 */
export const WorkIndicator = memo(function WorkIndicator({
  startedAt,
  running,
  durationMs,
  synthetic,
  stopReason,
}: WorkIndicatorProps) {
  // running 且起点可用才起表；终态/卸载即停（禁止每会话常驻定时器 —— Z-97 tick 纪律）
  const ticking = running === true && startedAt !== undefined;
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), WORK_TICK_MS);
    return () => clearInterval(id);
  }, [ticking]);

  let label: string | null;
  if (synthetic === true) label = '已停止（无响应超时）';
  // U2-C3 归因拆分：cancelled（主动停）→「已停止」；非合成 interrupted（协议前向兼容预留位，
  // 本仓 core TurnStopReason 暂无生产者）→ 中性「已停止」（语义待协议方生产后按归因细化）；
  // 其余终态走「已工作 {duration}」。
  else if (stopReason === 'cancelled') label = '已停止';
  else if (stopReason === 'interrupted') label = '已停止';
  else if (ticking) label = `工作中 ${formatWorkDuration(Math.max(0, now - startedAt!))}`;
  else if (durationMs !== undefined) label = `已工作 ${formatWorkDuration(durationMs)}`;
  else label = null;

  if (label === null) return null;
  return (
    <div
      // U2-C8/C3：running 态复用工具行扫光类（styles.css .tool-running-shimmer —— 同一
      // keyframes / 色带 / reduced-motion 降级；动画声明零复制。shell.css 仅做 specificity
      // 桥接：`.turn-work` 的常态语义色不得压过扫光的透明裁切）。
      className={`turn-work${ticking ? ' tool-running-shimmer' : ''}`}
      role="status"
      data-running={ticking ? 'true' : undefined}
    >
      {label}
    </div>
  );
});
