// WS 事件面测试（阶段 5 Task 2）：
//   订阅 / 退订 / 未知会话；mock 流式全链（delta text/reasoning/tool + event 镜像 + turn-end）；
//   delta 与落盘事件一致性断言（text 拼接 = assistant/message.text；reasoning 同理）；
//   双会话并行互不阻塞；abort 取消；审批 request/response 往返；坏帧 error。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startServe,
  MockProvider,
  type MockScript,
  type ServeHandle,
  type WsServerMessage,
} from '../src/index.js';

const dirs: string[] = [];
const handles: ServeHandle[] = [];
function tmpDir(prefix = 'h2-ws-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 收集 WS 帧的客户端（Node 22 全局 WebSocket） */
class WsClient {
  readonly frames: WsServerMessage[] = [];
  readonly ws: WebSocket;
  private readonly waiters: Array<() => void> = [];
  readonly open: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.open = new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('ws 连接失败')));
    });
    this.ws.addEventListener('message', (ev) => {
      this.frames.push(JSON.parse(String(ev.data)) as WsServerMessage);
      const waiters = this.waiters.splice(0);
      for (const w of waiters) w();
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }

  /** 等待谓词命中（轮询帧列表，最大 5s；pred 第二参数 = 帧下标，可要求"新于某帧"） */
  async waitFor(
    pred: (f: WsServerMessage, index: number) => boolean,
    description: string,
    fromIndex = 0,
  ): Promise<WsServerMessage> {
    for (let i = 0; i < 500; i++) {
      const idx = this.frames.findIndex((f, at) => at >= fromIndex && pred(f, at));
      if (idx >= fromIndex) return this.frames[idx]!;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 10);
      });
    }
    throw new Error(`等待帧超时: ${description}（已收到 ${this.frames.length} 帧）`);
  }

  ofSession(sessionId: string): WsServerMessage[] {
    return this.frames.filter((f) => 'sessionId' in f && f.sessionId === sessionId);
  }
}

async function start(opts: { script?: MockScript; approvalTimeoutMs?: number } = {}): Promise<ServeHandle> {
  const handle = await startServe({
    port: 0,
    home: tmpDir('h2-ws-home-'),
    root: tmpDir('h2-ws-root-'),
    provider: new MockProvider(opts.script ?? [{ textChunks: ['回复。'] }]),
    ...(opts.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}),
  });
  handles.push(handle);
  return handle;
}

async function createSession(handle: ServeHandle, cwd?: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: cwd ?? tmpDir('h2-ws-cwd-') }),
  });
  return ((await res.json()) as { id: string }).id;
}

