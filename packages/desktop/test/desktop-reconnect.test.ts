// D0 重订阅 / ack 收敛测试：
//   - resume-snapshot 以服务端为权威补齐在途 attempt / 任务 / 待批 / 队列；旧 epoch 丢弃；
//   - submit-ack 三态收敛（unknown ≠ rejected）；ack 丢失 → 标 unknown 且**不自动重发**。
// 纯 store 单测：直接驱动 applyFrame / noteSubmit / expirePendingSubmits。
import { describe, expect, it, vi } from 'vitest';
import { AppStore } from '../src/renderer/store.js';
import type { ResumeSnapshotShape, SessionEventsPayloadShape } from '../src/shared/protocol.js';

const replayPayload = (id: string): SessionEventsPayloadShape => ({
  id,
  dir: 'd',
  header: { sessionId: id },
  events: [
    { v: 1, seq: 1, ts: '2026-09-11T00:00:00Z', type: 'session/header', payload: { sessionId: id }, active: true },
  ],
  warnings: [],
  lastSeq: 1,
});

function snapshot(over: Partial<ResumeSnapshotShape> = {}): ResumeSnapshotShape {
  return {
    epoch: 1,
    replay: { fromSeq: 1, toSeq: 10 },
    tasks: [],
    pendingApprovals: [],
    queue: [],
    ...over,
  };
}

describe('resume-snapshot（S3 重订阅）', () => {
  it('按服务端权威补齐在途 attempt / 任务 / 待批 / 队列；有在途 attempt 时不假报停止', () => {
    const store = new AppStore();
    store.applyReplay(replayPayload('s1'));
    store.applyFrame({
      type: 'resume-snapshot',
      sessionId: 's1',
      epoch: 4,
      snapshot: snapshot({
        epoch: 4,
        replay: { fromSeq: 7, toSeq: 42 },
        activeAttempt: {
          attemptId: 'a9',
          turnId: 't9',
          textChunkOffset: 12,
          reasoningChunkOffset: 0,
          status: 'running',
        },
        tasks: [{ taskId: 'task-1', background: true, state: 'running' }],
        pendingApprovals: [
          {
            requestId: 'r1',
            sessionId: 's1',
            taskId: 'task-1',
            tool: 'bash',
            args: { command: 'rm -rf x' },
            cwd: '/w',
            scope: { mode: 'once' },
            expiresAt: '2026-09-11T00:10:00Z',
          },
        ],
        queue: [{ id: 'cm-1', revision: 1, rawText: '排队中', intent: 'queue', state: 'queued' }],
      }),
    });

    const stream = store.peekStream('s1')!;
    expect(stream.epoch).toBe(4);
    expect(stream.resume).toMatchObject({ fromSeq: 7, toSeq: 42 });
    expect(stream.activeAttempt?.attemptId).toBe('a9');
    expect(stream.tasks.map((t) => t.taskId)).toEqual(['task-1']);
    expect(stream.queue.map((q) => q.id)).toEqual(['cm-1']);
    expect(stream.approvals).toHaveLength(1);
    expect(stream.approvals[0]).toMatchObject({ requestId: 'r1', tool: 'bash', scope: 'once', taskId: 'task-1' });
    expect(stream.running).toBe(true); // 在途 attempt → 仍在跑
  });

  it('旧 epoch 快照直接丢弃；新 epoch 覆盖', () => {
    const store = new AppStore();
    store.applyReplay(replayPayload('s1'));
    store.applyFrame({
      type: 'resume-snapshot',
      sessionId: 's1',
      epoch: 5,
      snapshot: snapshot({
        epoch: 5,
        activeAttempt: {
          attemptId: 'a5',
          turnId: 't5',
          textChunkOffset: 0,
          reasoningChunkOffset: 0,
          status: 'running',
        },
      }),
    });
    // 迟到的旧代次（epoch 3）不得回退状态
    store.applyFrame({
      type: 'resume-snapshot',
      sessionId: 's1',
      epoch: 3,
      snapshot: snapshot({ epoch: 3, tasks: [{ taskId: 'stale', background: false, state: 'running' }] }),
    });
    const stream = store.peekStream('s1')!;
    expect(stream.epoch).toBe(5);
    expect(stream.tasks).toEqual([]); // 旧快照被丢弃
    expect(stream.activeAttempt?.attemptId).toBe('a5');
  });
});

