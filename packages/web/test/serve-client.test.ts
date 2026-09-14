// serve 客户端契约测试（真 HTTP + 真 WS 夹具）：
//   * HTTP：token 头、`/api/sessions`、`/api/sessions/:id/events`、`plan-state` 404 = 正常空态；
//   * WS：`/ws?protocolVersion=2`（+ token 查询参数）、op 形状与 serve `WsClientMessage` 同形；
//   * 帧 → 共享 store：流式增量 → turn 终态（含 partial 语义）。
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import { createServeClient, PROTOCOL_VERSION, type WebSocketLike } from '../src/serve-client.js';
import { event, startServeFixture, waitFor, type ServeFixture } from './serve-fixture.js';

const TOKEN = 'tok-web-123';
const fixtures: ServeFixture[] = [];
const clients: Array<ReturnType<typeof createServeClient>> = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const f of fixtures.splice(0)) await f.close();
});

async function start(options: Parameters<typeof startServeFixture>[0] = {}): Promise<ServeFixture> {
  const fixture = await startServeFixture(options);
  fixtures.push(fixture);
  return fixture;
}

function clientFor(fixture: ServeFixture, overrides: { origin?: string; token?: string } = {}) {
  const client = createServeClient({
    origin: overrides.origin ?? fixture.origin,
    token: overrides.token ?? TOKEN,
    socketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
    reconnectDelayMs: 20,
  });
  clients.push(client);
  return client;
}

/** 可手动驱动的假 WebSocket（重连状态机 / 畸形帧注入用；不碰真网络，确定性） */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  message(data: unknown): void {
    this.onmessage?.({ data });
  }
}

