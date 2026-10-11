// @vitest-environment jsdom
// Z7-a 下沉面板（ui-shared renderer/panels）的单测：**壳无关**——数据源经 props 注入
// `AppStore` / `Controller`，组件不读任何壳的全局对象。
//   计划：无账本如实空态 / 有账本渲染目标与步骤证据；
//   审批：无待批如实空态 / 有待批渲染可响应卡片；
//   配置：端口注入 store+controller 渲染有效配置；`getContextUsage` 可选（缺失 = 不显示占用注记，
//         不摆假数据 —— 红线⑩）；无效/缺失配置如实空态、不渲染半份配置。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AppStore } from '../src/renderer/store.js';
import type { Controller } from '../src/renderer/app-controller.js';
import type { EffectiveRunConfigShape, PlanStateShape, WsFrame } from '../src/shared/protocol.js';
import { PlanPanel } from '../src/renderer/panels/plan/PlanPanel.js';
import { ApprovalCenter } from '../src/renderer/panels/plan/ApprovalCenter.js';
import { EffectiveConfigPanel } from '../src/renderer/panels/config/EffectiveConfigPanel.js';

afterEach(cleanup);

/** 渲染期不会被调用的控制器桩（面板只在用户交互时用 controller） */
const controller = {} as unknown as Controller;

const PLAN: PlanStateShape = {
  planId: 'p1',
  goal: '做一个东西',
  steps: [{ stepId: 'st1', state: 'running', evidence: { source: 'runtime-journal', taskId: 't1', journalSeqs: [7] } }],
  readOnly: true,
  sourceDir: '/work/s1',
};

const RUN_CONFIG: EffectiveRunConfigShape = {
  session: { sessionId: 's1', root: '/work', cwd: '/work/s1', perSessionCwd: true },
  provider: { role: 'main', channel: 'openai', model: 'gpt-mock', protocol: 'openai', name: 'mock' },
  approval: { mode: 'default', tools: {} },
  modes: { memory: 'off' },
  tools: ['bash'],
  connection: { status: 'connected' as EffectiveRunConfigShape['connection']['status'] },
  instructions: { skills: [] },
  context: {
    contextWindow: 64_000,
    retry: { maxExtraAttempts: 0, backoffSeconds: [], maxExtraPerTurn: 0, maxTotalWaitSeconds: 0 },
  },
  snapshot: { revision: 3, capturedAt: '2026-10-11T00:00:00Z', effectiveAt: '2026-10-11T00:00:00Z' },
  redacted: true,
};

describe('Z7-a 共享面板：计划 / 审批', () => {
  it('计划面板：无账本 → 如实空态（不臆造计划）', () => {
    const store = new AppStore();
    render(<PlanPanel store={store} controller={controller} sessionId="s1" />);
    expect(screen.getByText('计划')).toBeTruthy();
    expect(screen.getByText(/该会话暂无计划账本/)).toBeTruthy();
    expect(screen.getByText(/审批模式：（未知）/)).toBeTruthy();
  });

  it('计划面板：有账本 → 渲染目标（含步骤证据来自真实 journal seq）', () => {
    const store = new AppStore();
    store.setPlanState('s1', PLAN);
    render(<PlanPanel store={store} controller={controller} sessionId="s1" />);
    expect(screen.getByText(/做一个东西/)).toBeTruthy();
    expect(screen.getByText(/证据 seq: 7/)).toBeTruthy();
  });

  it('审批中心：无待批 → 如实空态', () => {
    const store = new AppStore();
    render(<ApprovalCenter store={store} controller={controller} />);
    expect(screen.getByText(/无待批事项/)).toBeTruthy();
  });

  it('审批中心：有待批 → 渲染可响应卡片（数据来自 store 帧）', () => {
    const store = new AppStore();
    store.applyFrame({
      type: 'approval-request',
      sessionId: 's1',
      tool: 'bash',
      args: { cmd: 'ls' },
      requestId: 'r1',
    } as unknown as WsFrame);
    render(<ApprovalCenter store={store} controller={controller} />);
    expect(screen.getByText('允许')).toBeTruthy();
  });
});

describe('Z7-a 共享面板：有效配置（可选端口如实降级）', () => {
  it('无 run-config → 如实空态，不渲染半份配置', () => {
    const store = new AppStore();
    render(<EffectiveConfigPanel store={store} controller={controller} sessionId="s1" />);
    expect(document.querySelector('.config-panel')).not.toBeNull();
    expect(screen.getByText(/尚未载入有效配置/)).toBeTruthy();
  });

  it('有 run-config → 渲染配置；未注入 getContextUsage 则不显示「当前占用」', () => {
    const store = new AppStore();
    store.setRunConfig('s1', RUN_CONFIG);
    render(<EffectiveConfigPanel store={store} controller={controller} sessionId="s1" />);
    expect(screen.getByText(/openai/)).toBeTruthy();
    expect(screen.queryByText(/当前占用/)).toBeNull();
  });

  it('注入 getContextUsage → 显示占用注记（壳真提供该通道时）', async () => {
    const store = new AppStore();
    store.setRunConfig('s1', RUN_CONFIG);
    const getContextUsage = async (): Promise<{ usage: number | null; label: string }> => ({
      usage: 0.5,
      label: '50%',
    });
    render(
      <EffectiveConfigPanel store={store} controller={controller} sessionId="s1" getContextUsage={getContextUsage} />,
    );
    await waitFor(() => expect(screen.getByText(/当前占用 50%/)).toBeTruthy());
  });
});
