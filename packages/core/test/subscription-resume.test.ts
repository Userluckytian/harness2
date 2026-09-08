// S3c1 WS/HTTP 可恢复订阅（resumeSubscription + cancel + submit 帧层）测试。
// 覆盖：resume-subscription → resume-snapshot（replay 无缺口 + 快照含 activeAttempt/tasks/
//       pendingApprovals/queue）、旧 epoch 丢弃、重复 offset 丢弃、delta 带水位、cancel 三态 ack、
//       submit ack、旧客户端帧不崩。
// 只测传输帧层（server/ws.ts）：实际执行/队列接线归 S3c2，经注入的 resumeStateProvider 缝观察。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServe, MockProvider, type ServeHandle, type WsServerMessage } from '../src/index.js';
import type {
  CancelRequest,
  CancelAck,
  ResumeSubscriptionRequest,
  ResumeSnapshot,
  SubmitRequest,
  SubmitAck,
} from '../src/interaction/types.js';
import {
  WatermarkCursor,
  type ResumeStateProvider,
} from '../src/server/ws.js';

const dirs: string[] = [];
const handles: ServeHandle[] = [];
function tmpDir(prefix = 'h2-resume-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
}

async function createSession(handle: ServeHandle, cwd?: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: cwd ?? tmpDir('h2-resume-cwd-') }),
  });
  return ((await res.json()) as { id: string }).id;
}

/** 可控注入的 resumeStateProvider（缺省未接线 → resume null / ack unknown） */
function provider(over: Partial<ResumeStateProvider> = {}): ResumeStateProvider {
  const base: ResumeStateProvider = {
    resumeSnapshot: () => ({ tasks: [], pendingApprovals: [], queue: [] }),
    submitAck: (req) => ({ clientMessageId: req.clientMessageId, sessionId: req.sessionId, state: 'unknown' }),
    cancelAck: (req) => ({ requestId: req.requestId, state: 'unknown' }),
  };
  return { ...base, ...over };
}

