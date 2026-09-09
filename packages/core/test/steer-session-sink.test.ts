// S6 会话级 steer sink 测试（FixD F2）：hub（sessions.ts）持有会话级 sink，跨 turn 持久。
// 核心不变量（保持 S6 既有语义 + 会话级提升）：
//   1) 接收/去重/排队在会话级 sink（跨 turn 持续）：同 steer id 全局只生效一次——
//      第二 turn 提交同 id → 立即 rejected（不占队位、不双注入）；
//   2) 会话级排队：step 中提交的 steer 排入 sink，下一安全 step 边界应用；
//   3) stale（expectedTurnId 不符）经会话级 sink 仍拒且保 draft（draftKept），不进投影；
//   4) 投影不变：steer 不进 session.log 的 user/message 正文（事件溯源不破坏）。
// 全部经 hub + 本地 MockProvider + 临时目录；step 执行用 gate 门控做确定性同步（无 wall-clock 等待）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHub, type SessionHubHooks } from '../src/server/sessions.js';
import { SessionManager } from '../src/session/manager.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { MockProvider } from '../src/provider/mock.js';
import type { SteerResult } from '../src/interaction/types.js';
import { SESSION_LOG_FILE, type AnySessionEvent } from '../src/session/types.js';

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 事件驱动等待：不依赖固定 wall-clock，轮询直到条件满足（超时才抛） */
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`waitFor timeout (${timeoutMs}ms)`);
    await sleep(10);
  }
}

function makeTool(name: string, execute: ToolDefinition['execute'], extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: {} },
    execute,
    ...extra,
  };
}

function loadEvents(dir: string): AnySessionEvent[] {
  return readFileSync(join(dir, SESSION_LOG_FILE), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AnySessionEvent);
}

