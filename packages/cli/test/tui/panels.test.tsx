// T4 panels 测试（queue + retry）：
// - queue-panel 渲染真实队列条目/下一条预览，Ctrl+X 取消队首回调；
// - retry-panel 由冻结 RetryBudgetState 渲染 used/remaining/stopReason，倒计时纯模型渲染，
//   Esc 停止映射到 onStop（shell → runtime.abortTurn）。
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'ink';
import { QueuePanel, cancelQueueItem, queuePreview, type QueuePanelItem } from '../../src/tui/panels/queue-panel.js';
import {
  RetryPanel,
  formatRetryBudget,
  retryBudgetHasActivity,
  retryPanelVisible,
  retryStopReasonLabel,
} from '../../src/tui/panels/retry-panel.js';
import type { RetryBudgetSnapshot } from '../../src/tui/panels/retry-panel.js';
import { mountTui } from './harness.js';

const QUEUE: QueuePanelItem[] = [
  { id: 'q1', text: '第一条：帮我读 a.ts 并解释' },
  { id: 'q2', text: '第二条：然后写测试' },
  { id: 'q3', text: '第三条\n带换行' },
];

const BUDGET: RetryBudgetSnapshot = {
  usedAttempts: 1,
  remainingAttempts: 5,
  waitMs: 2000,
  remainingWaitMs: 118000,
  maxExtraAttempts: 6,
  maxWaitMs: 120000,
  stopReason: 'none',
};

describe('queue-panel：渲染真实队列', () => {
  it('queuePreview：折成单行并截断（不改原文本）', () => {
    expect(queuePreview('a\nb   c')).toBe('a b c');
    expect(queuePreview('x'.repeat(60), 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('cancelQueueItem：无 id 取消队首；有 id 精确移除；不改原数组', () => {
    expect(cancelQueueItem(QUEUE).map((i) => i.id)).toEqual(['q2', 'q3']);
    expect(cancelQueueItem(QUEUE, 'q2').map((i) => i.id)).toEqual(['q1', 'q3']);
    expect(cancelQueueItem(QUEUE, 'missing').map((i) => i.id)).toEqual(['q1', 'q2', 'q3']);
    expect(QUEUE).toHaveLength(3);
    expect(cancelQueueItem([])).toEqual([]);
  });

  it('渲染排队条数、下一条预览与取消键提示', () => {
    const out = renderToString(<QueuePanel items={QUEUE} maxPreview={1} />);
    expect(out).toContain('队列 3 条');
    expect(out).toContain('第一条：帮我读 a.ts 并解释');
    expect(out).toContain('Ctrl+X 取消队首');
    expect(out).toContain('还有 1 条'); // 3 - 1 head - 1 preview = 1
  });

  it('空队列渲染 null（不占行）', () => {
    expect(renderToString(<QueuePanel items={[]} />)).toBe('');
  });

  it('虚拟 TTY：Ctrl+X 取消队首回调（真实队列 id）', async () => {
    const cancelled: string[] = [];
    const t = mountTui(<QueuePanel items={QUEUE} onCancel={(id) => cancelled.push(id)} />, {
      columns: 80,
      rows: 24,
    });
    try {
      await t.flush();
      t.write('\x18'); // Ctrl+X
      await t.flush();
      expect(cancelled).toEqual(['q1']);
    } finally {
      t.unmount();
    }
  });
});

describe('retry-panel：冻结 RetryBudgetState 渲染与停止', () => {
  it('stopReason 标签与整行文本引用冻结枚举', () => {
    expect(retryStopReasonLabel('budget-exhausted')).toBe('次数预算耗尽');
    expect(retryStopReasonLabel('retry-after')).toBe('Retry-After 超预算');
    const text = formatRetryBudget(BUDGET);
    expect(text).toContain('已用 1/6');
    expect(text).toContain('剩余 5 次');
    expect(text).toContain('等待 2s/120s');
    expect(text).toContain('停因 未停');
  });

  it('预算耗尽快照如实展示停因', () => {
    const out = renderToString(
      <RetryPanel budget={{ ...BUDGET, usedAttempts: 6, remainingAttempts: 0, stopReason: 'budget-exhausted' }} />,
    );
    expect(out).toContain('已用 6/6');
    expect(out).toContain('剩余 0 次');
    expect(out).toContain('次数预算耗尽');
  });

  it('纯倒计时模型：注入 {delayMs,startedAt,now} 渲染剩余秒数', () => {
    const out = renderToString(
      <RetryPanel budget={BUDGET} countdown={{ delayMs: 5000, startedAt: 1000 }} now={2500} />,
    );
    expect(out).toContain('重试等待倒计时: 4s'); // (1000+5000-2500)=3500ms → ceil 4
    expect(out).toContain('Esc 停止');
  });

  it('无预算且无倒计时：不可见（retryPanelVisible=false）', () => {
    expect(retryPanelVisible(undefined, undefined)).toBe(false);
    expect(renderToString(<RetryPanel budget={undefined} />)).toBe('');
  });

  it('retryBudgetHasActivity：仅发生重试或明确停因时占行', () => {
    expect(retryBudgetHasActivity({ ...BUDGET, usedAttempts: 0, stopReason: 'none' })).toBe(false);
    expect(retryBudgetHasActivity({ ...BUDGET, usedAttempts: 1 })).toBe(true);
    expect(retryBudgetHasActivity({ ...BUDGET, stopReason: 'timeout' })).toBe(true);
  });

  it('虚拟 TTY：Esc 触发停止（映射 runtime.abortTurn）', async () => {
    let stops = 0;
    const t = mountTui(<RetryPanel budget={BUDGET} onStop={() => (stops += 1)} />, { columns: 80, rows: 24 });
    try {
      await t.flush();
      t.write('\x1b'); // Esc
      await t.flush();
      expect(stops).toBe(1);
    } finally {
      t.unmount();
    }
  });
});
