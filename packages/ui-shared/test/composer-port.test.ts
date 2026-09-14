// 共享提交边界（`createConversationComposerPort`）：composer 到端口之间的**唯一**一段胶水。
// 覆盖 D-34（乐观提交/保序台账）、P0-1（只在提交边界 trim）、P1-2（rejected 上抛还原）、
// P1-3（只对真能送出去的附件产引用）与 stop（真实取消路径，不假报停止）。
import { describe, expect, it } from 'vitest';
import { createAppShell } from '../src/renderer/app-shell.js';
import { createConversationComposerPort } from '../src/renderer/conversation/seat.js';
import { commitDraft, createComposerState } from '../src/renderer/conversation/composer/composer-state.js';
import type { ComposerAttachment } from '../src/renderer/conversation/composer/attachments.js';
import { attachmentReference, IMAGE_TRANSPORT_MISSING } from '../src/renderer/conversation/composer/attachments.js';
import type { HarnessClient } from '../src/renderer/ports.js';
import type { SessionSummaryShape, WsFrame } from '../src/shared/protocol.js';

const readyFile = (id: string, token: string): ComposerAttachment => ({
  id,
  kind: 'file',
  name: `${id}.bin`,
  mimeType: 'application/octet-stream',
  bytes: 3,
  state: 'ready',
  token,
});

const failedImage = (id: string): ComposerAttachment => ({
  id,
  kind: 'image',
  name: `${id}.png`,
  mimeType: 'image/png',
  bytes: 9,
  state: 'failed',
  error: '图片通道未实现',
});

function harness(options: { reject?: boolean } = {}) {
  const submits: Array<Record<string, unknown>> = [];
  const cancels: Array<Record<string, unknown>> = [];
  const emitted: WsFrame[] = [];
  const listeners = new Set<(frame: WsFrame) => void>();
  const sessions: SessionSummaryShape[] = [
    { id: 's1', dir: '/tmp/s1', cwd: '/work', mtimeMs: 1, firstUserText: '', messageCount: 0, lastSeq: 0 },
  ];
  const client: HarnessClient = {
    listSessions: async () => sessions,
    createSession: async () => ({ id: 's1' }),
    events: async (id) => ({ id, dir: `/tmp/${id}`, header: null, events: [], warnings: [], lastSeq: 0 }),
    subscribe: async () => undefined,
    sendMessage: async () => undefined,
    abort: async () => undefined,
    respondApproval: async () => undefined,
    getStatus: async () => ({ status: 'connected' }),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onConnectionStatus: () => () => undefined,
    submit: async (op) => {
      submits.push(op as unknown as Record<string, unknown>);
      // 服务端立刻回 ack（rejected 供还原路径断言）
      const frame: WsFrame = {
        type: 'submit-ack',
        clientMessageId: op.clientMessageId,
        sessionId: op.sessionId,
        state: options.reject === true ? 'rejected' : 'accepted',
        ...(options.reject === true ? { reason: '队列已满' } : {}),
        ...(options.reject === true ? {} : { queueSeq: submits.length }),
      };
      emitted.push(frame);
      for (const listener of [...listeners]) listener(frame);
    },
    cancel: async (op) => {
      cancels.push(op as unknown as Record<string, unknown>);
      const frame: WsFrame = { type: 'cancel-ack', requestId: op.requestId, state: 'stopping' };
      emitted.push(frame);
      for (const listener of [...listeners]) listener(frame);
    },
    resumeSubscription: async () => undefined,
    fork: async () => undefined,
    undo: async () => ({ results: [] }),
    redo: async () => ({ results: [] }),
    runConfig: async () => {
      throw new Error('unavailable');
    },
    planState: async () => null,
    executionViews: async () => [],
    changeReview: async () => ({ sourceDir: '/work', files: [], changedFiles: 0, dirtyFiles: 0, readOnly: true }),
  };
  const shell = createAppShell(client);
  const stop = shell.controller.start();
  return { shell, submits, cancels, stop };
}

function submission(rawText: string, attachments: readonly ComposerAttachment[] = [], clientMessageId = 'cm-1') {
  const { submission: frozen } = commitDraft(createComposerState({ atoms: [{ kind: 'text', text: rawText }] }), {
    sessionId: 's1',
    intent: 'queue',
    placement: 'transcript',
    clientMessageId,
    attachments,
  });
  return frozen;
}

