// D4 关窗口行为测试：关 UI ≠ 已停任务；有运行中工作必须显式选择。
import { describe, expect, it, vi } from 'vitest';
import { CLOSE_DIALOG_BUTTONS, closeDialogMessage, decideCloseAction } from '../src/shared/close-window.js';
import { AppStore } from '../src/renderer/store.js';
import { createController } from '../src/renderer/app-controller.js';
import type { Harness2Api, SessionEventsPayloadShape } from '../src/shared/protocol.js';

const replay = (id: string): SessionEventsPayloadShape => ({
  id,
  dir: 'd',
  header: { sessionId: id },
  events: [{ v: 1, seq: 1, ts: 't', type: 'user/message', payload: { text: 'hi', turnId: 't1' }, active: true }],
  warnings: [],
  lastSeq: 1,
});

describe('decideCloseAction', () => {
  it('无运行中工作 → 直接关闭（不打扰用户）', () => {
    expect(decideCloseAction(false)).toEqual({ action: 'close-window-keep-serving', note: '无运行中任务，直接关闭' });
    expect(decideCloseAction(false, 'cancel').action).toBe('close-window-keep-serving');
  });

  it('有工作 + 保持后台 → 关闭窗口但服务/任务继续（明确告知不等于停止）', () => {
    const d = decideCloseAction(true, 'keep-running');
    expect(d.action).toBe('close-window-keep-serving');
    expect(d.note).toContain('继续运行');
  });

  it('有工作 + 请求停止 → 先停后关，且不保证已停', () => {
    const d = decideCloseAction(true, 'request-stop');
    expect(d.action).toBe('stop-then-close');
    expect(d.note).toContain('未确认');
  });

  it('有工作 + 取消 / 未选择 → 保持打开（不静默丢弃）', () => {
    expect(decideCloseAction(true, 'cancel').action).toBe('stay-open');
    expect(decideCloseAction(true).action).toBe('stay-open');
  });

  it('按钮顺序与文案（保持后台在前，取消在最后、作为 cancelId）', () => {
    expect(CLOSE_DIALOG_BUTTONS.map((b) => b.choice)).toEqual(['keep-running', 'request-stop', 'cancel']);
    expect(closeDialogMessage(2, 1)).toContain('2 个运行中的 turn');
    expect(closeDialogMessage(2, 1)).toContain('1 个后台任务');
    expect(closeDialogMessage(1, 0)).not.toContain('后台任务');
  });
});

describe('controller.stopAll（请求停止全部，不假报已停）', () => {
  it('对每个运行中会话发 turn 取消、对每个未终态任务发 task 取消', async () => {
    const store = new AppStore();
    const cancel = vi.fn(async (_op: { target: { kind: string; id: string } }) => undefined);
    const api = { cancel, abort: vi.fn(async () => undefined) } as unknown as Harness2Api;
    const controller = createController(store, api);

    // s1 运行中（有 turnId）；s2 空闲
    store.applyReplay(replay('s1'));
    store.markSending('s1');
    store.applyReplay({ ...replay('s2'), events: [], lastSeq: 0 });

    // 一个运行中后台任务 + 一个已终态任务（后者不得被取消）
    store.applyFrame({
      type: 'resume-snapshot',
      sessionId: 's1',
      epoch: 1,
      snapshot: {
        epoch: 1,
        replay: { fromSeq: 0, toSeq: 1 },
        tasks: [
          { taskId: 'task-run', background: true, state: 'running' },
          { taskId: 'task-done', background: true, state: 'completed' },
        ],
        pendingApprovals: [],
        queue: [],
      },
    });

    await controller.stopAll();
    const kinds = cancel.mock.calls.map((c) => c[0].target);
    expect(kinds).toContainEqual({ kind: 'turn', id: 't1' });
    expect(kinds).toContainEqual({ kind: 'task', id: 'task-run' });
    expect(kinds).not.toContainEqual({ kind: 'task', id: 'task-done' }); // 终态不误伤
    expect(kinds.filter((k) => k.kind === 'turn')).toHaveLength(1); // 空闲会话不发取消
  });

  it('运行态汇总：anyRunning / runtimeCounts / anyPendingApprovals（关窗口提示依据）', () => {
    const store = new AppStore();
    store.applyReplay(replay('s1'));
    expect(store.anyRunning()).toBe(false);
    store.markSending('s1');
    expect(store.anyRunning()).toBe(true);
    store.applyFrame({
      type: 'resume-snapshot',
      sessionId: 's1',
      epoch: 1,
      snapshot: {
        epoch: 1,
        replay: { fromSeq: 0, toSeq: 1 },
        tasks: [{ taskId: 'bg1', background: true, state: 'running' }],
        pendingApprovals: [],
        queue: [],
      },
    });
    store.applyFrame({ type: 'approval-request', sessionId: 's1', tool: 'write', args: {}, requestId: 'r1' });
    expect(store.runtimeCounts()).toEqual({ runningTurns: 1, backgroundTasks: 1 });
    expect(store.anyPendingApprovals()).toBe(true);
  });
});
