// @vitest-environment jsdom
// P0「自动化」主区视图（ZCode 实测面复刻）：
//   - 子 tab 自动化 | 工作流（role=tablist/tab）；工作流页无通道 → 如实空态（不摆假工作流列表）；
//   - 空态文案逐字；四张模板卡文案逐字（标题/描述/调度行）；
//   - 模板卡动作 = onCreateFromTemplate(模板)；有通道可点、无通道 disabled + data-placeholder（红线⑩）；
//   - 有任务 → 复用 AutomationRow（automation-row 测试 id）列表，不落空态。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AutomationsMainView, AUTOMATION_TEMPLATES } from '../src/renderer/automation/index.js';
import type { CronJobShape } from '../src/renderer/side-pane/automation-model.js';

afterEach(() => cleanup());

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

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

describe('AutomationsMainView 子 tab', () => {
  it('顶部两个子 tab（role=tablist/tab）；默认选中「自动化」', () => {
    render(<AutomationsMainView jobs={[]} nowMs={NOW} />);
    expect(screen.getByRole('tablist')).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['自动化', '工作流']);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('false');
  });

  it('「工作流」页无通道 → 如实空态（注明未接入数据源，不摆假工作流列表）', () => {
    render(<AutomationsMainView jobs={[]} nowMs={NOW} />);
    fireEvent.click(screen.getByTestId('automation-tab-workflows'));
    const empty = screen.getByTestId('automation-workflows-empty');
    expect(empty.textContent).toContain('工作流尚无可用通道');
    expect(empty.textContent).toContain('未接入工作流数据源');
  });
});

describe('AutomationsMainView 空态与提示行（逐字）', () => {
  it('无任务：空态文案 + 创建钮 + 唤醒提示行', () => {
    render(<AutomationsMainView jobs={[]} nowMs={NOW} />);
    const empty = screen.getByTestId('automation-empty');
    expect(empty.textContent).toContain('创建定时任务，或排队在闲时算力空闲时后台执行。');
    expect(empty.textContent).toContain('还没有定时任务');
    expect(screen.getByTestId('automation-create').textContent).toBe('创建定时任务');
    expect(screen.getByTestId('automation-wake-hint').textContent).toBe('harness2 运行会话时保持电脑唤醒。');
  });
});

describe('AutomationsMainView 定时任务模板（逐字）', () => {
  it('分区标题 + 四张卡片的标题/描述/调度行逐字', () => {
    render(<AutomationsMainView jobs={[]} nowMs={NOW} />);
    expect(screen.getByTestId('automation-templates').textContent).toContain('定时任务模板');
    expect(AUTOMATION_TEMPLATES).toHaveLength(4);
    const cases: Array<{ id: string; title: string; schedule: string; label: string; snippet: string }> = [
      {
        id: 'morning-digest',
        title: '晨会动态',
        schedule: 'weekly 1,2,3,4,5 09:00',
        label: '每工作日 09:00',
        snippet: '汇总上一个工作日以来的提交',
      },
      {
        id: 'risk-scan',
        title: '风险扫描',
        schedule: 'daily 10:00',
        label: '每天 10:00',
        snippet: '检查最近 24 小时的代码变更',
      },
      {
        id: 'release-brief',
        title: '发布简报',
        schedule: 'weekly 5 16:00',
        label: '每周五 16:00',
        snippet: '整理本周合并的 PR 和 commit',
      },
      {
        id: 'docs-sync',
        title: '文档同步检查',
        schedule: 'weekly 3 15:00',
        label: '每周三 15:00',
        snippet: '对照最近 7 天的代码、配置、接口与文档变更',
      },
    ];
    for (const c of cases) {
      const card = screen.getByTestId(`automation-template-${c.id}`);
      expect(card.textContent).toContain(c.title);
      expect(card.textContent).toContain(c.snippet);
      expect(card.textContent).toContain(c.label);
      expect(card.getAttribute('data-template-schedule')).toBe(c.schedule);
    }
  });
});

describe('AutomationsMainView 通道判定（红线⑩）', () => {
  it('有通道：模板卡可点并以整条模板回调 onCreateFromTemplate', () => {
    const onCreateFromTemplate = vi.fn();
    render(
      <AutomationsMainView jobs={[]} nowMs={NOW} onCreateFromTemplate={onCreateFromTemplate} onCreate={() => {}} />,
    );
    const card = screen.getByTestId('automation-template-risk-scan') as HTMLButtonElement;
    expect(card.disabled).toBe(false);
    fireEvent.click(card);
    expect(onCreateFromTemplate).toHaveBeenCalledTimes(1);
    const passed = onCreateFromTemplate.mock.calls[0]![0] as { id: string; schedule: string };
    expect(passed.id).toBe('risk-scan');
    expect(passed.schedule).toBe('daily 10:00');
  });

  it('无通道：模板卡与创建钮均 disabled + data-placeholder（不摆可点的假按钮）', () => {
    render(<AutomationsMainView jobs={[]} nowMs={NOW} />);
    const card = screen.getByTestId('automation-template-morning-digest') as HTMLButtonElement;
    expect(card.disabled).toBe(true);
    expect(card.getAttribute('data-placeholder')).toBe('true');
    const create = screen.getByTestId('automation-create') as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(create.getAttribute('data-placeholder')).toBe('true');
  });
});

describe('AutomationsMainView 任务列表', () => {
  it('有任务：渲染 AutomationRow 列表（复用既有行口径），不落空态', () => {
    render(<AutomationsMainView jobs={[job(), job({ id: 'j2', enabled: false, failCount: 3 })]} nowMs={NOW} />);
    expect(screen.queryByTestId('automation-empty')).toBeNull();
    expect(screen.getByTestId('automation-job-list')).toBeTruthy();
    expect(screen.getAllByTestId('automation-row')).toHaveLength(2);
    expect(screen.getAllByTestId('automation-status').map((el) => el.textContent)).toEqual(['启用中', '已熔断']);
  });
});