describe('提交边界（D-34 / P0-1 / P1-2 / P1-3）', () => {
  it('只在提交边界 trim 发出去的载荷（rawText 原文仍留在冻结载荷里）', async () => {
    const h = harness();
    const port = createConversationComposerPort({ store: h.shell.store, controller: h.shell.controller });
    const pending = submission('  你好  ');
    await port.io.submit(pending);
    expect(h.submits[0]?.['rawText']).toBe('你好');
    expect(pending.rawText).toBe('  你好  ');
    h.stop();
  });

  it('@path 引用解析：正文替换 + 结构化 file 引用上报（引用来源可见）', async () => {
    const h = harness();
    await h.shell.controller.refreshSessions(); // cwd 来自会话摘要（@path 解析需要它）
    const port = createConversationComposerPort({
      store: h.shell.store,
      controller: h.shell.controller,
      readRef: async () => ({ ok: true, content: 'FILE-BODY' }),
    });
    await port.io.submit(submission('看 @src/a.ts 这里'));
    const rawText = String(h.submits[0]?.['rawText']);
    expect(rawText).toContain('FILE-BODY');
    const references = h.submits[0]?.['references'] as Array<Record<string, unknown>>;
    expect(references.some((r) => r['kind'] === 'file' && r['path'] === 'src/a.ts')).toBe(true);
    const report = h.shell.store.peekRefReport('s1');
    expect(report?.sources.map((s) => s.token)).toEqual(['src/a.ts']);
    h.stop();
  });

  it('附件引用只取真能送出去的：ready 文件带 token 才产引用，图片/失败项不产', async () => {
    const h = harness();
    const port = createConversationComposerPort({ store: h.shell.store, controller: h.shell.controller });
    await port.io.submit(submission('带附件', [readyFile('f1', 'tok-1'), failedImage('i1')]));
    const references = h.submits[0]?.['references'] as Array<Record<string, unknown>>;
    expect(references).toEqual([{ id: 'f1', kind: 'file', path: 'tok-1' }]);
    h.stop();
  });

  it('@path 无读取通道（无 readRef 且无宿主桥）：token 原样保留 + 归因「读取通道不可用」（不是「未找到」）', async () => {
    delete (globalThis as { harness2?: unknown }).harness2;
    const h = harness();
    await h.shell.controller.refreshSessions(); // cwd 来自会话摘要（@path 解析需要它）
    const port = createConversationComposerPort({ store: h.shell.store, controller: h.shell.controller });
    await port.io.submit(submission('看 @src/a.ts 这里'));
    const rawText = String(h.submits[0]?.['rawText']);
    expect(rawText).toContain('@src/a.ts');
    // P2-3：本壳没有读取通道 ⇒ 不许说成「文件不存在」（用户据此去改路径 = 不可行动）
    expect(rawText).toContain('[src/a.ts 读取通道不可用，已忽略]');
    expect(rawText).not.toContain('未找到');
    expect(h.submits[0]?.['references']).toEqual([]); // 读取失败 → 不产 kind:'file' 引用
    const report = h.shell.store.peekRefReport('s1');
    expect(report?.unavailable).toEqual(['src/a.ts']);
    expect(report?.notFound).toEqual([]);
    expect(report?.sources).toEqual([]);
    h.stop();
  });

  it('@path 读取通道可用但文件不存在：归因「未找到」（与通道缺失分开）', async () => {
    const h = harness();
    await h.shell.controller.refreshSessions();
    const port = createConversationComposerPort({
      store: h.shell.store,
      controller: h.shell.controller,
      readRef: async () => ({ ok: false, reason: 'not-found', error: '未找到' }),
    });
    await port.io.submit(submission('看 @missing.ts 这里'));
    const rawText = String(h.submits[0]?.['rawText']);
    expect(rawText).toContain('[missing.ts 未找到，已忽略]');
    const report = h.shell.store.peekRefReport('s1');
    expect(report?.notFound).toEqual(['missing.ts']);
    expect(report?.unavailable).toEqual([]);
    h.stop();
  });

  it('图片附件：协议无图片字节通道 → 不产引用，文案如实标注未实现（不伪造 kind）', () => {
    expect(attachmentReference(failedImage('i1'))).toBeUndefined();
    expect(IMAGE_TRANSPORT_MISSING).toContain('图片通道未实现');
  });

  it('rejected 上抛（composer 据此还原草稿 + 附件并显示原因，不静默）', async () => {
    const h = harness({ reject: true });
    const port = createConversationComposerPort({ store: h.shell.store, controller: h.shell.controller });
    await expect(port.io.submit(submission('x', [], 'cm-rej'))).rejects.toThrow('队列已满');
    expect(h.shell.store.peekStream('s1')?.submitAcks['cm-rej']?.state).toBe('rejected');
    h.stop();
  });

  it('台账保序：pendingSubmissions = 提交顺序（FIFO）', async () => {
    const h = harness();
    const port = createConversationComposerPort({ store: h.shell.store, controller: h.shell.controller });
    await port.io.submit(submission('一', [], 'cm-1'));
    await port.io.submit(submission('二', [], 'cm-2'));
    expect(port.pendingSubmissions()).toEqual(['cm-1', 'cm-2']);
    h.stop();
  });

  it('stop：走真实取消路径（当前选中会话 → cancel 目标 turn），不谎报已停', async () => {
    const h = harness();
    const port = createConversationComposerPort({ store: h.shell.store, controller: h.shell.controller });
    h.shell.store.select('s1');
    h.shell.store.applyFrame({
      type: 'event',
      sessionId: 's1',
      event: { v: 1, seq: 1, ts: '2026-09-14T00:00:00.000Z', type: 'user/message', payload: { turnId: 't9' } },
    });
    const stopFn = port.io.stop;
    if (stopFn === undefined) throw new Error('共享 composer port 必须提供 stop（否则 UI 的停止按钮无落点）');
    stopFn();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.cancels[0]?.['target']).toEqual({ kind: 'turn', id: 't9' });
    // 只有 stopping ack（服务端确认前不宣称已取消）
    expect(h.shell.store.getState().cancelAcks).toMatchObject({ [String(h.cancels[0]?.['requestId'])]: 'stopping' });
    h.stop();
  });

  it('缺省 transport 如实失败（不伪造上传 token）', async () => {
    const h = harness();
    const port = createConversationComposerPort({ store: h.shell.store, controller: h.shell.controller });
    const transport = port.io.transport;
    if (transport === undefined) throw new Error('共享缺省 transport 必须存在（否则 composer 无法如实失败）');
    await expect(transport.upload({ id: 'x', name: 'x', mimeType: '', bytes: 0, file: null })).rejects.toThrow(
      '未配置文件上传通道',
    );
    expect(port.io.maxConcurrentFileUploads).toBe(2);
    h.stop();
  });
});
