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

/** 真终态中按「已停止」呈现的 stopReason（用户主动停 / 中断；其余终态走「已工作 {duration}」） */
const STOPPED_REASONS = new Set(['cancelled', 'interrupted']);

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
  else if (stopReason !== undefined && STOPPED_REASONS.has(stopReason)) label = '已停止';
  else if (ticking) label = `工作中 ${formatWorkDuration(Math.max(0, now - startedAt!))}`;
  else if (durationMs !== undefined) label = `已工作 ${formatWorkDuration(durationMs)}`;
  else label = null;

  if (label === null) return null;
  return (
    <div className="turn-work" role="status" data-running={ticking ? 'true' : undefined}>
      {label}
    </div>
  );
});