describe('WS 订阅与流式全链', () => {
  it('订阅 → user-message → delta(text/reasoning) + event 镜像 + turn-end；delta 与落盘事件一致', async () => {
    const handle = await start({
      script: [
        { reasoningChunks: ['思考 A', '思考 B'], textChunks: ['你', '好'] },
      ],
    });
    const id = await createSession(handle);
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.send({ op: 'subscribe', sessionId: id });
    client.send({ op: 'user-message', sessionId: id, text: '打个招呼' });

    await client.waitFor((f) => f.type === 'turn-end', 'turn-end');
    const frames = client.ofSession(id);
    const deltas = frames.filter((f) => f.type === 'delta');
    const events = frames.filter((f) => f.type === 'event');

    // delta 序列：reasoning×2 → text×2
    expect(deltas.map((d) => (d.kind === 'reasoning' || d.kind === 'text' ? d.text : ''))).toEqual([
      '思考 A',
      '思考 B',
      '你',
      '好',
    ]);

    // 一致性断言：delta 拼接 === 落盘 assistant/message 事件内容
    const assistant = events.find((f) => f.type === 'event' && f.event.type === 'assistant/message');
    expect(assistant && assistant.type === 'event' && assistant.event.type === 'assistant/message').toBe(true);
    if (assistant?.type === 'event' && assistant.event.type === 'assistant/message') {
      const textDeltas = deltas.filter((d) => d.kind === 'text').map((d) => (d.kind === 'text' ? d.text : ''));
      expect(textDeltas.join('')).toBe(assistant.event.payload.text);
      const reasoningDeltas = deltas
        .filter((d) => d.kind === 'reasoning')
        .map((d) => (d.kind === 'reasoning' ? d.text : ''));
      expect(reasoningDeltas.join('')).toBe(assistant.event.payload.reasoning);
    }

    // 事件镜像完整（header 在订阅前已落盘，镜像只含订阅之后的落盘事件）：
    // user/message → step/start → assistant/message → step/end
    const types = events.map((f) => (f.type === 'event' ? f.event.type : ''));
    expect(types).toEqual(['user/message', 'step/start', 'assistant/message', 'step/end']);

    const turnEnd = frames.find((f) => f.type === 'turn-end');
    expect(turnEnd && turnEnd.type === 'turn-end' && turnEnd.stopReason).toBe('end_turn');
    client.close();
  });

  it('tool delta（kind=tool）与其后落盘 tool/call 事件一致；tool-result 只走事件镜像', async () => {
    const handle = await start({
      script: [
        { toolCalls: [{ id: 'call-1', name: 'glob', arguments: JSON.stringify({ pattern: '*' }) }] },
        { textChunks: ['完成'] },
      ],
    });
    const id = await createSession(handle);
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.send({ op: 'subscribe', sessionId: id });
    client.send({ op: 'user-message', sessionId: id, text: '列目录' });
    await client.waitFor((f) => f.type === 'turn-end', 'turn-end');

    const frames = client.ofSession(id);
    const toolDelta = frames.find((f) => f.type === 'delta' && f.kind === 'tool');
    expect(toolDelta && toolDelta.type === 'delta' && toolDelta.kind === 'tool').toBe(true);
    if (toolDelta?.type === 'delta' && toolDelta.kind === 'tool') {
      expect(toolDelta.call).toEqual({ id: 'call-1', name: 'glob', arguments: '{"pattern":"*"}' });
      const callEvent = frames.find((f) => f.type === 'event' && f.event.type === 'tool/call');
      expect(callEvent?.type === 'event' && callEvent.event.type === 'tool/call').toBe(true);
      if (callEvent?.type === 'event' && callEvent.event.type === 'tool/call') {
        expect(callEvent.event.payload.callId).toBe('call-1');
      }
    }
    // delta 仅三类：本 turn = 1 个 tool delta + 1 个 text delta；tool-result 不发增量（以事件镜像送达）
    expect(frames.filter((f) => f.type === 'delta' && f.kind === 'tool')).toHaveLength(1);
    expect(frames.filter((f) => f.type === 'delta' && f.kind === 'text')).toHaveLength(1);
    const resultEvent = frames.find((f) => f.type === 'event' && f.event.type === 'tool/result');
    expect(resultEvent?.type === 'event' && resultEvent.event.type === 'tool/result').toBe(true);
    if (resultEvent?.type === 'event' && resultEvent.event.type === 'tool/result') {
      expect(resultEvent.event.payload.ok).toBe(true);
    }
    client.close();
  });

  it('双会话并行互不阻塞：慢会话未结束时快会话已 turn-end', async () => {
    const script: MockScript = [{ textChunks: ['慢', '速'], chunkDelayMs: 120 }];
    const handle = await start({ script });
    const slow = await createSession(handle);
    const fast = await createSession(handle);
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.send({ op: 'subscribe', sessionId: slow });
    client.send({ op: 'subscribe', sessionId: fast });
    client.send({ op: 'user-message', sessionId: slow, text: '慢任务' });
    client.send({ op: 'user-message', sessionId: fast, text: '快任务' });

    await client.waitFor((f) => f.type === 'turn-end' && f.sessionId === fast, 'fast turn-end');
    expect(client.ofSession(slow).filter((f) => f.type === 'turn-end')).toHaveLength(0); // 慢会话未结束

    await client.waitFor((f) => f.type === 'turn-end' && f.sessionId === slow, 'slow turn-end');
    // fast 的全部帧（含 turn-end）都在 slow 的 turn-end 之前到达
    const slowEndIdx = client.frames.findIndex((f) => f.type === 'turn-end' && f.sessionId === slow);
    const fastEndIdx = client.frames.findIndex((f) => f.type === 'turn-end' && f.sessionId === fast);
    expect(fastEndIdx).toBeLessThan(slowEndIdx);
    client.close();
  });

  it('同会话 user-message 串行排队（第二条在第一条 turn 结束后才执行）', async () => {
    const handle = await start({ script: [{ textChunks: ['一'] }, { textChunks: ['二'] }] });
    const id = await createSession(handle);
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.send({ op: 'subscribe', sessionId: id });
    client.send({ op: 'user-message', sessionId: id, text: '第一条' });
    client.send({ op: 'user-message', sessionId: id, text: '第二条' });
    await client.waitFor((f) => f.type === 'turn-end', 'turn-end #1');
    const end1Idx = client.frames.findIndex((f) => f.type === 'turn-end');
    await client.waitFor((f) => f.type === 'turn-end' && client.frames.indexOf(f) !== end1Idx, 'turn-end #2');

    const userMsgs = client
      .ofSession(id)
      .filter((f) => f.type === 'event' && f.event.type === 'user/message')
      .map((f) => (f.type === 'event' && f.event.type === 'user/message' ? f.event.payload.text : ''));
    expect(userMsgs).toEqual(['第一条', '第二条']);
    expect(client.ofSession(id).filter((f) => f.type === 'turn-end')).toHaveLength(2);
    client.close();
  });
});