describe('submit-ack 三态收敛与 ack 丢失（F7）', () => {
  it('accepted：pending 清除、队列项保留并登记序号', () => {
    const store = new AppStore();
    store.applyReplay(replayPayload('s1'));
    store.noteSubmit('s1', { clientMessageId: 'cm-1', rawText: '你好', intent: 'queue' });
    expect(store.peekStream('s1')!.queue.map((q) => q.id)).toEqual(['cm-1']);

    store.applyFrame({ type: 'submit-ack', clientMessageId: 'cm-1', sessionId: 's1', state: 'accepted', queueSeq: 1 });
    const stream = store.peekStream('s1')!;
    expect(stream.pendingSubmits['cm-1']).toBeUndefined();
    expect(stream.submitAcks['cm-1']?.state).toBe('accepted');
    expect(stream.queue.map((q) => q.id)).toEqual(['cm-1']); // 仍在可见队列
  });

  it('rejected：从可见队列移除（不假装已排队）', () => {
    const store = new AppStore();
    store.applyReplay(replayPayload('s1'));
    store.noteSubmit('s1', { clientMessageId: 'cm-r', rawText: 'x', intent: 'queue' });
    store.applyFrame({
      type: 'submit-ack',
      clientMessageId: 'cm-r',
      sessionId: 's1',
      state: 'rejected',
      reason: '队列已满',
    });
    const stream = store.peekStream('s1')!;
    expect(stream.queue).toEqual([]);
    expect(stream.submitAcks['cm-r']).toMatchObject({ state: 'rejected', reason: '队列已满' });
  });

  it('unknown ≠ rejected：保留队列项并如实记录未确认（不自动重发）', () => {
    const store = new AppStore();
    store.applyReplay(replayPayload('s1'));
    store.noteSubmit('s1', { clientMessageId: 'cm-u', rawText: 'x', intent: 'queue' });
    store.applyFrame({
      type: 'submit-ack',
      clientMessageId: 'cm-u',
      sessionId: 's1',
      state: 'unknown',
      reason: '连接不明',
    });
    const stream = store.peekStream('s1')!;
    expect(stream.queue.map((q) => q.id)).toEqual(['cm-u']);
    expect(stream.submitAcks['cm-u']?.state).toBe('unknown');
  });

  it('ack 丢失：超时后标 unknown，pending 清空，队列保留，绝不重复提交', () => {
    const store = new AppStore();
    store.applyReplay(replayPayload('s1'));
    store.noteSubmit('s1', { clientMessageId: 'cm-lost', rawText: '丢 ack', intent: 'queue' });
    // 未超时：不判定
    expect(store.expirePendingSubmits(5000, Date.now())).toEqual([]);
    expect(store.peekStream('s1')!.pendingSubmits['cm-lost']).toBeDefined();

    // 超过 5s：标 unknown
    const expired = store.expirePendingSubmits(5000, Date.now() + 6000);
    expect(expired.map((p) => p.clientMessageId)).toEqual(['cm-lost']);
    const stream = store.peekStream('s1')!;
    expect(stream.pendingSubmits['cm-lost']).toBeUndefined();
    expect(stream.submitAcks['cm-lost']?.state).toBe('unknown');
    expect(stream.submitAcks['cm-lost']?.reason).toContain('勿重复提交');
    expect(stream.queue.map((q) => q.id)).toEqual(['cm-lost']); // 保留可见，交由服务端/用户决定
  });

  it('steer 提交不进可见 queue（控制输入，非排队正文）', () => {
    const store = new AppStore();
    store.applyReplay(replayPayload('s1'));
    store.noteSubmit('s1', { clientMessageId: 'cm-s', rawText: '换个方向', intent: 'steer' });
    const stream = store.peekStream('s1')!;
    expect(stream.queue).toEqual([]);
    expect(stream.pendingSubmits['cm-s']).toBeDefined();
  });
});

describe('cancel-ack 三态（全局表；不假报停止）', () => {
  it('stopping/cancelled/unknown 如实记录', () => {
    const store = new AppStore();
    store.applyFrame({ type: 'cancel-ack', requestId: 'cx-1', state: 'stopping' });
    store.applyFrame({ type: 'cancel-ack', requestId: 'cx-2', state: 'unknown' });
    expect(store.getState().cancelAcks).toEqual({ 'cx-1': 'stopping', 'cx-2': 'unknown' });
  });
});

