// 端口契约测试：`HarnessClient` 是共享包与壳之间**唯一**的会话面缝。
// 这里用一个假壳（内存记录调用）验证「共享控制层只依赖端口」：
//   * 必需成员齐备时：列会话 / 提交（乐观登记）/ 取消 / 重放 全部按契约打到端口上；
//   * 可选成员缺失时（web 就是这种壳）：不抛错、不卡死，并且**如实降级**（不伪造成功）。
import { describe, expect, it } from 'vitest';
import { createAppShell } from '../src/renderer/app-shell.js';
import type { HarnessClient, HarnessClient as Client } from '../src/renderer/ports.js';
import type { ConnectionStatus, SessionSummaryShape, StatusDetail, WsFrame } from '../src/shared/protocol.js';

type Op = { kind: string } & Record<string, unknown>;

interface FakeClient {
  readonly client: Client;
  readonly ops: Op[];
  emit(frame: WsFrame): void;
  setStatus(status: ConnectionStatus, detail?: StatusDetail): void;
}

const summary = (id: string, mtimeMs: number, firstUserText = 'hi'): SessionSummaryShape => ({
  id,
  dir: `/tmp/${id}`,
  cwd: `/tmp/${id}`,
  mtimeMs,
  firstUserText,
  messageCount: 1,
  lastSeq: 3,
});