describe('WS abort 与审批往返', () => {
  it('abort → turn-end cancelled + assistant/attempt 落盘镜像', async () => {
    const handle = await start({ script: [{ textChunks: ['慢', '慢', '慢'], chunkDelayMs: 100 }] });
    const id = await createSession(handle);
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.send({ op: 'subscribe', sessionId: id });
    client.send({ op: 'user-message', sessionId: id, text: '取消我' });
    await client.waitFor((f) => f.type === 'event' && f.event.type === 'user/message', 'user message 落盘');
    client.send({ op: 'abort', sessionId: id });

    const end = await client.waitFor((f) => f.type === 'turn-end', 'turn-end');
    expect(end.type === 'turn-end' && end.stopReason).toBe('cancelled');
    const attempt = client
      .ofSession(id)
      .find((f) => f.type === 'event' && f.event.type === 'assistant/attempt');
    expect(attempt).toBeTruthy(); // append-only：取消以 attempt 记录
    client.close();
  });

  it('approval-request → approval-response(allow) 往返：工具真实执行', async () => {
    const askHandle = await startServe({
      port: 0,
      home: tmpDir('h2-ws-home-'),
      root: tmpDir('h2-ws-root-'),
      provider: new MockProvider([
        { toolCalls: [{ id: 'call-ok', name: 'glob', arguments: JSON.stringify({ pattern: '*' }) }] },
        { textChunks: ['执行完'] },
      ]),
      decide: () => 'ask',
    });
    handles.push(askHandle);

    const id = await createSession(askHandle);
    const client = new WsClient(`ws://127.0.0.1:${askHandle.port}/ws`);
    await client.open;
    client.send({ op: 'subscribe', sessionId: id });
    client.send({ op: 'user-message', sessionId: id, text: '触发审批' });

    const req = await client.waitFor((f) => f.type === 'approval-request', 'approval-request');
    expect(req.type === 'approval-request' && req.tool).toBe('glob');
    client.send({ op: 'approval-response', requestId: req.type === 'approval-request' ? req.requestId : '', decision: 'allow' });

    const result = await client.waitFor(
      (f) => f.type === 'event' && f.event.type === 'tool/result',
      'tool/result 镜像',
    );
    expect(result.type === 'event' && result.event.type === 'tool/result' && result.event.payload.ok).toBe(true);
    await client.waitFor((f) => f.type === 'turn-end', 'turn-end');
    client.close();
  });

  it('approval-response(deny) → tool/result ok:false（denied by approval policy）', async () => {
    const askHandle = await startServe({
      port: 0,
      home: tmpDir('h2-ws-home-'),
      root: tmpDir('h2-ws-root-'),
      provider: new MockProvider([
        { toolCalls: [{ id: 'call-deny', name: 'glob', arguments: JSON.stringify({ pattern: '*' }) }] },
        { textChunks: ['拒绝后收尾'] },
      ]),
      decide: () => 'ask',
    });
    handles.push(askHandle);
    const id = await createSession(askHandle);
    const client = new WsClient(`ws://127.0.0.1:${askHandle.port}/ws`);
    await client.open;
    client.send({ op: 'subscribe', sessionId: id });
    client.send({ op: 'user-message', sessionId: id, text: '触发审批' });

    const req = await client.waitFor((f) => f.type === 'approval-request', 'approval-request');
    client.send({
      op: 'approval-response',
      requestId: req.type === 'approval-request' ? req.requestId : '',
      decision: 'deny',
    });
    const result = await client.waitFor((f) => f.type === 'event' && f.event.type === 'tool/result', 'tool/result');
    if (result.type !== 'event' || result.event.type !== 'tool/result') throw new Error('unreachable');
    expect(result.event.payload.ok).toBe(false);
    expect(result.event.payload.error ?? '').toContain('denied by approval policy');
    client.close();
  });
});

describe('WS 协议边界', () => {
  it('unsubscribe 后不再收到该会话帧；其他会话帧不受影响', async () => {
    const handle = await start({ script: [{ textChunks: ['回复'] }] });
    const a = await createSession(handle);
    const b = await createSession(handle);
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.send({ op: 'subscribe', sessionId: a });
    client.send({ op: 'subscribe', sessionId: b });
    client.send({ op: 'unsubscribe', sessionId: a });
    client.send({ op: 'user-message', sessionId: a, text: 'A 会话' });
    client.send({ op: 'user-message', sessionId: b, text: 'B 会话' });

    await client.waitFor((f) => f.type === 'turn-end' && f.sessionId === b, 'b turn-end');
    await sleep(50); // a 的帧若泄漏，此刻应已到达
    expect(client.ofSession(a)).toHaveLength(0);
    expect(client.ofSession(b).length).toBeGreaterThan(0);
    client.close();
  });

  it('坏帧 / 未知会话 → error 帧；审批 requestId 未知静默忽略', async () => {
    const handle = await start();
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.ws.send('not-json');
    const err1 = await client.waitFor((f) => f.type === 'error', 'error 帧');
    expect(err1.type === 'error' && err1.error).toContain('JSON');

    client.send({ op: 'user-message', sessionId: 'no-such-session', text: 'hi' });
    const err2 = await client.waitFor((f) => f.type === 'error' && f.error.includes('session not found'), 'error 帧 2', 1);
    expect(err2.type === 'error' && err2.error).toContain('session not found');

    client.send({ op: 'approval-response', requestId: 'gone', decision: 'allow' });
    client.send({ op: 'subscribe', sessionId: 'no-such-session' });
    const err3 = await client.waitFor(
      (f) => f.type === 'error' && f.error.includes('session not found'),
      '订阅未知会话 error',
      client.frames.indexOf(err2) + 1,
    );
    expect(err3.type === 'error').toBe(true);
    client.close();
  });
});
