// web 壳核心路径（退出闸门的自动化对应物）：**流式回复 → 终态 → 停止**。
//
// 全程走真 HTTP + 真 WS（夹具按 serve 契约应答），客户端 = web 壳的 `createServeClient`，
// 状态层 = 共享 `AppStore`/controller —— 与浏览器里跑的是同一条链路，只是没有 DOM。
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import { projectChatItems } from '@harness2/ui-shared/renderer/chat-model.js';
import { createServeClient, type WebSocketLike } from '../src/serve-client.js';
import { event, startServeFixture, waitFor, type ServeFixture } from './serve-fixture.js';

const TOKEN = 'tok-e2e';
const fixtures: ServeFixture[] = [];
const clients: Array<ReturnType<typeof createServeClient>> = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const f of fixtures.splice(0)) await f.close();
});

/** 夹具的服务端行为：submit → ack + 分块流式 + 终态；cancel → 三态 ack + 半截终态 */
async function streamingFixture(behavior: 'complete' | 'stop'): Promise<ServeFixture> {
  const fixture = await startServeFixture({
    events: [event(1, 'user/message', { turnId: 't1', text: '早前的问题' })],
    onSubmit: (ws, op) => {
      const clientMessageId = String(op['clientMessageId']);
      ws.send(JSON.stringify({ type: 'submit-ack', clientMessageId, sessionId: 's1', state: 'accepted', queueSeq: 1 }));
      const turnId = 't2';
      ws.send(
        JSON.stringify({ type: 'event', sessionId: 's1', event: event(2, 'user/message', { turnId, text: '你好' }) }),
      );
      const chunks = ['你', '好', '，', '世界'];
      chunks.forEach((text, i) => {
        ws.send(
          JSON.stringify({
            type: 'text-delta',
            sessionId: 's1',
            turnId,
            attemptId: 'at-1',
            chunkOffset: i,
            text,
          }),
        );
      });
      if (behavior === 'complete') {
        ws.send(
          JSON.stringify({
            type: 'event',
            sessionId: 's1',
            event: event(3, 'assistant/message', { turnId, text: '你好，世界' }),
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'turn-end',
            sessionId: 's1',
            stopReason: 'end_turn',
            textOutcome: 'final',
            finalText: '你好，世界',
          }),
        );
      }
      // behavior='stop'：服务端**不**主动收尾，等客户端发 cancel
    },
    onCancel: (ws, op) => {
      const requestId = String(op['requestId']);
      ws.send(JSON.stringify({ type: 'cancel-ack', requestId, state: 'stopping' }));
      // 半截终态：textOutcome='partial' + 停止原因（API-STABILITY 展示语义）
      ws.send(
        JSON.stringify({
          type: 'turn-end',
          sessionId: 's1',
          stopReason: 'cancelled',
          textOutcome: 'partial',
          partialText: '你好，',
        }),
      );
      ws.send(JSON.stringify({ type: 'cancel-ack', requestId, state: 'cancelled' }));
    },
  });
  fixtures.push(fixture);
  return fixture;
}

function harness(fixture: ServeFixture) {
  const client = createServeClient({
    origin: fixture.origin,
    token: TOKEN,
    socketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
    reconnectDelayMs: 10,
  });
  clients.push(client);
  const shell = createAppShell(client);
  const stop = shell.controller.start();
  return { client, shell, stop };
}

describe('web 壳：一轮真实对话（流式 → 终态）', () => {
  it('提交 → 乐观可见队列 → 分块流式 → 终态 final（转录里能看到完整正文）', async () => {
    const fixture = await streamingFixture('complete');
    const { shell, stop } = harness(fixture);
    await waitFor(() => shell.store.getState().status === 'connected');

    await shell.controller.selectSession('s1');
    const { clientMessageId } = await shell.controller.submitMessage('s1', '你好', { intent: 'queue' });
    // 乐观可见队列：ack 到达前就能看到自己这条
    expect(shell.store.peekStream('s1')?.queue.map((q) => q.id)).toContain(clientMessageId);

    await waitFor(() => shell.store.peekStream('s1')?.running === false);
    const stream = shell.store.peekStream('s1')!;
    expect(stream.submitAcks[clientMessageId]?.state).toBe('accepted');
    expect(stream.pendingSubmits[clientMessageId]).toBeUndefined();
    expect(stream.turnEnds['t2']).toMatchObject({ stopReason: 'end_turn', textOutcome: 'final' });

    const items = projectChatItems(stream.events, stream.live, stream.turnEnds);
    const text = JSON.stringify(items);
    expect(text).toContain('你好，世界');
    expect(text).toContain('final');
    stop();
  });

  it('流式过程中在途文本可见（不是等终态才一次性出现）', async () => {
    const fixture = await streamingFixture('stop');
    const { shell, stop } = harness(fixture);
    await waitFor(() => shell.store.getState().status === 'connected');
    await shell.controller.selectSession('s1');
    await shell.controller.submitMessage('s1', '你好', { intent: 'queue' });

    await waitFor(() => shell.store.peekStream('s1')?.live.text === '你好，世界');
    expect(shell.store.peekStream('s1')?.running).toBe(true);
    stop();
  });

  it('停止：发 cancel → 三态 ack（stopping → cancelled）+ 半截终态如实标注', async () => {
    const fixture = await streamingFixture('stop');
    const { shell, stop } = harness(fixture);
    await waitFor(() => shell.store.getState().status === 'connected');
    await shell.controller.selectSession('s1');
    await shell.controller.submitMessage('s1', '你好', { intent: 'queue' });
    await waitFor(() => (shell.store.peekStream('s1')?.live.text.length ?? 0) > 0);

    await shell.controller.cancelTurn('s1');
    await waitFor(() => fixture.ops.some((op) => op['op'] === 'cancel')); // WS 送达是异步的
    const cancelOp = fixture.ops.find((op) => op['op'] === 'cancel');
    expect(cancelOp?.['target']).toEqual({ kind: 'turn', id: 't2' });

    await waitFor(() => shell.store.getState().cancelAcks[String(cancelOp?.['requestId'])] === 'cancelled');
    await waitFor(() => shell.store.peekStream('s1')?.running === false);
    const end = shell.store.peekStream('s1')?.turnEnds['t2'];
    expect(end).toMatchObject({ stopReason: 'cancelled', textOutcome: 'partial', partialText: '你好，' });
    stop();
  });

  it('连接状态：先 connecting，握手完成后 connected（页面据此提示「正在连接 serve」）', async () => {
    const fixture = await streamingFixture('complete');
    const client = createServeClient({
      origin: fixture.origin,
      token: TOKEN,
      socketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
      reconnectDelayMs: 10,
    });
    clients.push(client);
    const seen: string[] = [];
    client.onConnectionStatus((status) => seen.push(status));
    await waitFor(() => client.status() === 'connected');
    expect(seen[0]).toBe('connecting'); // 订阅即补当前状态
    expect(seen).toContain('connected');
  });
});