describe('S6 会话级 steer sink（hub 接线）', () => {
  it('会话级排队：step 中收到 steer → 排队，下一安全 step 边界应用；投影不变', async () => {
    const root = tmpDir('h2-steer-queue-');
    const manager = new SessionManager(join(root, 'sessions'));
    let openGate!: () => void;
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    const provider = new MockProvider([
      { toolCalls: [{ id: 'g1', name: 'gated', arguments: '{}' }] },
      { textChunks: ['完成'] },
    ]);
    const tools = new ToolRegistry();
    tools.register(makeTool('gated', async () => { await gate; return { output: 'ok' }; }, { cancelGuaranteed: true }));
    const hub = new SessionHub({ manager, provider, tools, cwd: root, decide: () => 'allow' });
    const steerResults: SteerResult[] = [];
    const turnIds: string[] = [];
    hub.addHooks({
      onEvent: (_sid, ev) => {
        if (ev.type === 'user/message' && ev.payload.turnId !== undefined) turnIds.push(ev.payload.turnId);
      },
      onSteerResult: (_sid, r) => steerResults.push(r),
    });
    const created = hub.create(root);

    // turn 1 开始，step 1（gated 工具执行中，被 gate 卡住）提交 steer
    hub.sendUserMessage(created.id, '开始');
    await waitFor(() => turnIds.length === 1);
    const ack = hub.submitAck({
      clientMessageId: 'st-1',
      sessionId: created.id,
      rawText: '现在转向方案 B',
      intent: 'steer',
      expectedTurnId: turnIds[0]!,
    });
    expect(ack.state).toBe('accepted');

    // 释放 step 1 → 边界 drain → steer 排队应用到 step 2
    openGate();
    await waitFor(() => steerResults.length === 1);
    expect(steerResults[0]).toEqual({ id: 'st-1', expectedTurnId: turnIds[0], state: 'accepted' });
    await waitFor(() => provider.requests.length === 2);
    expect(provider.requests[0]!.messages.map((m) => m.content)).not.toContain('现在转向方案 B');
    expect(provider.requests[1]!.messages.at(-1)).toMatchObject({ role: 'user', content: '现在转向方案 B' });

    // 投影不变：steer 不进 session.log user/message 正文
    for (const e of loadEvents(created.dir)) {
      if (e.type === 'user/message') expect(e.payload.text).not.toContain('现在转向方案 B');
    }
    await hub.close();
  });

  it('跨 turn 去重：同 steer id 两 turn 只生效一次（第二次提交拒绝，文本全局只注入一次）', async () => {
    const root = tmpDir('h2-steer-dedup-');
    const manager = new SessionManager(join(root, 'sessions'));
    let openGate!: () => void;
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    const provider = new MockProvider([
      { toolCalls: [{ id: 'g1', name: 'gated', arguments: '{}' }] },
      { textChunks: ['turn1 完成'] },
      { toolCalls: [{ id: 'g2', name: 'probe', arguments: '{}' }] },
      { textChunks: ['turn2 完成'] },
    ]);
    const tools = new ToolRegistry();
    tools.register(makeTool('gated', async () => { await gate; return { output: 'ok' }; }, { cancelGuaranteed: true }));
    tools.register(makeTool('probe', () => ({ output: 'ok' }), { cancelGuaranteed: true }));
    const hub = new SessionHub({ manager, provider, tools, cwd: root, decide: () => 'allow' });
    const steerResults: SteerResult[] = [];
    const turnIds: string[] = [];
    hub.addHooks({
      onEvent: (_sid, ev) => {
        if (ev.type === 'user/message' && ev.payload.turnId !== undefined) turnIds.push(ev.payload.turnId);
      },
      onSteerResult: (_sid, r) => steerResults.push(r),
    });
    const created = hub.create(root);

    // —— turn 1：提交 steer-A → 边界应用（accepted） ——
    hub.sendUserMessage(created.id, 'turn1 开始');
    await waitFor(() => turnIds.length === 1);
    const ack1 = hub.submitAck({
      clientMessageId: 'steer-A',
      sessionId: created.id,
      rawText: '转向方案 B',
      intent: 'steer',
      expectedTurnId: turnIds[0]!,
    });
    expect(ack1.state).toBe('accepted');
    openGate();
    await waitFor(() => steerResults.filter((r) => r.state === 'accepted').length === 1);

    // —— turn 2：同 id 再提交 → 会话级去重，立即 rejected（同 id 全局只一次） ——
    hub.sendUserMessage(created.id, 'turn2 开始');
    await waitFor(() => turnIds.length === 2);
    const ack2 = hub.submitAck({
      clientMessageId: 'steer-A',
      sessionId: created.id,
      rawText: '转向方案 B',
      intent: 'steer',
      expectedTurnId: turnIds[1]!,
    });
    expect(ack2.state).toBe('rejected');
    await waitFor(() => steerResults.length === 2);
    expect(steerResults.map((r) => r.state)).toEqual(['accepted', 'rejected']);

    // 功能性证据：steer 文本在所有请求中只注入一次（跨 turn 全局一次）
    await waitFor(() => provider.requests.length === 4);
    const applied = provider.requests.filter((r) =>
      r.messages.some((m) => m.role === 'user' && m.content === '转向方案 B'),
    );
    expect(applied).toHaveLength(1);
    await hub.close();
  });

  it('stale（expectedTurnId 与当前 turn 不符）经会话级 sink 仍拒且保 draft，不进投影', async () => {
    const root = tmpDir('h2-steer-stale-');
    const manager = new SessionManager(join(root, 'sessions'));
    let openGate!: () => void;
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    const provider = new MockProvider([
      { toolCalls: [{ id: 'g1', name: 'gated', arguments: '{}' }] },
      { textChunks: ['完成'] },
    ]);
    const tools = new ToolRegistry();
    tools.register(makeTool('gated', async () => { await gate; return { output: 'ok' }; }, { cancelGuaranteed: true }));
    const hub = new SessionHub({ manager, provider, tools, cwd: root, decide: () => 'allow' });
    const steerResults: SteerResult[] = [];
    const turnIds: string[] = [];
    hub.addHooks({
      onEvent: (_sid, ev) => {
        if (ev.type === 'user/message' && ev.payload.turnId !== undefined) turnIds.push(ev.payload.turnId);
      },
      onSteerResult: (_sid, r) => steerResults.push(r),
    });
    const created = hub.create(root);

    hub.sendUserMessage(created.id, '开始');
    await waitFor(() => turnIds.length === 1);
    // expectedTurnId 为不存在的 turn → 注册成功（接收语义），stale 判定在边界发生
    const ack = hub.submitAck({
      clientMessageId: 'st-stale',
      sessionId: created.id,
      rawText: '别按旧方向',
      intent: 'steer',
      expectedTurnId: 'some-other-turn',
    });
    expect(ack.state).toBe('accepted');
    openGate();
    await waitFor(() => steerResults.length === 1);
    expect(steerResults[0]).toEqual({ id: 'st-stale', expectedTurnId: 'some-other-turn', state: 'stale', draftKept: true });

    // 未注入：两个请求都没有 stale 文本（边界被拒，不叠加控制消息）
    await waitFor(() => provider.requests.length === 2);
    for (const req of provider.requests) {
      expect(req.messages.map((m) => m.content)).not.toContain('别按旧方向');
    }
    // 投影不变
    for (const e of loadEvents(created.dir)) {
      if (e.type === 'user/message') expect(e.payload.text).not.toContain('别按旧方向');
    }
    await hub.close();
  });

  it('缺 expectedTurnId 的 steer 提交被拒绝（S0 契约），不占 sink', async () => {
    const root = tmpDir('h2-steer-nobind-');
    const manager = new SessionManager(join(root, 'sessions'));
    const hub = new SessionHub({
      manager,
      provider: new MockProvider([{ textChunks: ['收工'] }]),
      tools: new ToolRegistry(),
      cwd: root,
      decide: () => 'allow',
    });
    const created = hub.create(root);
    const ack = hub.submitAck({
      clientMessageId: 'st-unbound',
      sessionId: created.id,
      rawText: 'x',
      intent: 'steer',
    });
    expect(ack.state).toBe('rejected');
    expect(ack.reason).toContain('expectedTurnId');
    expect(hub.steerHistory(created.id)).toEqual([]);
    await hub.close();
  });
});
