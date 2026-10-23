import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@zcode/rpc';
import { createAgentService } from '../src/real/agent-service.js';

interface CapturedWire {
  kind?: string;
  topic?: string;
  subscriptionId?: string;
  frame?: {
    topic?: string;
    subscriptionId?: string;
    payload?: {
      kind?: string;
      snapshot?: { sessions?: Array<{ sessionId?: string }> };
      deltas?: Array<{ op?: string; session?: { sessionId?: string } }>;
    };
  };
}

function collectFrames(emitter: Emitter<unknown>): CapturedWire[] {
  const frames: CapturedWire[] = [];
  emitter.event((wire) => {
    const w = wire as CapturedWire;
    if (w.kind === 'complete' && w.frame && (w.topic ?? w.frame.topic ?? '').startsWith('sessions-index/')) {
      frames.push({ ...w, frame: w.frame });
    }
  });
  return frames;
}

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('ZS5-T3 sessions-index subscribe', () => {
  it('returns a valid ack shape', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-si-ack-'));
    try {
      const agent = createAgentService({ home });
      const res = (await (agent as any).subscribeSessionsIndexV4({ workspacePath: home })) as any;
      expect(res).toHaveProperty('ack');
      expect(typeof res.ack.subscriptionId).toBe('string');
      expect(res.ack.subscriptionId.length).toBeGreaterThan(0);
      expect(res.ack.mode).toBe('snapshot');
      expect(typeof res.ack.logEpoch).toBe('string');
      await (agent as any).unsubscribeSessionsIndexV4({ workspacePath: home, subscriptionId: res.ack.subscriptionId });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('emits a frame containing new session id within 5s after create', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-si-new-'));
    const emitter = new Emitter<unknown>();
    const frames = collectFrames(emitter);
    try {
      const agent = createAgentService({ home, emitter });
      const sub = (await (agent as any).subscribeSessionsIndexV4({ workspacePath: home })) as any;
      const sid = sub.ack.subscriptionId;

      const created = (await (agent as any).createSession({ workspacePath: home })) as any;
      const newId = created.sessionId;
      expect(newId).toBeTruthy();

      await waitFor(() =>
        frames.some((f) => {
          const sessions = f.frame?.payload?.snapshot?.sessions ?? [];
          return sessions.some((s) => s.sessionId === newId);
        }),
      );

      const hit = frames.find((f) => (f.frame?.payload?.snapshot?.sessions ?? []).some((s) => s.sessionId === newId));
      expect(hit).toBeTruthy();

      await (agent as any).unsubscribeSessionsIndexV4({ workspacePath: home, subscriptionId: sid });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 10000);

  it('stops emitting after unsubscribe', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-si-unsub-'));
    const emitter = new Emitter<unknown>();
    const frames = collectFrames(emitter);
    try {
      const agent = createAgentService({ home, emitter });
      const sub = (await (agent as any).subscribeSessionsIndexV4({ workspacePath: home })) as any;
      const sid = sub.ack.subscriptionId;
      await (agent as any).unsubscribeSessionsIndexV4({ workspacePath: home, subscriptionId: sid });

      const before = frames.length;
      // create a session after unsubscribe -> should not produce sessions-index frame
      await (agent as any).createSession({ workspacePath: home });
      // 轮询：最多 8s 内帧数不应增长
      const pollStart = Date.now();
      while (Date.now() - pollStart < 3500) {
        await new Promise((r) => setTimeout(r, 50));
        if (frames.length !== before) break;
      }
      const after = frames.length;
      expect(after).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 8000);

  it('shares a single sampler for two subscriptions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-si-spy-'));
    const spy = vi.spyOn(global, 'setInterval');
    try {
      const agent = createAgentService({ home });
      const sub1 = (await (agent as any).subscribeSessionsIndexV4({ workspacePath: home })) as any;
      const sub2 = (await (agent as any).subscribeSessionsIndexV4({ workspacePath: home })) as any;
      // ensureSessionsIndexTimer called twice but setInterval once
      expect(spy).toHaveBeenCalledTimes(1);
      await (agent as any).unsubscribeSessionsIndexV4({ workspacePath: home, subscriptionId: sub1.ack.subscriptionId });
      await (agent as any).unsubscribeSessionsIndexV4({ workspacePath: home, subscriptionId: sub2.ack.subscriptionId });
    } finally {
      spy.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not throw on unknown subscriptionId resync/unsubscribe', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-si-unk-'));
    try {
      const agent = createAgentService({ home });
      await expect(
        (agent as any).resyncSessionsIndexV4({ workspacePath: home, subscriptionId: 'no-such-id' }),
      ).resolves.toBeDefined();
      await expect(
        (agent as any).unsubscribeSessionsIndexV4({ workspacePath: home, subscriptionId: 'no-such-id' }),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns stable unavailable without throwing when no workspace', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-si-unavail-'));
    try {
      const agent = createAgentService({ home });
      const res = await (agent as any).subscribeSessionsIndexV4({});
      expect(res).toBeDefined();
      expect((res as any).available).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('ZS6 尾巴清偿：连接 dispose 回收轮询定时器并停帧', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-si-dispose-'));
    const emitter = new Emitter<unknown>();
    const frames = collectFrames(emitter);
    try {
      let disposer: (() => void) | null = null;
      const agent = createAgentService({
        home,
        emitter,
        registerDispose: (fn) => {
          disposer = fn;
        },
      });
      // 构造期即注册回收闭包（host factory→port close 链路的源头契约）
      expect(typeof disposer).toBe('function');
      await (agent as any).subscribeSessionsIndexV4({ workspacePath: home });
      // 模拟宿主连接死亡：调 dispose→定时器清除+订阅表清空
      (disposer as unknown as () => void)();
      const before = frames.length;
      await (agent as any).createSession({ workspacePath: home });
      const pollStart = Date.now();
      while (Date.now() - pollStart < 3500) {
        await new Promise((r) => setTimeout(r, 50));
        if (frames.length !== before) break;
      }
      expect(frames.length).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 8000);
});