// —— 审查 P2-2：resume 路径接线（重连自动恢复 + force 在途去重 + UI 真实调用点）——
import { createController } from '../src/renderer/app-controller.js';
import type { ConnectionStatus, Harness2Api, StatusDetail, WsFrame } from '../src/shared/protocol.js';

function reconnectApi(over: Partial<Harness2Api> = {}): {
  api: Harness2Api;
  subscribe: ReturnType<typeof vi.fn>;
  resumeSubscription: ReturnType<typeof vi.fn>;
  emitStatus: (status: ConnectionStatus, detail?: StatusDetail) => void;
  dispatch: (frame: WsFrame) => void;
} {
  let statusHandler: ((status: ConnectionStatus, detail?: StatusDetail) => void) | undefined;
  let frameHandler: ((frame: WsFrame) => void) | undefined;
  const subscribe = vi.fn(async () => undefined);
  const resumeSubscription = vi.fn(async () => undefined);
  const api = {
    listSessions: vi.fn(async () => [
      { id: 'A', dir: 'd', mtimeMs: 2, firstUserText: 'A', messageCount: 1, lastSeq: 1 },
    ]),
    events: vi.fn(async (id: string) => replayPayload(id)),
    subscribe,
    resumeSubscription,
    runConfig: vi.fn(async () => null),
    planState: vi.fn(async () => null),
    executionViews: vi.fn(async () => []),
    changeReview: vi.fn(async () => null),
    getStatus: vi.fn(async () => ({ status: 'connected' as const })),
    onConnectionStatus: vi.fn((h: (status: ConnectionStatus, detail?: StatusDetail) => void) => {
      statusHandler = h;
      return () => undefined;
    }),
    onEvent: vi.fn((h: (frame: WsFrame) => void) => {
      frameHandler = h;
      return () => undefined;
    }),
    setBusy: vi.fn(async () => undefined),
    ...over,
  } as unknown as Harness2Api;
  return {
    api,
    subscribe,
    resumeSubscription,
    emitStatus: (status, detail) => statusHandler?.(status, detail),
    dispatch: (frame) => frameHandler?.(frame),
  };
}

describe('P2-2 resume 路径接线', () => {
  it('重连（reconnecting→connected）后重发 subscribe 并强制 resume 拉权威快照', async () => {
    const store = new AppStore();
    const h = reconnectApi();
    const controller = createController(store, h.api);
    const stop = controller.start();
    store.applyStatus('connected');
    await controller.selectSession('A');

    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.resumeSubscription).toHaveBeenCalledTimes(1);

    // 模拟 serve 重启：断连（在途作废）→ 重连成功
    h.emitStatus('reconnecting', { error: 'serve 重启中' });
    h.emitStatus('connected');
    await new Promise((r) => setTimeout(r, 0)); // 放行 resync 内的 void 异步

    // 修复前：重连后无人重订阅/重拉，事件流与权威面板静默失效
    expect(h.subscribe.mock.calls.filter((c) => c[0] === 'A').length).toBe(2);
    expect(h.resumeSubscription.mock.calls.filter((c) => c[0] === 'A').length).toBe(2);
    stop();
  });

  it('force 连点在途去重：同会话在途期间只发一次；resume-snapshot 回来后解除', async () => {
    const store = new AppStore();
    const h = reconnectApi();
    const controller = createController(store, h.api);
    const stop = controller.start();
    store.applyStatus('connected');
    await controller.selectSession('A'); // 第 1 次（select 路径，在途未回）
    expect(h.resumeSubscription).toHaveBeenCalledTimes(1);

    // force 连点：select 的 resume 仍在途（快照未回）→ 不叠加，绝不多发
    await controller.resumeSession('A');
    await controller.resumeSession('A');
    expect(h.resumeSubscription).toHaveBeenCalledTimes(1);

    // 快照回来 → 解除在途，手动重拉立即生效
    h.dispatch({
      type: 'resume-snapshot',
      sessionId: 'A',
      epoch: 1,
      snapshot: snapshot({ epoch: 1 }),
    });
    await controller.resumeSession('A');
    expect(h.resumeSubscription).toHaveBeenCalledTimes(2);
    stop();
  });
});
