// @vitest-environment jsdom
// P0-3a 自动化（cron）：
//   - automation-model 纯函数：调度回显（含坏数据原样不抛）、状态徽标四态（熔断/失败中/停用/启用）、
//     nextRun 相对时间（未来/过去/即将/坏串原样）。
//   - AutomationsPane：只读列表——**始终无启停/增删按钮**（红线⑩反向断言）；空态指向 CLI；
//     每条行有状态徽标 + 调度 + 下次时间。
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import {
  automationStatusOf,
  describeScheduleDisplay,
  nextRunDisplay,
  type CronJobShape,
} from '../src/renderer/side-pane/automation-model.js';
import { AutomationsPane } from '../src/renderer/side-pane/AutomationsPane.js';

afterEach(() => cleanup());

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0); // 2026-10-12T12:00:00Z

function job(over: Partial<CronJobShape> = {}): CronJobShape {
  return {
    id: 'j1',
    instruction: '每天汇总进度',
    schedule: 'daily 09:00',
    nextRun: new Date(NOW + 3_600_000).toISOString(),
    enabled: true,
    failCount: 0,
    createdAt: new Date(NOW - 86_400_000).toISOString(),
    ...over,
  };
}

describe('describeScheduleDisplay', () => {
  it('interval / daily / weekly 的人话回显', () => {
    expect(describeScheduleDisplay('5m')).toBe('每 5 分钟');
    expect(describeScheduleDisplay('2h')).toBe('每 2 小时');
    expect(describeScheduleDisplay('1d')).toBe('每 1 天');
    expect(describeScheduleDisplay('daily 09:00')).toBe('每天 09:00');
    expect(describeScheduleDisplay('weekly 1,2,3,4,5 09:00')).toBe('每周一、二、三、四、五 09:00');
  });

  it('坏数据 / 越界 / 未知格式：原样返回，绝不抛错（红线⑩不崩列）', () => {
    expect(describeScheduleDisplay('daily 99:99')).toBe('daily 99:99');
    expect(describeScheduleDisplay('not a schedule')).toBe('not a schedule');
    expect(describeScheduleDisplay('')).toBe('');
  });
});

describe('automationStatusOf', () => {
  it('四态：启用中 / 连续失败 / 已停用 / 已熔断', () => {
    expect(automationStatusOf(job()).label).toBe('启用中');
    expect(automationStatusOf(job({ failCount: 2 })).label).toBe('连续失败 2');
    expect(automationStatusOf(job({ enabled: false })).label).toBe('已停用');
    expect(automationStatusOf(job({ enabled: false, failCount: 3 })).label).toBe('已熔断');
  });
});

describe('nextRunDisplay', () => {
  it('未来（后）/ 过去（前）/ 即将 / 坏串原样', () => {
    expect(nextRunDisplay(new Date(NOW + 3_600_000).toISOString(), NOW)).toBe('1 小时后');
    expect(nextRunDisplay(new Date(NOW + 10800_000).toISOString(), NOW)).toBe('3 小时后');
    expect(nextRunDisplay(new Date(NOW - 2 * 3_600_000).toISOString(), NOW)).toBe('2 小时前');
    expect(nextRunDisplay(new Date(NOW + 30_000).toISOString(), NOW)).toBe('即将');
    expect(nextRunDisplay('garbage', NOW)).toBe('garbage');
  });
});

describe('AutomationsPane', () => {
  it('空态：指向 CLI，不含任何按钮', () => {
    const { container } = render(createElement(AutomationsPane, { jobs: [], nowMs: NOW }));
    expect(screen.getByTestId('automations-empty')).toBeTruthy();
    expect(container.querySelector('button')).toBeNull();
  });

  it('只读列表：行 + 状态徽标，且**绝无启停/增删按钮**（红线⑩反向钉）', () => {
    const { container } = render(
      createElement(AutomationsPane, {
        jobs: [job(), job({ id: 'j2', enabled: false, failCount: 3 })],
        nowMs: NOW,
      }),
    );
    const rows = screen.getAllByTestId('automation-row');
    expect(rows).toHaveLength(2);
    expect(screen.getAllByTestId('automation-status').map((el) => el.textContent)).toEqual(['启用中', '已熔断']);
    // 没有任何可操作按钮（列表是纯展示；改任务走 CLI）
    expect(container.querySelector('button')).toBeNull();
    expect(screen.getByTestId('automations-list')).toBeTruthy();
  });
});