describe('HTTP 面：token 头与报文映射', () => {
  it('列会话带 x-harness2-token；返回值进 store（按 mtime 倒序）', async () => {
    const fixture = await start();
    const client = clientFor(fixture);
    const shell = createAppShell(client);
    await shell.controller.refreshSessions();
    expect(fixture.http.find((r) => r.path === '/api/sessions')).toMatchObject({
      method: 'GET',
      path: '/api/sessions',
      token: TOKEN,
    });
    expect(shell.store.getState().sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('重放走 GET /api/sessions/:id/events（切会话 = 全量重放）', async () => {
    const fixture = await start({ events: [event(1, 'user/message', { turnId: 't1', text: '你好' })] });
    const client = clientFor(fixture);
    const shell = createAppShell(client);
    await waitFor(() => client.status() === 'connected');
    await shell.controller.selectSession('s1');
    expect(fixture.http.some((r) => r.path === '/api/sessions/s1/events')).toBe(true);
    expect(shell.store.peekStream('s1')?.loaded).toBe(true);
    expect(shell.store.peekStream('s1')?.lastSeq).toBe(1);
  });

  it('plan-state 404 是「暂无计划数据」的正常空态（不当错误）', async () => {
    const fixture = await start();
    const client = clientFor(fixture);
    await expect(client.planState('s1')).resolves.toBeNull();
  });

  it('新建会话缺 cwd：如实拒绝（含可行动原因），不静默发空 cwd', async () => {
    const fixture = await start();
    const client = clientFor(fixture);
    await expect(client.createSession()).rejects.toThrow(/cwd/);
    // 列过一次会话后，客户端用「最近会话 cwd」兜底（本壳无目录选择通道）
    await client.listSessions();
    await expect(client.createSession()).resolves.toMatchObject({ id: 's-new' });
  });
});

describe('WS 面：握手与 op 形状（与 core WsClientMessage 同形）', () => {
  it('握手带 protocolVersion=2 与 token 查询参数（浏览器 WS 不支持自定义头）', async () => {
    const fixture = await start();
    clientFor(fixture); // 建连即触发升级请求（握手参数在 URL 上）
    await waitFor(() => fixture.connected());
    const upgrade = fixture.http.find((r) => r.method === 'UPGRADE');
    expect(upgrade?.path).toContain('/ws?');
    expect(upgrade?.path).toContain(`protocolVersion=${PROTOCOL_VERSION}`);
    expect(upgrade?.token).toBe(TOKEN);
  });

  it('交互 op 逐个同形：subscribe / submit / cancel / resume-subscription / approval-response / abort', async () => {
    const fixture = await start();
    const client = clientFor(fixture);
    await waitFor(() => client.status() === 'connected');

    await client.subscribe('s1');
    await client.submit({
      clientMessageId: 'cm-1',
      sessionId: 's1',
      rawText: 'hello',
      intent: 'queue',
      references: [{ id: 'f1', kind: 'file', path: 'src/a.ts' }],
    });
    await client.cancel({ requestId: 'req-1', target: { kind: 'turn', id: 't1' } });
    await client.resumeSubscription('s1', 12, 3);
    await client.respondApproval('apr-1', 'allow');
    await client.abort('s1');
    await waitFor(() => fixture.ops.length >= 6);

    expect(fixture.ops[0]).toEqual({ op: 'subscribe', sessionId: 's1' });
    expect(fixture.ops[1]).toEqual({
      op: 'submit',
      clientMessageId: 'cm-1',
      sessionId: 's1',
      rawText: 'hello',
      intent: 'queue',
      references: [{ id: 'f1', kind: 'file', path: 'src/a.ts' }],
    });
    expect(fixture.ops[2]).toEqual({ op: 'cancel', requestId: 'req-1', target: { kind: 'turn', id: 't1' } });
    expect(fixture.ops[3]).toEqual({ op: 'resume-subscription', sessionId: 's1', lastSeq: 12, epoch: 3 });
    expect(fixture.ops[4]).toEqual({ op: 'approval-response', requestId: 'apr-1', decision: 'allow' });
    expect(fixture.ops[5]).toEqual({ op: 'abort', sessionId: 's1' });
  });

  it('未连接时的 op 如实失败（不假装已送达）', async () => {
    const fixture = await start();
    const client = createServeClient({
      origin: fixture.origin,
      token: TOKEN,
      socketFactory: () => {
        throw new Error('WS 不可用');
      },
    });
    clients.push(client);
    await expect(client.subscribe('s1')).rejects.toThrow(/WS 未连接/);
    expect(client.status()).toBe('offline');
  });
});

describe('帧 → 共享 store', () => {
  it('带水位 text-delta 累积为在途文本；turn-end 落定终态', async () => {
    const fixture = await start();
    const client = clientFor(fixture);
    const shell = createAppShell(client);
    const stop = shell.controller.start();
    await waitFor(() => client.status() === 'connected');

    await shell.controller.submitMessage('s1', '你好');
    fixture.push({ type: 'submit-ack', clientMessageId: 'x', sessionId: 's1', state: 'accepted' });
    fixture.push({ type: 'text-delta', sessionId: 's1', turnId: 't1', attemptId: 'a1', chunkOffset: 0, text: '你' });
    fixture.push({ type: 'text-delta', sessionId: 's1', turnId: 't1', attemptId: 'a1', chunkOffset: 1, text: '好' });
    await waitFor(() => shell.store.peekStream('s1')?.live.text === '你好');
    expect(shell.store.peekStream('s1')?.running).toBe(true);

    fixture.push({ type: 'event', sessionId: 's1', event: event(1, 'user/message', { turnId: 't1', text: '你好' }) });
    fixture.push({
      type: 'turn-end',
      sessionId: 's1',
      stopReason: 'end_turn',
      textOutcome: 'final',
      finalText: '你好呀',
    });
    await waitFor(() => shell.store.peekStream('s1')?.running === false);
    expect(shell.store.peekStream('s1')?.turnEnds['t1']).toMatchObject({
      stopReason: 'end_turn',
      textOutcome: 'final',
    });
    stop();
  });

  it('畸形帧被丢弃（不把脏数据喂给状态层）', async () => {
    const fixture = await start();
    const client = clientFor(fixture);
    const seen: unknown[] = [];
    client.onEvent((frame) => seen.push(frame));
    await waitFor(() => client.status() === 'connected');
    fixture.push({ kind: 'not-a-frame' });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([]);
  });

  it('畸形帧多形态一律丢弃：非 JSON / 非法二进制 / 非对象 / 无 type；合法帧仍投递', async () => {
    const sockets: FakeSocket[] = [];
    const client = createServeClient({
      origin: 'http://127.0.0.1:9',
      token: TOKEN,
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    clients.push(client);
    const seen: Array<{ type?: unknown }> = [];
    client.onEvent((frame) => seen.push(frame as { type?: unknown }));
    const sock = sockets[0]!;
    sock.open();
    sock.message('这不是 JSON');
    sock.message(new Uint8Array([0xff, 0xfe, 0x00])); // 非法二进制 → 解码后仍非 JSON
    sock.message(42);
    sock.message(JSON.stringify({ noType: true }));
    sock.message(JSON.stringify([1, 2, 3]));
    sock.message('null');
    // 合法帧（有 string type）必须仍被投递 —— 证明丢弃只针对畸形，不是「一律丢」
    sock.message(JSON.stringify({ type: 'cron', op: 'finished', id: 'j1', ok: true }));
    await Promise.resolve();
    expect(seen.map((f) => f.type)).toEqual(['cron']);
  });

  it('turn-end 三态：textOutcome=empty 如实落定为 empty（不伪造 finalText/partialText）', async () => {
    const fixture = await start();
    const client = clientFor(fixture);
    const shell = createAppShell(client);
    const stop = shell.controller.start();
    await waitFor(() => client.status() === 'connected');
    fixture.push({ type: 'event', sessionId: 's1', event: event(1, 'user/message', { turnId: 't0', text: '空答' }) });
    fixture.push({ type: 'turn-end', sessionId: 's1', stopReason: 'end_turn', textOutcome: 'empty' });
    await waitFor(() => shell.store.peekStream('s1')?.turnEnds['t0'] !== undefined);
    expect(shell.store.peekStream('s1')?.turnEnds['t0']).toEqual({ stopReason: 'end_turn', textOutcome: 'empty' });
    expect(shell.store.peekStream('s1')?.running).toBe(false);
    stop();
  });

  it('cancel-ack 三态：unknown 如实记录（连接不明，不假报已取消）', async () => {
    const fixture = await start();
    const client = clientFor(fixture);
    const shell = createAppShell(client);
    const stop = shell.controller.start();
    await waitFor(() => client.status() === 'connected');
    fixture.push({ type: 'cancel-ack', requestId: 'req-x', state: 'unknown' });
    await waitFor(() => shell.store.getState().cancelAcks['req-x'] !== undefined);
    expect(shell.store.getState().cancelAcks['req-x']).toBe('unknown');
    stop();
  });
});

describe('连接生命周期：重连状态机与 v2 切换路径', () => {
  it('重连状态机 connecting → connected → reconnecting → offline（次数用尽如实告知，不永远重连中）', async () => {
    const sockets: FakeSocket[] = [];
    const client = createServeClient({
      origin: 'http://127.0.0.1:9',
      token: TOKEN,
      maxReconnectAttempts: 2,
      reconnectDelayMs: 5,
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    clients.push(client);
    const seen: string[] = [];
    const unsub = client.onConnectionStatus((status) => seen.push(status));
    expect(client.status()).toBe('connecting');
    sockets[0]!.open();
    expect(client.status()).toBe('connected');
    sockets[0]!.drop();
    expect(client.status()).toBe('reconnecting');
    await waitFor(() => sockets.length >= 2);
    sockets[1]!.drop();
    await waitFor(() => sockets.length >= 3);
    sockets[2]!.drop();
    await waitFor(() => client.status() === 'offline');
    expect((await client.getStatus()).detail?.attemptsLeft).toBe(0);
    // 状态只按 声明→连通→重连→放弃 单向推进，offline 是终态（不再回到 reconnecting）
    const firstSeen = seen.filter((s, i) => seen.indexOf(s) === i);
    expect(firstSeen).toEqual(['connecting', 'connected', 'reconnecting', 'offline']);
    expect(seen.indexOf('offline')).toBe(seen.length - 1);
    unsub();
  });

  it('protocolVersion=2 只在握手 URL 声明；真正切 v2 靠每会话的 resume-subscription op', async () => {
    const fixture = await start();
    const client = clientFor(fixture);
    const shell = createAppShell(client);
    const stop = shell.controller.start();
    await waitFor(() => client.status() === 'connected');
    await shell.controller.selectSession('s1');
    await waitFor(() => fixture.ops.some((op) => op['op'] === 'resume-subscription'));
    const resume = fixture.ops.find((op) => op['op'] === 'resume-subscription')!;
    expect(resume).toMatchObject({ op: 'resume-subscription', sessionId: 's1', epoch: 1 });
    expect(typeof resume['lastSeq']).toBe('number');
    // 握手声明同样存在（查询参数只是声明，不是已生效的开关）
    const upgrade = fixture.http.find((r) => r.method === 'UPGRADE');
    expect(upgrade?.path).toContain(`protocolVersion=${PROTOCOL_VERSION}`);
    stop();
  });
});
