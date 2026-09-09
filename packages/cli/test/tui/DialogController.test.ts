// dialog controller（审批弹窗桥）：P0 审查修复防回归。
// ink 审批弹窗链路依赖「open/clear 触发 InkShell 重渲染同步」——此为订阅机制单测。
import { describe, expect, it } from 'vitest';
import { createDialogController, type DialogRequest } from '../../src/tui/runInkChat.js';

function makeReq(): DialogRequest {
  return {
    render: () => null,
    resolve: () => undefined,
  };
}

describe('createDialogController（审批弹窗桥订阅机制）', () => {
  it('open 设置挂起并通知订阅者；getPending 返回该请求', () => {
    const c = createDialogController();
    let notified = 0;
    const unsub = c.subscribe(() => {
      notified += 1;
    });
    expect(c.getPending()).toBeNull();

    const req = makeReq();
    c.open(req);
    expect(c.getPending()).toBe(req);
    expect(notified).toBe(1); // open 触发同步

    unsub();
    c.open(makeReq());
    expect(notified).toBe(1); // 取消订阅后不再通知
  });

  it('clear 清空挂起并通知订阅者', () => {
    const c = createDialogController();
    let notified = 0;
    c.subscribe(() => {
      notified += 1;
    });
    c.open(makeReq());
    const before = notified;
    c.clear();
    expect(c.getPending()).toBeNull();
    expect(notified).toBe(before + 1);
  });

  it('open 新请求前 resolve 旧挂起（同一时刻仅一个）', () => {
    const c = createDialogController();
    let firstResolved = 0;
    const first: DialogRequest = { render: () => null, resolve: () => (firstResolved += 1) };
    c.open(first);
    c.open(makeReq());
    expect(firstResolved).toBe(1); // 旧请求被 resolve
    expect(c.getPending()).not.toBe(first);
  });

  it('clear 后 open 可再次进入新请求（多轮审批复用）', () => {
    const c = createDialogController();
    let spawned = 0;
    c.subscribe(() => {
      spawned += 1;
    });
    c.open(makeReq());
    c.clear();
    c.open(makeReq());
    c.clear();
    expect(spawned).toBe(4); // open+clear ×2，每次各通知一次
    expect(c.getPending()).toBeNull();
  });
});
