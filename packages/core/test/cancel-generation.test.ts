// FixB：cancelAck turn 代次语义（重连重放旧 cancel 帧不撞复用 turnId 的新 turn）。
// 覆盖（判定标准 B）：
//   1) matchTurnGeneration 纯函数：同代次命中 / 异代次拒 / 旧帧无代次 missing / 非法代次 fail-closed；
//   2) hub 级真实运行 turn 的代次守卫：旧代次 cancel → unknown 且**不中止**运行中 turn；
//      正确代次 cancel → stopping → cancelled；
//   3) WS 级重连重放：旧连接 replay 旧帧（已结束 turn 的 id+代次）不打扰运行中的新 turn，
//      新 turn 正常 end_turn 完成；旧帧无代次字段不崩（旧客户端兼容回退 target.id）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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
import type { AttemptSnapshot, MockReply } from '../src/index.js';
import type { CancelRequest, ResumeSnapshot } from '../src/interaction/types.js';
import { isTurnGeneration, matchTurnGeneration } from '../src/interaction/types.js';

const dirs: string[] = [];
const handles: ServeHandle[] = [];
function tmpDir(prefix = 'h2-cancel-gen-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 8000, step = 20): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > until) throw new Error('waitFor 超时');
    await sleep(step);
  }
}

function makeHub(script: readonly MockReply[]) {
  const hub = new SessionHub({
    manager: new SessionManager(defaultSessionsRoot(tmpDir('h2-cancel-gen-home-'))),
    provider: new MockProvider(script),
    tools: (() => {
      const r = new ToolRegistry();
      registerBuiltinTools(r);
      return r;
    })(),
    cwd: tmpDir('h2-cancel-gen-root-'),
  });
  return hub;
}

/** 从 resume-snapshot 读运行中 attempt（含 FixB generation） */
function activeAttemptOf(hub: SessionHub, sessionId: string): AttemptSnapshot | undefined {
  return hub.resumeSnapshot({ sessionId, lastSeq: 0, epoch: 1 })?.activeAttempt;
}

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
  async waitFor(pred: (f: WsServerMessage) => boolean, description: string, fromIndex = 0): Promise<WsServerMessage> {
    for (let i = 0; i < 500; i++) {
      const idx = this.frames.findIndex((f, at) => at >= fromIndex && pred(f));
      if (idx >= fromIndex) return this.frames[idx]!;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 10);
      });
    }
    throw new Error(`等待帧超时: ${description}（已收到 ${this.frames.length} 帧）`);
  }
}

describe('matchTurnGeneration 纯函数（代次匹配逻辑单测）', () => {
  it('isTurnGeneration：>=1 整数为合法代次；0/负数/小数/非数/字符串拒绝', () => {
    expect(isTurnGeneration(1)).toBe(true);
    expect(isTurnGeneration(7)).toBe(true);
    expect(isTurnGeneration(0)).toBe(false);
    expect(isTurnGeneration(-1)).toBe(false);
    expect(isTurnGeneration(1.5)).toBe(false);
    expect(isTurnGeneration(Number.NaN)).toBe(false);
    expect(isTurnGeneration('2')).toBe(false);
    expect(isTurnGeneration(undefined)).toBe(false);
  });

  it('同代次命中 → match', () => {
    expect(matchTurnGeneration(2, 2)).toBe('match');
  });

  it('异代次（旧代次帧撞新 turn）→ stale 拒', () => {
    expect(matchTurnGeneration(1, 2)).toBe('stale');
    expect(matchTurnGeneration(3, 2)).toBe('stale');
  });

  it('帧无代次（旧客户端）→ missing（调用方回退 target.id）', () => {
    expect(matchTurnGeneration(undefined, 2)).toBe('missing');
    expect(matchTurnGeneration(undefined, undefined)).toBe('missing');
  });

  it('帧带非法代次 / 目标无代次 → stale（fail-closed 不误伤）', () => {
    expect(matchTurnGeneration(0, 2)).toBe('stale');
    expect(matchTurnGeneration(1.5, 2)).toBe('stale');
    expect(matchTurnGeneration(2, undefined)).toBe('stale');
  });
});

