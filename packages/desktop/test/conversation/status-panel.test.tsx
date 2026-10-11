// @vitest-environment jsdom
// Z3-03：桌面对话席位的**默认**状态面板装配验收（Z-17）。
// 装配语义：assembly.ConversationSeat 缺省注入 desktopStatusPanel（读桌面单例 store 的 S7 视图缓存
// 与会话流任务表）→ 共享 seat 的 statusPanel 槽。本测试只验装配与「有内容才渲染」边界：
// 面板本体/胶囊/兜底链的语义已由 ui-shared test/status-panel.test.tsx 钉住，不在此重复。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AppStore } from '@harness2/ui-shared/renderer/store.js';
import type { Controller } from '@harness2/ui-shared/renderer/app-controller.js';
import type { PlanStateShape } from '@harness2/ui-shared/shared/protocol.js';
import { ConversationSeat, conversationViewRegistry } from '../../src/renderer/conversation/assembly.js';
// 桌面单例 store：desktopStatusPanel 的数据源（装配缺省指向它，测试直接播种）
import { store as singletonStore } from '../../src/renderer/app-shared.js';
import type { Harness2Api } from '../../src/shared/protocol.js';

afterEach(cleanup);

const plan: PlanStateShape = {
  planId: 'p-sp',
  goal: '装配验收目标',
  steps: [
    { stepId: 'step-1', state: 'completed', evidence: { source: 'runtime-journal', taskId: 't1', journalSeqs: [1] } },
  ],
  readOnly: true,
  sourceDir: 'd',
};

function sessionSummary(id: string) {
  return { id, dir: 'd', cwd: 'D:/proj', mtimeMs: 1, firstUserText: 'x', messageCount: 1, lastSeq: 0 };
}

/** ConversationHeader 挂载即拉的 IPC 面（渲染端读 window.harness2）；其余不触即桩 */
function stubBridge(): void {
  (window as unknown as { harness2: Partial<Harness2Api> }).harness2 = {
    gitBranch: vi.fn(async () => null),
    settingsGetConfig: vi.fn(async () => {
      throw new Error('not needed');
    }),
    getContextUsage: vi.fn(async () => ({ usage: null, label: '—' })),
  };
}

function bootStore(id: string): AppStore {
  const testStore = new AppStore();
  testStore.setSessions([sessionSummary(id)]);
  testStore.select(id);
  return testStore;
}

describe('桌面会话席位的状态面板装配（Z3-03）', () => {
  it('有计划数据 → status-panel 槽渲染，面板内容来自单例 store 的视图缓存', () => {
    stubBridge();
    singletonStore.setPlanState('sp-1', plan);
    const { container } = render(
      <ConversationSeat store={bootStore('sp-1')} controller={{} as Controller} registry={conversationViewRegistry} />,
    );
    const slot = container.querySelector('[data-testid="status-panel-slot"]');
    expect(slot).not.toBeNull();
    // auto 模式双形态都在；面板与胶囊都拿得到 goal（兜底链第一位）
    expect(container.querySelectorAll('[title="装配验收目标"]').length).toBe(2);
  });

  it('无数据 → 槽不渲染（Z-17：空面板不留占位高度）', () => {
    stubBridge();
    const { container } = render(
      <ConversationSeat store={bootStore('sp-2')} controller={{} as Controller} registry={conversationViewRegistry} />,
    );
    expect(container.querySelector('[data-testid="status-panel-slot"]')).toBeNull();
  });

  it('statusPanel 可覆写（缝的注入面；桌面缺省只是其中一份实现）', () => {
    stubBridge();
    const { container } = render(
      <ConversationSeat
        store={bootStore('sp-3')}
        controller={{} as Controller}
        registry={conversationViewRegistry}
        statusPanel={() => <div data-testid="custom-status-panel" />}
      />,
    );
    expect(container.querySelector('[data-testid="custom-status-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="status-panel-slot"]')).not.toBeNull();
  });
});
