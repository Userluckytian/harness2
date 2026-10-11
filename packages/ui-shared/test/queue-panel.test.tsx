// @vitest-environment jsdom
// 队列面板（Z2-09b / Z-17「QueuePanel：有队列时，底部 dock」）：
// 按需出现、位次 + 状态 + 摘要 + 说明；**只读**（协议无撤回 op——不摆假按钮，缺口登记）。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ComposerQueueItem } from '../src/renderer/features/composer/composer-model.js';
import { QueuePanel } from '../src/renderer/conversation/QueuePanel.js';

afterEach(cleanup);

const entry = (id: string, kind: ComposerQueueItem['kind'], text: string, note?: string): ComposerQueueItem => ({
  id,
  kind,
  text,
  ...(note !== undefined ? { note } : {}),
});

describe('QueuePanel：按需出现（Z-17「有队列时」）', () => {
  it('空队列 → 不渲染（不留占位高度）', () => {
    const { container } = render(<QueuePanel entries={[]} />);
    expect(container.querySelector('[data-testid="queue-dock"]')).toBeNull();
    expect(container.childElementCount).toBe(0);
  });

  it('有队列 → dock 渲染：位次从 1 起、状态标签、摘要与说明齐备', () => {
    render(
      <QueuePanel
        entries={[
          entry('cm-1', 'queued', '第一句'),
          entry('cm-2', 'paused', '重启前排队', '服务重启后暂停，需显式放行'),
          entry('cm-3', 'pending', '等 ack 的提交', '等待服务端确认…'),
          entry('cm-4', 'unconfirmed', '可能已送达', '未收到服务端确认（连接中断），请勿重复提交'),
        ]}
      />,
    );
    const dock = screen.getByTestId('queue-dock');
    expect(dock.getAttribute('data-queue-count')).toBe('4');
    // 条目 = 位次 + 队列消息摘要 + 状态
    const rows = dock.querySelectorAll('[data-queue-entry-id]');
    expect([...rows].map((r) => r.getAttribute('data-queue-entry-id'))).toEqual(['cm-1', 'cm-2', 'cm-3', 'cm-4']);
    expect(dock.textContent).toContain('第一句');
    expect(dock.textContent).toContain('重启前排队');
    // 状态标签四态齐备（与既有可见队列同一套词）
    for (const label of ['排队', '暂停', '待确认', '未确认']) {
      expect(dock.textContent).toContain(label);
    }
    // 说明行如实展示（pending/paused/unconfirmed 必带）
    expect(dock.textContent).toContain('服务重启后暂停，需显式放行');
    expect(dock.textContent).toContain('请勿重复提交');
  });

  it('只读展示：面板内没有任何动作按钮（协议无撤回 op，不摆假撤回入口——登记项）', () => {
    render(<QueuePanel entries={[entry('cm-1', 'queued', '第一句'), entry('cm-2', 'queued', '第二句')]} />);
    const dock = screen.getByTestId('queue-dock');
    expect(dock.querySelectorAll('button')).toHaveLength(0);
  });
});