describe('hub.cancelAck turn 代次守卫（真实运行 turn）', () => {
  it('旧代次 cancel → unknown 且不中止运行中 turn；正确代次 → stopping → cancelled', { timeout: 20000 }, async () => {
    // 第一轮快速完成 → 代次计数器推进（turn A = gen 1）；第二轮慢速流式保持运行（turn B = gen 2）
    const hub = makeHub([{ textChunks: ['A-fast'] }, { textChunks: ['B-1', 'B-2', 'B-3'], chunkDelayMs: 300 }]);
    const id = hub.create(tmpDir('h2-cancel-gen-sess-')).id;
    try {
      hub.sendUserMessage(id, '第一轮（快）');
      await waitFor(() => !hub.isBusy(id)); // turn A 完成
      hub.sendUserMessage(id, '第二轮（慢）');
      await waitFor(() => {
        const a = activeAttemptOf(hub, id);
        return a !== undefined && a.generation !== undefined;
      });
      const a = activeAttemptOf(hub, id)!;
      expect(a.generation).toBe(2); // turn A 已推进代次，turn B 代次 = 2
      expect(typeof a.turnId).toBe('string');

      // 旧代次（turn A 的代次 1）cancel turn B → unknown，且 turn B 未被中止
      const stale: CancelRequest = {
        requestId: 'cnl-stale',
        target: { kind: 'turn', id: a.turnId },
        expectedId: a.turnId,
        expectedTurnGeneration: 1,
      };
      const staleAck = hub.cancelAck(stale);
      expect(staleAck.state).toBe('unknown');
      expect(hub.isBusy(id)).toBe(true); // turn B 仍在运行（不误杀）

      // 正确代次 cancel → stopping
      const ok: CancelRequest = {
        requestId: 'cnl-ok',
        target: { kind: 'turn', id: a.turnId },
        expectedId: a.turnId,
        expectedTurnGeneration: a.generation,
      };
      const okAck = hub.cancelAck(ok);
      expect(okAck.state).toBe('stopping');
      await waitFor(() => !hub.isBusy(id)); // turn B 以 cancelled 收尾
      // 确认 cancelled（同代次）
      const confirm: CancelRequest = {
        requestId: 'cnl-confirm',
        target: { kind: 'turn', id: a.turnId },
        expectedId: a.turnId,
        expectedTurnGeneration: a.generation,
      };
      expect(hub.cancelAck(confirm).state).toBe('cancelled');
    } finally {
      await hub.close();
    }
  });

  it('旧帧无代次字段 → 不崩、回退 target.id（stopping/cancelled 语义不变）', { timeout: 20000 }, async () => {
    const hub = makeHub([{ textChunks: ['L-1', 'L-2', 'L-3'], chunkDelayMs: 300 }]);
    const id = hub.create(tmpDir('h2-cancel-gen-legacy-')).id;
    try {
      hub.sendUserMessage(id, '旧客户端帧');
      await waitFor(() => {
        const a = activeAttemptOf(hub, id);
        return a !== undefined;
      });
      const a = activeAttemptOf(hub, id)!;
      // 无 expectedTurnGeneration（旧客户端形状）→ 回退 target.id 匹配，不崩
      const legacy: CancelRequest = {
        requestId: 'cnl-legacy',
        target: { kind: 'turn', id: a.turnId },
        expectedId: a.turnId,
      };
      expect(hub.cancelAck(legacy).state).toBe('stopping');
      await waitFor(() => !hub.isBusy(id));
      // 旧帧对已取消 turn 二次确认 → cancelled
      const confirm: CancelRequest = {
        requestId: 'cnl-legacy-2',
        target: { kind: 'turn', id: a.turnId },
      };
      expect(hub.cancelAck(confirm).state).toBe('cancelled');
      // 未知 turn + 无代次 → unknown（不冒充）
      expect(
        hub.cancelAck({ requestId: 'cnl-unknown', target: { kind: 'turn', id: 'turn-does-not-exist' } }).state,
      ).toBe('unknown');
    } finally {
      await hub.close();
    }
  });

  it('已取消 turn：带旧代次的确认帧 → unknown（代次记忆不串）', { timeout: 20000 }, async () => {
    const hub = makeHub([{ textChunks: ['C-1', 'C-2', 'C-3'], chunkDelayMs: 300 }]);
    const id = hub.create(tmpDir('h2-cancel-gen-mem-')).id;
    try {
      hub.sendUserMessage(id, '跑一轮');
      await waitFor(() => {
        const a = activeAttemptOf(hub, id);
        return a !== undefined && a.generation !== undefined;
      });
      const a = activeAttemptOf(hub, id)!;
      const gen = a.generation!;
      expect(
        hub.cancelAck({
          requestId: 'c1',
          target: { kind: 'turn', id: a.turnId },
          expectedId: a.turnId,
          expectedTurnGeneration: gen,
        }).state,
      ).toBe('stopping');
      await waitFor(() => !hub.isBusy(id));
      // 正确代次确认 → cancelled
      expect(
        hub.cancelAck({
          requestId: 'c2',
          target: { kind: 'turn', id: a.turnId },
          expectedTurnGeneration: gen,
        }).state,
      ).toBe('cancelled');
      // 异代次确认（旧代次帧）→ unknown（不误认已取消）
      expect(
        hub.cancelAck({
          requestId: 'c3',
          target: { kind: 'turn', id: a.turnId },
          expectedTurnGeneration: gen - 1,
        }).state,
      ).toBe('unknown');
    } finally {
      await hub.close();
    }
  });
});

