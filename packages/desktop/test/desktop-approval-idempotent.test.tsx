// @vitest-environment jsdom
// PD4（D-P2）：F4 断线重复点击审批幂等 —— 在途去重（后端只收一次决定）+ 提交失败如实保留
// 审批（可重试，不假装已决定）+ UI 在途反馈（按钮禁用防连点）。
import { describe, expect, it, vi } from 'vitest';
import { AppStore } from '../src/renderer/store.js';
import { createController } from '../src/renderer/app-controller.js';
import type { Harness2Api, WsFrame } from '../src/shared/protocol.js';
function seedApproval(store: AppStore, requestId = 'r1'): void {
  store.applyFrame({ type: 'approval-request', sessionId: 's1', tool: 'write', args: {}, requestId } as WsFrame);
}

describe('respondApproval 幂等与断线语义（PD4）', () => {
  it('断线点击失败：审批保留在面板（可重试），错误如实上报（不假装已决定）', async () => {
    const store = new AppStore();
    seedApproval(store);
    const api = {
      respondApproval: vi.fn(async () => {
        throw new Error('与服务的事件通道未连接（等待 serve 就绪）');
      }),
    } as unknown as Harness2Api;
    const controller = createController(store, api);
    await controller.respondApproval('r1', 'allow');
    // 修复前：finally 里 removeApproval —— 决定未送达却把卡片撤掉（假反馈）
    expect(store.allApprovals().some((a) => a.requestId === 'r1')).toBe(true);
    expect(store.getState().statusDetail?.error).toContain('审批提交失败');
    expect(api.respondApproval).toHaveBeenCalledTimes(1);
  });

  it('连点去重：第一次在途期间再点，后端只收到一次决定', async () => {
    const store = new AppStore();
    seedApproval(store);
    let resolveFirst: (() => void) | undefined;
    const respond = vi.fn(
      (_requestId: string, _decision: 'allow' | 'deny') =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const api = { respondApproval: respond } as unknown as Harness2Api;
    const controller = createController(store, api);

    const first = controller.respondApproval('r1', 'allow');
    const second = controller.respondApproval('r1', 'allow'); // 连点：在途中重复点击
    await second;
    expect(respond).toHaveBeenCalledTimes(1); // 后端只收到一次
    resolveFirst!();
    await first;
    expect(store.allApprovals().some((a) => a.requestId === 'r1')).toBe(false); // 送达后才移除
  });

  it('提交中反馈：在途标志置位/清除（UI 据此禁用按钮）', async () => {
    const store = new AppStore();
    seedApproval(store);
    let resolveFirst: (() => void) | undefined;
    const api = {
      respondApproval: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      ),
    } as unknown as Harness2Api;
    const controller = createController(store, api);

    const pending = controller.respondApproval('r1', 'deny');
    expect(store.isApprovalResponding('r1')).toBe(true); // 在途：UI 禁用依据
    resolveFirst!();
    await pending;
    expect(store.isApprovalResponding('r1')).toBe(false); // 收敛：恢复可用
  });

  it('失败后可重试：第二次点击重新提交并成功', async () => {
    const store = new AppStore();
    seedApproval(store);
    const respond = vi
      .fn<(decision: 'allow' | 'deny') => Promise<void>>()
      .mockRejectedValueOnce(new Error('通道断开'))
      .mockResolvedValueOnce(undefined);
    const api = { respondApproval: respond } as unknown as Harness2Api;
    const controller = createController(store, api);
    await controller.respondApproval('r1', 'allow');
    expect(store.isApprovalResponding('r1')).toBe(false); // 失败也解除在途（可重试）
    await controller.respondApproval('r1', 'allow');
    expect(respond).toHaveBeenCalledTimes(2);
    expect(store.allApprovals().some((a) => a.requestId === 'r1')).toBe(false);
  });
});

// —— 组件级：审批中心在途反馈（jsdom 渲染真实 ApprovalCenter） ——
import type React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

describe('ApprovalCenter 在途反馈（PD4 组件级）', () => {
  it('提交中：按钮被「提交中…」反馈替换（连点无入口）；送达后卡片移除', async () => {
    let resolveFirst: (() => void) | undefined;
    const respond = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const api = { respondApproval: respond } as unknown as Harness2Api;
    vi.resetModules();
    (window as unknown as { harness2: Harness2Api }).harness2 = api;
    const { store } = (await import('../src/renderer/app-shared.js')) as typeof import('../src/renderer/app-shared.js');
    const { ApprovalCenter } = await import('../src/renderer/features/plan/ApprovalCenter.js');
    store.applyFrame({
      type: 'approval-request',
      sessionId: 's1',
      tool: 'write',
      args: {},
      requestId: 'r1',
    } as WsFrame);

    const { getByText, queryByText } = render(<ApprovalCenter />);
    fireEvent.click(getByText('允许'));
    await waitFor(() => expect(getByText('提交中…（防重复提交）')).toBeTruthy());
    expect(queryByText('允许')).toBeNull(); // 在途期间没有可重复点击的按钮
    resolveFirst!();
    await waitFor(() => expect(queryByText('提交中…（防重复提交）')).toBeNull());
    expect(respond).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
