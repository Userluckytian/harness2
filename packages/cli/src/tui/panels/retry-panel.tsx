// T4 retry-panel：渲染冻结的 RetryBudgetState（TurnResult.retryBudget：used/remaining/stopReason）
// 与纯倒计时模型（scheduler.ts 的 retryCountdown*）。
// - 预算快照在 turn 结束时才由 TurnResult 提供（core 的 onStream 无 live attempt 事件——见 T4 报告的
//   已登记缺口），故倒计时数据只接受注入（真机若接入 live 通道即可直接填）。
// - 「停止」动作走 onStop（shell 映射到 runtime.abortTurn()；core 的 waitWithAbort 监听同一 AbortSignal）。
import React, { type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TurnResult } from '@harness2/core';
import { retryCountdownActive, retryCountdownSeconds, type RetryCountdownModel } from '../scheduler.js';

/** 冻结契约类型（从 TurnResult 派生，禁止复制 core 定义） */
export type RetryBudgetSnapshot = NonNullable<TurnResult['retryBudget']>;

export const RETRY_STOP_KEY = 'Esc';

const STOP_REASON_LABEL: Record<RetryBudgetSnapshot['stopReason'], string> = {
  none: '未停',
  'budget-exhausted': '次数预算耗尽',
  timeout: '等待预算耗尽',
  'retry-after': 'Retry-After 超预算',
};

/** stopReason 可读标签（引用冻结枚举，不新增取值） */
export function retryStopReasonLabel(reason: RetryBudgetSnapshot['stopReason']): string {
  return STOP_REASON_LABEL[reason];
}

/** 预算快照 → 单行可读文本（纯函数） */
export function formatRetryBudget(budget: RetryBudgetSnapshot): string {
  const waitSec = Math.round(budget.waitMs / 1000);
  const maxSec = Math.round(budget.maxWaitMs / 1000);
  return `重试 已用 ${budget.usedAttempts}/${budget.maxExtraAttempts} · 剩余 ${budget.remainingAttempts} 次 · 等待 ${waitSec}s/${maxSec}s · 停因 ${retryStopReasonLabel(budget.stopReason)}`;
}

/** 面板是否可见：有预算或无 live 倒计时均不显示（避免噪声） */
export function retryPanelVisible(
  budget: RetryBudgetSnapshot | undefined,
  countdown: RetryCountdownModel | undefined,
): boolean {
  return budget !== undefined || countdown !== undefined;
}

/** 预算是否有值得展示的活动：发生过重试或明确停因（turn 正常无重试时不占行） */
export function retryBudgetHasActivity(budget: RetryBudgetSnapshot): boolean {
  return budget.usedAttempts > 0 || budget.stopReason !== 'none';
}

export interface RetryPanelProps {
  budget: RetryBudgetSnapshot | undefined;
  /** live 倒计时（当前 core onStream 不提供；保留注入缝） */
  countdown?: RetryCountdownModel;
  /** 可注入时钟（测试用） */
  now?: number;
  active?: boolean;
  /** 停止重试/取消当前 turn（shell → runtime.abortTurn） */
  onStop?: () => void;
}

export function RetryPanel({
  budget,
  countdown,
  now = Date.now(),
  active = true,
  onStop,
}: RetryPanelProps): ReactElement | null {
  const counting = countdown !== undefined && retryCountdownActive(countdown, now);
  useInput(
    (_input, key) => {
      if (key.escape) onStop?.();
    },
    { isActive: active && retryPanelVisible(budget, countdown) },
  );

  if (!retryPanelVisible(budget, countdown)) return null;
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      {budget !== undefined && <Text color="yellow">{formatRetryBudget(budget)}</Text>}
      {counting && countdown !== undefined && (
        <Text color="yellow">
          重试等待倒计时: {retryCountdownSeconds(countdown, now)}s · {RETRY_STOP_KEY} 停止
        </Text>
      )}
    </Box>
  );
}