describe('WS 重连重放：旧 cancel 帧不撞运行中的新 turn', () => {
  it(
    'turn A 取消后开启 turn B；重放 turn A 旧帧（id+代次）→ 不打扰 turn B，turn B 正常 end_turn',
    { timeout: 20000 },
    async () => {
      const handle = await startServe({
        port: 0,
        home: tmpDir('h2-cancel-gen-home-'),
        root: tmpDir('h2-cancel-gen-root-'),
        provider: new MockProvider([
          { textChunks: ['A-1', 'A-2', 'A-3'], chunkDelayMs: 300 },
          { textChunks: ['B-1', 'B-2', 'B-3'], chunkDelayMs: 300 },
        ]),
      });
      handles.push(handle);
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: tmpDir('h2-cancel-gen-cwd-') }),
      });
      const id = ((await res.json()) as { id: string }).id;

      const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
      await client.open;
      client.send({ op: 'subscribe', sessionId: id });

      // —— turn A：启动 → 学代次 → 正确代次取消 ——
      // 先恢复订阅（v2）→ 后续增量走带水位 text-delta 帧，且 resume-snapshot 供读运行 turn 代次
      client.send({ op: 'resume-subscription', sessionId: id, lastSeq: 0, epoch: 1 });
      await client.waitFor((f) => f.type === 'resume-snapshot', 'resume-snapshot init');
      client.send({ op: 'user-message', sessionId: id, text: '第一轮' });
      const evA = await client.waitFor((f) => f.type === 'event' && f.event.type === 'user/message', 'user/message A');
      if (evA.type !== 'event') throw new Error('unreachable: evA');
      const turnIdA = (evA.event as { payload?: { turnId?: string } }).payload?.turnId as string;
      expect(typeof turnIdA).toBe('string');
      // 学到 turn A 的代次（等首个 delta 绑定位后 resume-snapshot activeAttempt.generation）
      await client.waitFor((f) => f.type === 'text-delta', 'text-delta A');
      client.send({ op: 'resume-subscription', sessionId: id, lastSeq: 0, epoch: 1 });
      const snap = await client.waitFor((f) => f.type === 'resume-snapshot', 'resume-snapshot A', client.frames.length);
      const snapshot = snap.type === 'resume-snapshot' ? (snap.snapshot as ResumeSnapshot) : undefined;
      const genA = snapshot?.activeAttempt?.generation;
      expect(typeof genA).toBe('number');
      client.send({
        op: 'cancel',
        requestId: 'cnl-a',
        target: { kind: 'turn', id: turnIdA },
        expectedId: turnIdA,
        expectedTurnGeneration: genA,
      });
      const ackA = await client.waitFor((f) => f.type === 'cancel-ack' && f.requestId === 'cnl-a', 'cancel-ack A');
      expect(ackA.type === 'cancel-ack' && ackA.state).toBe('stopping');
      await client.waitFor((f) => f.type === 'turn-end' && f.stopReason === 'cancelled', 'turn A cancelled');

      // —— turn B：运行中，重放 turn A 旧帧 ——
      client.send({ op: 'user-message', sessionId: id, text: '第二轮' });
      const evB = await client.waitFor(
        (f) => f.type === 'event' && f.event.type === 'user/message',
        'user/message B',
        client.frames.length,
      );
      if (evB.type !== 'event') throw new Error('unreachable: evB');
      const turnIdB = (evB.event as { payload?: { turnId?: string } }).payload?.turnId as string;
      expect(turnIdB).not.toBe(turnIdA);
      // 等 turn B 真正流式开始（display 绑定）后再重放旧帧；按 turnId 匹配避免帧时序竞态
      await client.waitFor(
        (f) => f.type === 'text-delta' && f.turnId === turnIdB,
        'text-delta B',
        client.frames.length,
      );
      client.send({
        op: 'cancel',
        requestId: 'cnl-replay',
        target: { kind: 'turn', id: turnIdA }, // 旧连接重放 turn A 的帧
        expectedId: turnIdA,
        expectedTurnGeneration: genA,
      });
      const replayAck = await client.waitFor(
        (f) => f.type === 'cancel-ack' && f.requestId === 'cnl-replay',
        'replay ack',
      );
      // 旧帧要么确认 turn A 已取消（cancelled），要么 unknown——绝不 stopping/撞 turn B
      expect(
        replayAck.type === 'cancel-ack' && (replayAck.state === 'cancelled' || replayAck.state === 'unknown'),
      ).toBe(true);
      // 新 turn B 不被中止：正常 end_turn 完成（turn A 已 cancelled，唯一 end_turn 即 turn B）
      const endB = await client.waitFor((f) => f.type === 'turn-end' && f.stopReason === 'end_turn', 'turn B end');
      expect(endB.type === 'turn-end' && endB.stopReason).toBe('end_turn');
      // 全程只有 turn A 被取消（turn B 无 cancelled）
      const cancelledEnds = client.frames.filter((f) => f.type === 'turn-end' && f.stopReason === 'cancelled').length;
      expect(cancelledEnds).toBe(1);
      client.close();
    },
  );

  it('旧客户端 cancel 帧（无 expectedTurnGeneration）在 WS 层不崩，转发原样', { timeout: 20000 }, async () => {
    const handle = await startServe({
      port: 0,
      home: tmpDir('h2-cancel-gen-home-'),
      root: tmpDir('h2-cancel-gen-root-'),
      provider: new MockProvider([{ textChunks: ['L-1', 'L-2'], chunkDelayMs: 200 }]),
    });
    handles.push(handle);
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: tmpDir('h2-cancel-gen-cwd-') }),
    });
    const id = ((await res.json()) as { id: string }).id;
    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.send({ op: 'subscribe', sessionId: id });
    client.send({ op: 'user-message', sessionId: id, text: '旧帧' });
    const ev = await client.waitFor((f) => f.type === 'event' && f.event.type === 'user/message', 'user/message');
    if (ev.type !== 'event') throw new Error('unreachable: ev');
    const turnId = (ev.event as { payload?: { turnId?: string } }).payload?.turnId as string;
    // 等 turn 真正开始流式（display 绑定、runningTurnId 可定位）后再 cancel；
    // 旧客户端（未 resume）收到的仍是旧形状 delta 帧
    await client.waitFor((f) => f.type === 'delta' && f.kind === 'text', 'delta legacy');
    // 旧形状：只有 requestId + target + expectedId，无 expectedTurnGeneration
    client.send({ op: 'cancel', requestId: 'cnl-legacy', target: { kind: 'turn', id: turnId }, expectedId: turnId });
    const ack = await client.waitFor(
      (f) => f.type === 'cancel-ack' && f.requestId === 'cnl-legacy',
      'legacy cancel-ack',
    );
    expect(ack.type === 'cancel-ack' && ack.state).toBe('stopping');
    client.close();
  });
});