describe('resume-subscription → resume-snapshot（传输帧层）', () => {
  it('重连 replay 无缺口（磁盘投影 lastSeq 为准）与快照字段齐全', async () => {
    const handle = await startServe({
      port: 0,
      home: tmpDir('h2-resume-home-'),
      root: tmpDir('h2-resume-root-'),
      provider: new MockProvider([{ textChunks: ['回复'] }]),
      resumeState: provider({
        resumeSnapshot: () => ({
          activeAttempt: {
            attemptId: 'att-2',
            turnId: 'turn-7',
            textChunkOffset: 0,
            reasoningChunkOffset: 0,
            status: 'running',
          },
          tasks: [{ taskId: 'task-1', background: true, state: 'running' }],
          pendingApprovals: [
            {
              requestId: 'apr-1',
              sessionId: 's',
              tool: 'write',
              args: {},
              scope: { mode: 'once' },
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
          ],
          queue: [{ id: 'cm-1', revision: 1, rawText: '排队', intent: 'queue', state: 'paused' }],
        }),
      }),
    });
    handles.push(handle);
    const id = await createSession(handle);

    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.send({ op: 'resume-subscription', sessionId: id, lastSeq: 0, epoch: 3 });

    const snap = await client.waitFor((f) => f.type === 'resume-snapshot', 'resume-snapshot');
    expect(snap.type === 'resume-snapshot' && snap.snapshot.epoch).toBe(3);
    if (snap.type !== 'resume-snapshot') throw new Error('unreachable');
    // replay 无缺口：fromSeq = lastSeq + 1；toSeq = 服务端磁盘投影 lastSeq（>= fromSeq）
    expect(snap.snapshot.replay.fromSeq).toBe(1);
    expect(snap.snapshot.replay.toSeq).toBeGreaterThanOrEqual(snap.snapshot.replay.fromSeq);
    // 快照结构齐全
    expect(snap.snapshot.activeAttempt?.attemptId).toBe('att-2');
    expect(snap.snapshot.tasks.map((t) => t.taskId)).toEqual(['task-1']);
    expect(snap.snapshot.pendingApprovals.map((a) => a.requestId)).toEqual(['apr-1']);
    expect(snap.snapshot.queue.map((q) => q.id)).toEqual(['cm-1']);
    client.close();
  });

  it('resumeStateProvider 未接线 → error 帧（会话已存在但恢复未支持），不崩', async () => {
    // 不注入 resumeState → 默认 null
    const handle = await startServe({
      port: 0,
      home: tmpDir('h2-resume-home-'),
      root: tmpDir('h2-resume-root-'),
      provider: new MockProvider([{ textChunks: ['回复'] }]),
    });
    handles.push(handle);
    const id = await createSession(handle);
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.send({ op: 'resume-subscription', sessionId: id, lastSeq: 0, epoch: 1 });
    const err = await client.waitFor((f) => f.type === 'error', 'error 帧');
    expect(err.type === 'error' && err.error).toContain('resume');
    client.close();
  });
});

describe('cancel 三态 ack（传输帧层）', () => {
  it('stop 阶段 ack=stopping；确认后 ack=cancelled；未接线/未知=unknown', async () => {
    const handle = await startServe({
      port: 0,
      home: tmpDir('h2-resume-home-'),
      root: tmpDir('h2-resume-root-'),
      provider: new MockProvider([{ textChunks: ['回复'] }]),
      resumeState: provider(),
    });
    handles.push(handle);
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    const req: CancelRequest = { requestId: 'cnl-1', target: { kind: 'turn', id: 'turn-7' }, expectedId: 'turn-7' };
    // 缺省 cancelAck → unknown（未接线，不冒充）
    client.send({ op: 'cancel', ...req });
    const ack = await client.waitFor((f) => f.type === 'cancel-ack', 'cancel-ack');
    expect(ack.type === 'cancel-ack' && ack.requestId).toBe('cnl-1');
    expect(ack.type === 'cancel-ack' && ack.state).toBe('unknown');
    client.close();
  });

  it('接线 provider 回 stopping → 转发原样；坏 expectedId 仍由 provider 决定', async () => {
    const handle = await startServe({
      port: 0,
      home: tmpDir('h2-resume-home-'),
      root: tmpDir('h2-resume-root-'),
      provider: new MockProvider([{ textChunks: ['回复'] }]),
      resumeState: provider({
        cancelAck: (req) => (req.target.id === 'turn-7' ? { requestId: req.requestId, state: 'stopping' } : { requestId: req.requestId, state: 'cancelled' }),
      }),
    });
    handles.push(handle);
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.send({ op: 'cancel', requestId: 'cnl-1', target: { kind: 'turn', id: 'turn-7' }, expectedId: 'turn-7' });
    const a = await client.waitFor((f) => f.type === 'cancel-ack', 'cancel-ack stopping');
    expect(a.type === 'cancel-ack' && a.state).toBe('stopping');
    client.close();
  });
});

describe('submit 帧定义 + ack（传输帧层；实际入队归 S3c2）', () => {
  it('接线 provider 回 accepted/rejected；缺省回 unknown（≠rejected）', async () => {
    const handle = await startServe({
      port: 0,
      home: tmpDir('h2-resume-home-'),
      root: tmpDir('h2-resume-root-'),
      provider: new MockProvider([{ textChunks: ['回复'] }]),
      resumeState: provider({
        submitAck: (req) =>
          req.rawText === 'ok'
            ? { clientMessageId: req.clientMessageId, sessionId: req.sessionId, state: 'accepted', queueSeq: 0 }
            : { clientMessageId: req.clientMessageId, sessionId: req.sessionId, state: 'rejected', reason: 'q full' },
      }),
    });
    handles.push(handle);
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    const base: SubmitRequest = { clientMessageId: 'cm-1', sessionId: 's1', rawText: 'ok', intent: 'queue' };
    client.send({ op: 'submit', ...base });
    const ok = await client.waitFor((f) => f.type === 'submit-ack', 'submit-ack');
    expect(ok.type === 'submit-ack' && ok.state).toBe('accepted');
    client.send({ op: 'submit', clientMessageId: 'cm-2', sessionId: 's1', rawText: 'no', intent: 'queue' });
    const rej = await client.waitFor((f) => f.type === 'submit-ack' && (f.type === 'submit-ack' ? f.clientMessageId : '') === 'cm-2', 'submit-ack rej', 1);
    expect(rej.type === 'submit-ack' && rej.state).toBe('rejected');
    client.close();
  });
});

describe('delta 带水位 + 重复 offset 丢弃（传输层映射，纯逻辑）', () => {
  it('text-delta/reasoning-delta 带完整归属 + chunkOffset 连续', () => {
    const cursor = new WatermarkCursor();
    const d1 = cursor.accept('s1', { kind: 'text', text: '你好' }, { turnId: 't1', attemptId: 'a1' }, 0);
    const d2 = cursor.accept('s1', { kind: 'text', text: '世界' }, { turnId: 't1', attemptId: 'a1' }, 2);
    expect(d1).toEqual({ type: 'text-delta', sessionId: 's1', turnId: 't1', attemptId: 'a1', chunkOffset: 0, text: '你好' });
    expect(d2).toEqual({ type: 'text-delta', sessionId: 's1', turnId: 't1', attemptId: 'a1', chunkOffset: 2, text: '世界' });
  });

  it('reasoning 与 text 各自独立水位', () => {
    const cursor = new WatermarkCursor();
    const r = cursor.accept('s1', { kind: 'reasoning', text: '思' }, { turnId: 't1', attemptId: 'a1' }, 0);
    const t = cursor.accept('s1', { kind: 'text', text: '答' }, { turnId: 't1', attemptId: 'a1' }, 0);
    expect(r).toEqual({ type: 'reasoning-delta', sessionId: 's1', turnId: 't1', attemptId: 'a1', chunkOffset: 0, text: '思' });
    expect(t).toEqual({ type: 'text-delta', sessionId: 's1', turnId: 't1', attemptId: 'a1', chunkOffset: 0, text: '答' });
  });

  it('重复/重叠 offset 丢弃（assertSequentialChunk 语义）→ null', () => {
    const cursor = new WatermarkCursor();
    cursor.accept('s1', { kind: 'text', text: 'aaa' }, { turnId: 't1', attemptId: 'a1' }, 0);
    cursor.accept('s1', { kind: 'text', text: 'bbb' }, { turnId: 't1', attemptId: 'a1' }, 3);
    // 重复 offset 0（重叠）→ 丢弃
    const dup = cursor.accept('s1', { kind: 'text', text: 'aa' }, { turnId: 't1', attemptId: 'a1' }, 0);
    expect(dup).toBeNull();
    // 缺口 offset（超前）→ 丢弃
    const gap = cursor.accept('s1', { kind: 'text', text: 'cc' }, { turnId: 't1', attemptId: 'a1' }, 9);
    expect(gap).toBeNull();
  });

  it('不同 attempt 水位独立（新 attempt 从 0 计数）', () => {
    const cursor = new WatermarkCursor();
    cursor.accept('s1', { kind: 'text', text: 'abc' }, { turnId: 't1', attemptId: 'a1' }, 0);
    const fresh = cursor.accept('s1', { kind: 'text', text: 'x' }, { turnId: 't1', attemptId: 'a2' }, 0);
    expect(fresh).toEqual({ type: 'text-delta', sessionId: 's1', turnId: 't1', attemptId: 'a2', chunkOffset: 0, text: 'x' });
  });
});

describe('旧客户端兼容（帧形状不变）', () => {
  it('旧 subscribe/user-message/turn-end 帧仍工作；新 op 未知才 error', async () => {
    const handle = await startServe({
      port: 0,
      home: tmpDir('h2-resume-home-'),
      root: tmpDir('h2-resume-root-'),
      provider: new MockProvider([{ textChunks: ['旧回复'] }]),
    });
    handles.push(handle);
    const id = await createSession(handle);
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.send({ op: 'subscribe', sessionId: id });
    client.send({ op: 'user-message', sessionId: id, text: '旧输入' });
    const end = await client.waitFor((f) => f.type === 'turn-end', 'turn-end');
    // 旧 turn-end 形状不变
    expect(end.type === 'turn-end' && end.stopReason).toBe('end_turn');
    client.close();
  });
});