function fakeClient(overrides: Partial<Client> = {}): FakeClient {
  const ops: Op[] = [];
  const frameListeners = new Set<(frame: WsFrame) => void>();
  const statusListeners = new Set<(status: ConnectionStatus, detail?: StatusDetail) => void>();
  const base: Client = {
    listSessions: async () => [summary('a', 1), summary('b', 2)],
    createSession: async () => ({ id: 'new' }),
    events: async (id) => ({
      id,
      dir: `/tmp/${id}`,
      header: { sessionId: id, cwd: `/tmp/${id}` },
      events: [],
      warnings: [],
      lastSeq: 0,
    }),
    subscribe: async (id) => {
      ops.push({ kind: 'subscribe', id });
    },
    sendMessage: async (id, text) => {
      ops.push({ kind: 'sendMessage', id, text });
    },
    abort: async (id) => {
      ops.push({ kind: 'abort', id });
    },
    respondApproval: async (requestId, decision) => {
      ops.push({ kind: 'respondApproval', requestId, decision });
    },
    getStatus: async () => ({ status: 'connected' }),
    onEvent: (listener) => {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    onConnectionStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    submit: async (op) => {
      ops.push({ kind: 'submit', ...op });
    },
    cancel: async (op) => {
      ops.push({ kind: 'cancel', ...op });
    },
    resumeSubscription: async (sessionId, lastSeq, epoch) => {
      ops.push({ kind: 'resumeSubscription', sessionId, lastSeq, epoch });
    },
    fork: async (sessionId, atSeq) => {
      ops.push({ kind: 'fork', sessionId, atSeq });
    },
    undo: async (sessionId, opts) => {
      ops.push({ kind: 'undo', sessionId, opts });
      return { results: [] };
    },
    redo: async (sessionId) => {
      ops.push({ kind: 'redo', sessionId });
      return { results: [] };
    },
    runConfig: async () => {
      throw new Error('该壳未提供运行配置查询');
    },
    planState: async () => null,
    executionViews: async () => [],
    changeReview: async () => ({ sourceDir: '/tmp', files: [], changedFiles: 0, dirtyFiles: 0, readOnly: true }),
    ...overrides,
  };
  return {
    client: base,
    ops,
    emit: (frame) => {
      for (const listener of [...frameListeners]) listener(frame);
    },
    setStatus: (status, detail) => {
      for (const listener of [...statusListeners]) listener(status, detail);
    },
  };
}

describe('HarnessClient 端口：会话面', () => {
  it('refreshSessions 经端口取列表，store 按 mtime 倒序（壳只提供数据，排序口径在共享层）', async () => {
    const fake = fakeClient();
    const shell = createAppShell(fake.client);
    await shell.controller.refreshSessions();
    expect(shell.store.getState().sessions.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('selectSession：先 subscribe 再全量重放（切换 = 重放 + 增量去重）', async () => {
    const fake = fakeClient();
    const shell = createAppShell(fake.client);
    await shell.controller.selectSession('a');
    expect(fake.ops[0]).toEqual({ kind: 'subscribe', id: 'a' });
    expect(shell.store.getState().selectedId).toBe('a');
    expect(shell.store.peekStream('a')?.loaded).toBe(true);
  });

  it('submitMessage：本地乐观登记（可见队列）与端口调用**同一个 clientMessageId**', async () => {
    const fake = fakeClient();
    const shell = createAppShell(fake.client);
    const { clientMessageId } = await shell.controller.submitMessage('a', 'hello', { intent: 'queue' });
    expect(fake.ops).toContainEqual({
      kind: 'submit',
      clientMessageId,
      sessionId: 'a',
      rawText: 'hello',
      intent: 'queue',
    });
    const stream = shell.store.peekStream('a');
    expect(Object.keys(stream?.pendingSubmits ?? {})).toEqual([clientMessageId]);
    expect(stream?.queue.map((q) => q.id)).toEqual([clientMessageId]);
    expect(stream?.running).toBe(true);
  });

  it('submit-ack accepted 落定在途；rejected 从可见队列移除（不假装已排队）', async () => {
    const fake = fakeClient();
    const shell = createAppShell(fake.client);
    const stop = shell.controller.start(); // 帧分发经 start() 订阅的监听集合
    const { clientMessageId } = await shell.controller.submitMessage('a', 'x', { intent: 'queue' });
    fake.emit({ type: 'submit-ack', clientMessageId, sessionId: 'a', state: 'accepted', queueSeq: 1 });
    expect(shell.store.peekStream('a')?.pendingSubmits).toEqual({});

    const second = await shell.controller.submitMessage('a', 'y', { intent: 'queue' });
    fake.emit({
      type: 'submit-ack',
      clientMessageId: second.clientMessageId,
      sessionId: 'a',
      state: 'rejected',
      reason: '忙',
    });
    const stream = shell.store.peekStream('a');
    expect(stream?.queue.map((q) => q.id)).toEqual([clientMessageId]);
    expect(stream?.submitAcks[second.clientMessageId]).toEqual({ state: 'rejected', reason: '忙' });
    stop();
  });

  it('cancelTurn：目标 turnId 取事件流里最后一个 turnId（无 turnId 时退化为 abort 并如实记录）', async () => {
    const fake = fakeClient();
    const shell = createAppShell(fake.client);
    // 先落一条带 turnId 的事件，再取消
    shell.store.applyFrame({
      type: 'event',
      sessionId: 'a',
      event: { v: 1, seq: 1, ts: '2026-09-14T00:00:00.000Z', type: 'user/message', payload: { turnId: 'turn-7' } },
    });
    await shell.controller.cancelTurn('a');
    const cancel = fake.ops.find((o) => o.kind === 'cancel');
    expect(cancel?.target).toEqual({ kind: 'turn', id: 'turn-7' });

    // 无 turnId：走 abort 兜底（旧通道），不留「点了没反应」
    await shell.controller.cancelTurn('b');
    expect(fake.ops.some((o) => o.kind === 'abort' && o.id === 'b')).toBe(true);
  });

  it('start()：订阅连接状态与事件帧；connected 时自动拉会话列表', async () => {
    const fake = fakeClient();
    const shell = createAppShell(fake.client);
    const stop = shell.controller.start();
    fake.setStatus('connected');
    await Promise.resolve();
    await Promise.resolve();
    expect(shell.store.getState().status).toBe('connected');
    expect(shell.store.getState().sessions.length).toBe(2);
    stop();
  });
});

describe('HarnessClient 端口：可选能力缺失时如实降级', () => {
  it('缺 capabilities/setBusy/loadLayout/metadata*/drafts* 的壳仍可启动，且不抛错', async () => {
    const fake = fakeClient();
    const shell = createAppShell(fake.client);
    const stop = shell.controller.start();
    await expect(shell.controller.initLayout()).resolves.toBeUndefined();
    await expect(shell.controller.initMetadata()).resolves.toBeUndefined();
    await expect(shell.controller.initDrafts()).resolves.toBeUndefined();
    // 能力盘点缺失：不写 capabilities（不伪造「全部可用」）
    expect(shell.store.capabilities()).toBeUndefined();
    stop();
  });

  it('缺持久化通道的重命名：内存覆层生效 + 如实报「仅本次会话内生效」（不假装已保存）', async () => {
    const fake = fakeClient();
    const shell = createAppShell(fake.client);
    await shell.controller.renameSession('a', '新标题');
    expect(shell.store.displayTitleFor('a')).toBe('新标题');
    expect(shell.store.getState().statusDetail?.error).toContain('未提供会话展示态持久化通道');
  });

  it('缺持久化通道的归档：内存覆层生效 + 如实报「仅本次会话内生效」（不假装已保存）', async () => {
    const fake = fakeClient();
    const shell = createAppShell(fake.client);
    await shell.controller.archiveSession('a', true);
    expect(shell.store.isArchived('a')).toBe(true);
    expect(shell.store.getState().statusDetail?.error).toContain('未提供会话展示态持久化通道');
  });

  it('缺持久化通道的删除：覆层 deleted + 从视图移除，明确仅「从当前视图移除」（不伪造物理删除）', async () => {
    const fake = fakeClient();
    const shell = createAppShell(fake.client);
    await shell.controller.refreshSessions();
    await shell.controller.deleteSession('a');
    expect(shell.store.getState().sessions.map((s) => s.id)).not.toContain('a');
    expect(shell.store.getState().statusDetail?.error).toContain('仅从当前视图移除');
  });

  it('缺配置写入通道的审批模式切换：返回可行动原因，不静默失败', async () => {
    const fake = fakeClient();
    const shell = createAppShell(fake.client);
    const res = await shell.controller.setApprovalMode('a', 'plan');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('settingsUpdateConfig');
  });

  it('端口结构满足 HarnessClient（类型层面：桌面 Harness2Api 是它的超集）', () => {
    // 编译期断言：假壳赋值给 HarnessClient 即可（运行期只确认对象存在）
    const fake: HarnessClient = fakeClient().client;
    expect(typeof fake.submit).toBe('function');
  });
});
