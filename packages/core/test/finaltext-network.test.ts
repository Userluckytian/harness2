// P3-a / P3-b（跨端展示语义，冻结前定死）回归：
//   P3-a：network 错误收尾 finalText 为空时的展示语义——`turn-end.textOutcome`
//         区分 final / partial / empty；「无最终文本但有可行动结果」= empty 时必须带
//         stopReason + error（客户端据此渲染原因与已执行工具行，禁止空白气泡）。
//   P3-b：assistant / attempt 半截文本——`partialText` 只承载最后一条不完整 attempt，
//         绝不冒充 finalText；客户端须标注「未完成/已中断」。
// 契约落在 serve WS `turn-end` 帧（终端 / 桌面 / 网关共用同一处定义）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServe, MockProvider, type ServeHandle, type WsServerMessage } from '../src/index.js';
import type { ChatProvider, ChatRequest, StreamChunk, StreamOptions } from '../src/provider/types.js';

const handles: ServeHandle[] = [];
const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 可编程 provider：依次产出文本/抛错（抛错即终态，非重试码 → 不触发退避） */
class ScriptedProvider implements ChatProvider {
  readonly name = 'scripted';
  constructor(private readonly script: Array<{ text?: string; error?: Error }>) {}
  async *streamChat(_req: ChatRequest, _opts?: StreamOptions): AsyncGenerator<StreamChunk> {
    for (const step of this.script) {
      if (step.text !== undefined) yield { type: 'text-delta', text: step.text };
      if (step.error !== undefined) throw step.error;
    }
  }
}

async function start(provider: ChatProvider): Promise<ServeHandle> {
  const handle = await startServe({
    requireToken: false,
    port: 0,
    home: tmpDir('h2-finaltext-home-'),
    root: tmpDir('h2-finaltext-root-'),
    provider,
  });
  handles.push(handle);
  return handle;
}

/** 最小 WS 客户端（收集 turn-end 帧） */
class WsClient {
  readonly frames: WsServerMessage[] = [];
  readonly open: Promise<void>;
  private readonly ws: WebSocket;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.open = new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('ws 连接失败')));
    });
    this.ws.addEventListener('message', (ev) => this.frames.push(JSON.parse(String(ev.data)) as WsServerMessage));
  }
  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }
  close(): void {
    this.ws.close();
  }
  async waitFor(pred: (f: WsServerMessage) => boolean, label: string): Promise<WsServerMessage> {
    for (let i = 0; i < 500; i++) {
      const f = this.frames.find(pred);
      if (f !== undefined) return f;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`等待帧超时: ${label}`);
  }
}

async function createSession(handle: ServeHandle, root: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: root }),
  });
  return ((await res.json()) as { id: string }).id;
}

async function runTurn(
  handle: ServeHandle,
  text: string,
): Promise<{ end: WsServerMessage; client: WsClient; sessionId: string; root: string }> {
  const root = tmpDir('h2-finaltext-cwd-');
  const sessionId = await createSession(handle, root);
  const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
  await client.open;
  client.send({ op: 'subscribe', sessionId });
  client.send({ op: 'user-message', sessionId, text });
  const end = await client.waitFor((f) => f.type === 'turn-end' && f.sessionId === sessionId, 'turn-end');
  return { end, client, sessionId, root };
}

describe('P3-a/P3-b 跨端 turn 终态文本语义（turn-end 帧）', () => {
  it('P3-a network 错误、无任何文本 → textOutcome=empty，无 finalText/partialText，error 可读', async () => {
    const handle = await start(
      new ScriptedProvider([{ error: new Error('fetch failed: ECONNREFUSED 127.0.0.1:40080') }]),
    );
    const { end, client } = await runTurn(handle, '连不上模型');
    expect(end.type).toBe('turn-end');
    if (end.type !== 'turn-end') throw new Error('unreachable');
    expect(end.stopReason).toBe('error');
    expect(end.textOutcome).toBe('empty'); // 「无最终文本但有可行动结果」：靠 stopReason+error 表达
    expect(end.finalText).toBeUndefined();
    expect(end.partialText).toBeUndefined();
    expect(end.error).toContain('ECONNREFUSED');
    client.close();
  });

  it('P3-b 错误前已有半截文本 → textOutcome=partial，partialText=半截，finalText 缺席', async () => {
    const handle = await start(
      new ScriptedProvider([{ text: '半截正文' }, { error: new Error('fetch failed: ECONNREFUSED 127.0.0.1:40080') }]),
    );
    const { end, client, sessionId } = await runTurn(handle, '中途断网');
    if (end.type !== 'turn-end') throw new Error('unreachable');
    expect(end.stopReason).toBe('error');
    expect(end.textOutcome).toBe('partial');
    expect(end.partialText).toBe('半截正文'); // 半截文本不冒充完整正文
    expect(end.finalText).toBeUndefined();
    // 同源落盘：assistant/attempt（append-only，不冒充 assistant/message）
    const attempt = client.frames.find(
      (f) => f.type === 'event' && f.sessionId === sessionId && f.event.type === 'assistant/attempt',
    );
    const assistant = client.frames.find(
      (f) => f.type === 'event' && f.sessionId === sessionId && f.event.type === 'assistant/message',
    );
    expect(attempt).toBeTruthy();
    expect(assistant).toBeUndefined();
    client.close();
  });

  it('P3-a 正常收尾 → textOutcome=final + finalText（完整正文，不进 partialText）', async () => {
    const handle = await start(new ScriptedProvider([{ text: '完整回复' }]));
    const { end, client } = await runTurn(handle, '正常');
    if (end.type !== 'turn-end') throw new Error('unreachable');
    expect(end.stopReason).toBe('end_turn');
    expect(end.textOutcome).toBe('final');
    expect(end.finalText).toBe('完整回复');
    expect(end.partialText).toBeUndefined();
    client.close();
  });

  it('P3-b 取消（半截 attempt）→ textOutcome=partial，partialText 非空，stopReason=cancelled', async () => {
    const handle = await start(new MockProvider([{ textChunks: ['慢慢', '慢慢', '慢慢'], chunkDelayMs: 120 }]));
    const root = tmpDir('h2-finaltext-cwd-');
    const sessionId = await createSession(handle, root);
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.send({ op: 'subscribe', sessionId });
    client.send({ op: 'user-message', sessionId, text: '取消我' });
    // 等到至少一段流式文本后中途取消（否则半截文本为空，不是本用例要验证的路径）
    await client.waitFor((f) => f.type === 'delta' && f.kind === 'text', 'text delta');
    client.send({ op: 'abort', sessionId });
    const end = await client.waitFor((f) => f.type === 'turn-end' && f.sessionId === sessionId, 'turn-end');
    if (end.type !== 'turn-end') throw new Error('unreachable');
    expect(end.stopReason).toBe('cancelled');
    expect(end.textOutcome).toBe('partial');
    expect((end.partialText ?? '').length).toBeGreaterThan(0);
    expect(end.finalText).toBeUndefined();
    client.close();
  });
});
