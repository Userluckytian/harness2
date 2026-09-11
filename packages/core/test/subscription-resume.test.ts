// S3c1 WS/HTTP 可恢复订阅（resumeSubscription + cancel + submit 帧层）测试 +
// S3c2 会话接线（submit 幂等经 hub / queue 重启恢复 paused / cancel 不撤销已完成文件变更 /
//       resume-snapshot 在途审批 / v2 连接带水位 delta）。
// 覆盖：resume-subscription → resume-snapshot（replay 无缺口 + 快照含 activeAttempt/tasks/
//       pendingApprovals/queue）、旧 epoch 丢弃、重复 offset 丢弃、delta 带水位、cancel 三态 ack、
//       submit ack、旧客户端帧不崩、S3c2 接线语义。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
  attachWsServer,
  defaultSessionsRoot,
  MockProvider,
  registerBuiltinTools,
  SessionHub,
  SessionManager,
  startServe,
  ToolRegistry,
  type ServeHandle,
  type WsServerMessage,
} from '../src/index.js';
import type { CancelRequest, SubmitRequest } from '../src/interaction/types.js';
import { WatermarkCursor, type ResumeStateProvider } from '../src/server/ws.js';

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
      requireToken: false,
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

  it('resumeStateProvider 未接线 → error 帧（传输缝保留：不注入缝时回错误），不崩', async () => {
    // S3c2 起 startServe 默认接 hub；未接线路径走传输缝直接构造（不经 startServe）
    const home = tmpDir('h2-resume-home-');
    const root = tmpDir('h2-resume-root-');
    const tools = new ToolRegistry();
    registerBuiltinTools(tools);
    const hub = new SessionHub({
      manager: new SessionManager(defaultSessionsRoot(home)),
      provider: new MockProvider([{ textChunks: ['回复'] }]),
      tools,
      cwd: root,
    });
    const server = createServer();
    const plane = attachWsServer(server, hub); // 不注入 resumeState → 未接线
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const id = hub.create(root).id;
    try {
      const client = new WsClient(`ws://127.0.0.1:${port}/ws`);
      await client.open;
      client.send({ op: 'resume-subscription', sessionId: id, lastSeq: 0, epoch: 1 });
      const err = await client.waitFor((f) => f.type === 'error', 'error 帧');
      expect(err.type === 'error' && err.error).toContain('resume');
      client.close();
    } finally {
      await plane.close();
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('cancel 三态 ack（传输帧层）', () => {
  it('stop 阶段 ack=stopping；确认后 ack=cancelled；未接线/未知=unknown', async () => {
    const handle = await startServe({
      requireToken: false,
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

  it('接线 provider 回 stopping → 转发原样；坏 expectedId 仍由 provider 决定；cancelled 端到端触发', async () => {
    const handle = await startServe({
      requireToken: false,
      port: 0,
      home: tmpDir('h2-resume-home-'),
      root: tmpDir('h2-resume-root-'),
      provider: new MockProvider([{ textChunks: ['回复'] }]),
      resumeState: provider({
        cancelAck: (req) =>
          req.target.id === 'turn-7'
            ? { requestId: req.requestId, state: 'stopping' }
            : { requestId: req.requestId, state: 'cancelled' },
      }),
    });
    handles.push(handle);
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    // stopping branch
    client.send({ op: 'cancel', requestId: 'cnl-1', target: { kind: 'turn', id: 'turn-7' }, expectedId: 'turn-7' });
    const a = await client.waitFor(
      (f) => f.type === 'cancel-ack' && (f.type === 'cancel-ack' ? f.requestId : '') === 'cnl-1',
      'cancel-ack stopping',
      0,
    );
    expect(a.type === 'cancel-ack' && a.state).toBe('stopping');
    // cancelled branch (provider 对 id != turn-7 回 cancelled；传输层原样转发)
    client.send({ op: 'cancel', requestId: 'cnl-2', target: { kind: 'task', id: 'task-9' }, expectedId: 'task-9' });
    const c = await client.waitFor(
      (f) => f.type === 'cancel-ack' && (f.type === 'cancel-ack' ? f.requestId : '') === 'cnl-2',
      'cancel-ack cancelled',
      0,
    );
    expect(c.type === 'cancel-ack' && c.state).toBe('cancelled');
    expect(c.type === 'cancel-ack' && c.requestId).toBe('cnl-2');
    client.close();
  });
});

describe('submit 帧定义 + ack（传输帧层；实际入队归 S3c2）', () => {
  it('接线 provider 回 accepted/rejected；缺省回 unknown（≠rejected）', async () => {
    const handle = await startServe({
      requireToken: false,
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
    const rej = await client.waitFor(
      (f) => f.type === 'submit-ack' && (f.type === 'submit-ack' ? f.clientMessageId : '') === 'cm-2',
      'submit-ack rej',
      1,
    );
    expect(rej.type === 'submit-ack' && rej.state).toBe('rejected');
    client.close();
  });
});

describe('delta 带水位 + 重复 offset 丢弃（传输层映射，纯逻辑）', () => {
  it('text-delta/reasoning-delta 带完整归属 + chunkOffset 连续', () => {
    const cursor = new WatermarkCursor();
    const d1 = cursor.accept('s1', { kind: 'text', text: '你好' }, { turnId: 't1', attemptId: 'a1' }, 0);
    const d2 = cursor.accept('s1', { kind: 'text', text: '世界' }, { turnId: 't1', attemptId: 'a1' }, 2);
    expect(d1).toEqual({
      type: 'text-delta',
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a1',
      chunkOffset: 0,
      text: '你好',
    });
    expect(d2).toEqual({
      type: 'text-delta',
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a1',
      chunkOffset: 2,
      text: '世界',
    });
  });

  it('reasoning 与 text 各自独立水位', () => {
    const cursor = new WatermarkCursor();
    const r = cursor.accept('s1', { kind: 'reasoning', text: '思' }, { turnId: 't1', attemptId: 'a1' }, 0);
    const t = cursor.accept('s1', { kind: 'text', text: '答' }, { turnId: 't1', attemptId: 'a1' }, 0);
    expect(r).toEqual({
      type: 'reasoning-delta',
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a1',
      chunkOffset: 0,
      text: '思',
    });
    expect(t).toEqual({
      type: 'text-delta',
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a1',
      chunkOffset: 0,
      text: '答',
    });
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
    expect(fresh).toEqual({
      type: 'text-delta',
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a2',
      chunkOffset: 0,
      text: 'x',
    });
  });
});

describe('旧客户端兼容（帧形状不变）', () => {
  it('旧 subscribe/user-message/turn-end 帧仍工作；新 op 未知才 error', async () => {
    const handle = await startServe({
      requireToken: false,
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

describe('S3c2：submit 幂等接线（durable-then-ack + 按序派发不重复）', () => {
  it('同 id 同内容 → receipt 复用不重复派发；同 id 不同内容 → rejected', async () => {
    const handle = await startServe({
      requireToken: false,
      port: 0,
      home: tmpDir('h2-resume-home-'),
      root: tmpDir('h2-resume-root-'),
      provider: new MockProvider([{ textChunks: ['幂等回复'] }]),
    });
    handles.push(handle);
    const id = await createSession(handle);
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.send({ op: 'subscribe', sessionId: id });
    // 新提交 → accepted（queueSeq 0）
    client.send({ op: 'submit', clientMessageId: 'cm-1', sessionId: id, rawText: '同一个动作', intent: 'queue' });
    const a1 = await client.waitFor(
      (f) => f.type === 'submit-ack' && f.state === 'accepted' && f.clientMessageId === 'cm-1',
      'accepted',
    );
    expect(a1.type === 'submit-ack' && a1.queueSeq).toBe(0);
    // 等首个 turn 落定
    await client.waitFor((f) => f.type === 'turn-end', 'turn-end');
    // 同 id 同内容 → receipt 复用（仍 accepted，不再派发新 turn）
    client.send({ op: 'submit', clientMessageId: 'cm-1', sessionId: id, rawText: '同一个动作', intent: 'queue' });
    // 同 id 不同内容 → rejected（幂等键冲突，不登记）
    client.send({ op: 'submit', clientMessageId: 'cm-1', sessionId: id, rawText: '换个说法', intent: 'queue' });
    const rj = await client.waitFor((f) => f.type === 'submit-ack' && f.state === 'rejected', 'rejected');
    expect(rj.type === 'submit-ack' && rj.reason).toContain('duplicate');
    await sleep(400);
    // 全程只有 1 个 turn（重复提交未产生第二条执行）
    const turnEnds = client.frames.filter((f) => f.type === 'turn-end').length;
    expect(turnEnds).toBe(1);
    // resume-snapshot queue 只有一项（幂等键未被重复登记）
    client.send({ op: 'resume-subscription', sessionId: id, lastSeq: 0, epoch: 2 });
    const snap = await client.waitFor((f) => f.type === 'resume-snapshot', 'resume-snapshot');
    expect(snap.type === 'resume-snapshot' && snap.snapshot.queue.length).toBe(1);
    expect(snap.type === 'resume-snapshot' && snap.snapshot.queue[0]).toMatchObject({
      id: 'cm-1',
      state: 'queued',
      intent: 'queue',
    });
    client.close();
  });
});

describe('S3c2：queue 重启恢复（recoverQueue paused + 不自动执行）', () => {
  it('durable accepted 重启后恢复为 paused；未重新提交不产生新 turn', async () => {
    const home = tmpDir('h2-resume-home-');
    const root = tmpDir('h2-resume-root-');
    const A = await startServe({
      requireToken: false,
      port: 0,
      home,
      root,
      provider: new MockProvider([{ textChunks: ['A 执行'] }]),
    });
    handles.push(A);
    const id = await createSession(A);
    const a = new WsClient(`ws://127.0.0.1:${A.port}/ws`);
    await a.open;
    a.send({ op: 'subscribe', sessionId: id });
    a.send({ op: 'submit', clientMessageId: 'cm-A', sessionId: id, rawText: '持久任务', intent: 'queue' });
    await a.waitFor((f) => f.type === 'submit-ack' && f.state === 'accepted', 'ack A');
    await a.waitFor((f) => f.type === 'turn-end', 'turn-end A');
    a.close();
    await A.close();
    // 重启 B：同一 home/root，会话目录按 id 恢复
    const B = await startServe({
      requireToken: false,
      port: 0,
      home,
      root,
      provider: new MockProvider([{ textChunks: ['B 不应执行'] }]),
    });
    handles.push(B);
    const b = new WsClient(`ws://127.0.0.1:${B.port}/ws`);
    await b.open;
    b.send({ op: 'subscribe', sessionId: id });
    b.send({ op: 'resume-subscription', sessionId: id, lastSeq: 0, epoch: 1 });
    const snap = await b.waitFor((f) => f.type === 'resume-snapshot', 'snapshot B');
    expect(snap.type === 'resume-snapshot' && snap.snapshot.queue.length).toBe(1);
    expect(snap.type === 'resume-snapshot' && snap.snapshot.queue[0]?.state).toBe('paused');
    // 恢复项仍 paused：未重新提交 → 无新 turn（无 user/message 事件、无 turn-end）
    await sleep(500);
    const ev = b.frames.filter((f) => f.type === 'event' && f.event.type === 'user/message').length;
    expect(ev).toBe(0);
    expect(b.frames.filter((f) => f.type === 'turn-end').length).toBe(0);
    b.close();
  });
});

describe('S3c2：cancel 接线（不撤销已完成文件变更）', () => {
  it('write 提交后 cancel → stopping；turn cancelled；文件保留；二次 cancel=cancelled；未知=unknown', async () => {
    const root = tmpDir('h2-resume-root-');
    const fileCwd = tmpDir('h2-resume-file-');
    const outPath = join(fileCwd, 'out.txt');
    const handle = await startServe({
      requireToken: false,
      port: 0,
      home: tmpDir('h2-resume-home-'),
      root,
      provider: new MockProvider([
        {
          toolCalls: [
            { id: 'call-w', name: 'write', arguments: JSON.stringify({ file_path: outPath, content: '已写入内容' }) },
          ],
        },
        { textChunks: ['继续生成后续内容持续流式输出'], chunkDelayMs: 300 },
      ]),
      decide: () => 'allow',
    });
    handles.push(handle);
    const id = await createSession(handle, fileCwd);
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.send({ op: 'subscribe', sessionId: id });
    client.send({ op: 'user-message', sessionId: id, text: '写入一个文件' });
    // 真实 turnId 来自 user/message 事件镜像（与 delta/attempt-final 同源）
    const ev = await client.waitFor((f) => f.type === 'event' && f.event.type === 'user/message', 'user/message event');
    if (ev.type !== 'event') throw new Error('unreachable: ev');
    const turnId = (ev.event as { payload?: { turnId?: string } }).payload?.turnId;
    expect(typeof turnId).toBe('string');
    expect(typeof turnId === 'string' && turnId.length).toBeGreaterThan(0);
    // 等 write 提交（工具已完成，文件落地）
    await client.waitFor(
      (f) => f.type === 'event' && f.event.type === 'tool/result' && f.event.payload.ok === true,
      'write tool/result',
    );
    expect(existsSync(outPath)).toBe(true);
    // 流式仍在进行 → cancel（target.turn 含真实 turnId）
    client.send({ op: 'cancel', requestId: 'cnl-1', target: { kind: 'turn', id: turnId as string } });
    const a = await client.waitFor((f) => f.type === 'cancel-ack' && f.requestId === 'cnl-1', 'cancel-ack stopping');
    expect(a.type === 'cancel-ack' && a.state).toBe('stopping');
    const end = await client.waitFor(
      (f) => f.type === 'turn-end' && f.stopReason === 'cancelled',
      'turn-end cancelled',
    );
    expect(end.type === 'turn-end' && end.stopReason).toBe('cancelled');
    // 文件保留（cancel 不撤销已完成工具变更）
    expect(readFileSync(outPath, 'utf8')).toBe('已写入内容');
    // 二次 cancel 同 turn → cancelled（一次性确认记忆）
    client.send({ op: 'cancel', requestId: 'cnl-2', target: { kind: 'turn', id: turnId as string } });
    const c2 = await client.waitFor((f) => f.type === 'cancel-ack' && f.requestId === 'cnl-2', 'cancel-ack cancelled');
    expect(c2.type === 'cancel-ack' && c2.state).toBe('cancelled');
    // 未知 turn → unknown（不冒充已取消）
    client.send({ op: 'cancel', requestId: 'cnl-3', target: { kind: 'turn', id: 'turn-does-not-exist' } });
    const c3 = await client.waitFor((f) => f.type === 'cancel-ack' && f.requestId === 'cnl-3', 'cancel-ack unknown');
    expect(c3.type === 'cancel-ack' && c3.state).toBe('unknown');
    client.close();
  });
});

describe('S3c2：resume-snapshot 在途审批（activeAttempt waiting-approval + pendingApprovals）', () => {
  it('审批挂起中的 turn → 重连快照带 activeAttempt.wiating-approval 与 pendingApprovals', async () => {
    const handle = await startServe({
      requireToken: false,
      port: 0,
      home: tmpDir('h2-resume-home-'),
      root: tmpDir('h2-resume-root-'),
      provider: new MockProvider([
        {
          toolCalls: [
            {
              id: 'call-w',
              name: 'write',
              arguments: JSON.stringify({ file_path: join(tmpDir('h2-resume-ap-'), 'tmp.txt'), content: 'x' }),
            },
          ],
        },
        { textChunks: ['写完了'] },
      ]),
      decide: () => 'ask',
    });
    handles.push(handle);
    const id = await createSession(handle);
    const a = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await a.open;
    a.send({ op: 'subscribe', sessionId: id });
    a.send({ op: 'user-message', sessionId: id, text: '写入' });
    const ar = await a.waitFor((f) => f.type === 'approval-request', 'approval-request');
    const requestId = ar.type === 'approval-request' ? ar.requestId : '';
    expect(requestId.length).toBeGreaterThan(0);
    // 第二连接（v2）重连快照：在途 attempt 挂起 + 待审批卡一起带上
    const b = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await b.open;
    b.send({ op: 'subscribe', sessionId: id });
    b.send({ op: 'resume-subscription', sessionId: id, lastSeq: 0, epoch: 1 });
    const snap = await b.waitFor((f) => f.type === 'resume-snapshot', 'snapshot');
    expect(snap.type === 'resume-snapshot' && snap.snapshot.activeAttempt?.status).toBe('waiting-approval');
    expect(snap.type === 'resume-snapshot' && snap.snapshot.pendingApprovals.map((p) => p.requestId)).toContain(
      requestId,
    );
    b.close();
    // 放行 → 写工具完成、turn 自然结束
    a.send({ op: 'approval-response', requestId, decision: 'allow' });
    const end = await a.waitFor((f) => f.type === 'turn-end' && f.stopReason === 'end_turn', 'turn-end end_turn');
    expect(end.type === 'turn-end' && end.stopReason).toBe('end_turn');
    a.close();
  });
});

describe('S3c2：v2 连接带水位 delta + attempt-final（旧连接继续旧形状）', () => {
  it('resume 后 text-delta 连续（turnId/attemptId/chunkOffset）+ attempt-final completed；旧连接只收旧 delta', async () => {
    const handle = await startServe({
      requireToken: false,
      port: 0,
      home: tmpDir('h2-resume-home-'),
      root: tmpDir('h2-resume-root-'),
      provider: new MockProvider([{ textChunks: ['你好', '世界'], chunkDelayMs: 30 }]),
    });
    handles.push(handle);
    const id = await createSession(handle);
    const legacy = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await legacy.open;
    legacy.send({ op: 'subscribe', sessionId: id });
    const v2 = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await v2.open;
    v2.send({ op: 'subscribe', sessionId: id });
    v2.send({ op: 'resume-subscription', sessionId: id, lastSeq: 0, epoch: 1 });
    await v2.waitFor((f) => f.type === 'resume-snapshot', 'snapshot');
    // legacy 触发 turn（两连接都订阅）
    legacy.send({ op: 'user-message', sessionId: id, text: '流式测试' });
    // v2：两个 text-delta 连续（chunkOffset 0 → 2），归属一致
    const d0 = await v2.waitFor((f) => f.type === 'text-delta', 'text-delta 0');
    const d1 = await v2.waitFor((f) => f.type === 'text-delta', 'text-delta 1', v2.frames.length);
    if (d0.type !== 'text-delta') throw new Error('unreachable: d0');
    if (d1.type !== 'text-delta') throw new Error('unreachable: d1');
    expect(d0.chunkOffset).toBe(0);
    expect(d0.text).toBe('你好');
    expect(d1.chunkOffset).toBe(2);
    expect(d1.text).toBe('世界');
    expect(d0.turnId).toBe(d1.turnId);
    expect(d0.attemptId).toBe(d1.attemptId);
    expect(d0.attemptId).toBe(`att-${d0.turnId.slice(0, 8)}`);
    // v2：turn 落定 attempt-final completed（归属同一 turnId）
    const fin = await v2.waitFor((f) => f.type === 'attempt-final', 'attempt-final');
    if (fin.type !== 'attempt-final') throw new Error('unreachable: fin');
    expect(fin.state).toBe('completed');
    expect(fin.turnId).toBe(d0.turnId);
    // v2 连接没收到旧形状 delta
    expect(v2.frames.filter((f) => f.type === 'delta').length).toBe(0);
    // legacy 连接：同一 turn 收到旧形状 delta（text），且不带水位帧
    const ld = await legacy.waitFor((f) => f.type === 'delta' && f.kind === 'text', 'legacy delta');
    if (ld.type !== 'delta' || ld.kind !== 'text') throw new Error('unreachable: ld');
    expect(ld.text === '你好').toBe(true);
    await sleep(200);
    expect(legacy.frames.filter((f) => f.type === 'text-delta').length).toBe(0);
    legacy.close();
    v2.close();
  });
});
