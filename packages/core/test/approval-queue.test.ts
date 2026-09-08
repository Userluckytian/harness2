// 审批队列测试（S2）：结构化审批队列 + ws/sessions/subagent 接线。
//   - 两并发卡不覆盖、各自独立 ack；
//   - child 审批在结束前对父可见（deliverTo 含父、pendingApprovalsFor(父) 含子卡）；
//   - respond 明确 ack（applied/duplicate/expired/unknown），迟到响应按已落定返回；
//   - scope 跨 session 拒（fail-closed）；「本会话总是」授权不泄漏到其他会话/工具；
//   - 过期卡 fail-closed（返回 expired，不执行）；
//   - 无 authorizer → ask 上抛、绝不静默 allow（放行前工具不执行）；
//   - WS 断线重连：订阅后 pending approvals 重发（含 scope/expiresAt 卡片字段）。
// TDD：本文件先红（approval-queue 模块不存在），再实现最小改动。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalQueue, type ApprovalQueueCard, type ApprovalSettleReason } from '../src/interaction/approval-queue.js';
import type { ApprovalRequestContract, ApprovalScope } from '../src/interaction/types.js';
import { SessionHub, type SessionHubHooks } from '../src/server/sessions.js';
import { SessionManager } from '../src/session/manager.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { MockProvider, type MockScript } from '../src/provider/mock.js';
import { startServe, type ServeHandle } from '../src/server/http.js';
import type { WsServerMessage } from '../src/server/ws.js';

const dirs: string[] = [];
const handles: ServeHandle[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const future = () => new Date(Date.now() + 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

function makeCard(over: {
  requestId: string;
  sessionId: string;
  tool: string;
  args?: unknown;
  scope?: ApprovalScope;
  expiresAt?: string;
  settle?: (allowed: boolean, reason: ApprovalSettleReason) => void;
}): ApprovalQueueCard {
  return {
    approval: {
      requestId: over.requestId,
      sessionId: over.sessionId,
      tool: over.tool,
      args: over.args ?? {},
      scope: over.scope ?? { mode: 'once' },
      expiresAt: over.expiresAt ?? future(),
    },
    settle: over.settle ?? (() => {}),
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 15): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function toolDef(name: string, log: string[]): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    execute: () => {
      log.push(name);
      return { output: `${name}-ok` };
    },
  };
}

describe('ApprovalQueue 单元：多并发卡 / ack / 过期 / scope / 授权缓存', () => {
  it('两并发审批不覆盖：各自独立 respond、各自 applied ack、逐个落定', () => {
    const queue = new ApprovalQueue();
    const settled: Array<[string, boolean, ApprovalSettleReason]> = [];
    queue.register({
      ...makeCard({ requestId: 'a1', sessionId: 'S', tool: 'write' }),
      settle: (allowed, reason) => settled.push(['a1', allowed, reason]),
    });
    queue.register({
      ...makeCard({ requestId: 'a2', sessionId: 'S', tool: 'bash' }),
      settle: (allowed, reason) => settled.push(['a2', allowed, reason]),
    });
    expect(queue.listPending()).toHaveLength(2);

    expect(queue.respond('a1', 'allow')).toEqual({ requestId: 'a1', state: 'applied' });
    // a2 未被 a1 的响应波及：仍待处理
    expect(queue.listPending()).toHaveLength(1);
    expect(queue.respond('a2', 'deny')).toEqual({ requestId: 'a2', state: 'applied' });
    expect(queue.listPending()).toHaveLength(0);
    expect(settled).toEqual([
      ['a1', true, 'response'],
      ['a2', false, 'response'],
    ]);
  });

  it('重复响应 → duplicate；未知 requestId → unknown；迟到已落定卡按状态返回', () => {
    const queue = new ApprovalQueue();
    queue.register(makeCard({ requestId: 'c1', sessionId: 'S', tool: 'write' }));
    expect(queue.respond('c1', 'allow')).toEqual({ requestId: 'c1', state: 'applied' });
    expect(queue.respond('c1', 'allow')).toEqual({ requestId: 'c1', state: 'duplicate' });
    expect(queue.respond('never-asked', 'allow')).toEqual({ requestId: 'never-asked', state: 'unknown' });

    // 超时落定后迟到响应 → expired（非 applied，绝不事后放行）
    const queue2 = new ApprovalQueue();
    queue2.register(makeCard({ requestId: 't1', sessionId: 'S', tool: 'bash' }));
    queue2.settle('t1', false, 'timeout');
    expect(queue2.respond('t1', 'allow')).toEqual({ requestId: 't1', state: 'expired' });
  });

  it('过期卡 fail-closed：respond 返回 expired、按拒绝落定、不产生授权', () => {
    const queue = new ApprovalQueue();
    const settled: Array<[boolean, ApprovalSettleReason]> = [];
    queue.register({
      ...makeCard({ requestId: 'e1', sessionId: 'S', tool: 'write', expiresAt: past() }),
      settle: (allowed, reason) => settled.push([allowed, reason]),
    });
    expect(queue.respond('e1', 'allow')).toEqual({ requestId: 'e1', state: 'expired' });
    expect(settled).toEqual([[false, 'expired']]);
    expect(queue.grantFor('S').size).toBe(0); // 过期放行不产生「本会话总是」授权
    expect(queue.listPending()).toHaveLength(0); // 失败卡不悬挂
  });

  it('scope 跨 session 拒：register 返回 false（fail-closed，不入待处理表）', () => {
    const queue = new ApprovalQueue();
    const ok = queue.register(
      makeCard({
        requestId: 'x1',
        sessionId: 'S',
        tool: 'write',
        scope: { mode: 'session', sessionId: 'ANOTHER-SESSION' },
      }),
    );
    expect(ok).toBe(false);
    expect(queue.listPending()).toHaveLength(0);
  });

  it('「本会话总是」授权：允许后同会话同工具自动放行；不泄漏到其他会话/工具', () => {
    const queue = new ApprovalQueue();
    queue.register(
      makeCard({
        requestId: 'g1',
        sessionId: 'S',
        tool: 'write',
        scope: { mode: 'session', sessionId: 'S' },
      }),
    );
    queue.respond('g1', 'allow');
    expect([...queue.grantFor('S')]).toEqual(['write']);
    expect(queue.grantFor('S').has('bash')).toBe(false); // 同会话其他工具无授权
    expect(queue.grantFor('OTHER').has('write')).toBe(false); // 跨会话不泄漏
  });
});

describe('SessionHub 接线：无授权不自动 allow / child 审批对父可见', () => {
  it('无 authorizer：ask 上抛待处理、放行前工具不执行；applied ack 后执行', async () => {
    const root = tmpDir('h2-queue-hub-');
    const manager = new SessionManager(join(root, 'sessions'));
    const toolLog: string[] = [];
    const tools = new ToolRegistry();
    tools.register(toolDef('probe_tool', toolLog));
    // 不注入 decide：authorizer 缺省 = ask（不得静默 allow）
    const hub = new SessionHub({
      manager,
      provider: new MockProvider([
        { toolCalls: [{ id: 'c1', name: 'probe_tool', arguments: '{}' }] },
        { textChunks: ['收尾'] },
      ]),
      tools,
      cwd: root,
      approvalTimeoutMs: 3000,
      hooks: {},
    });
    const asked: ApprovalRequestContract[] = [];
    const settled: Array<{ requestId: string; allowed: boolean; reason: string }> = [];
    hub.addHooks({
      onApprovalRequest: (a) => asked.push(a),
      onApprovalSettled: (requestId, allowed, reason) => settled.push({ requestId, allowed, reason }),
    } satisfies SessionHubHooks);
    const id = hub.create(root).id;
    hub.sendUserMessage(id, '触发审批');

    await waitFor(() => asked.length === 1);
    expect(hub.listPendingApprovals()).toHaveLength(1);
    // 未放行前工具绝不执行
    await waitFor(() => true);
    expect(toolLog).toHaveLength(0);

    const requestId = asked[0]!.requestId;
    expect(hub.respondApproval('no-such-request', 'allow')).toEqual({ requestId: 'no-such-request', state: 'unknown' });
    expect(hub.respondApproval(requestId, 'allow')).toEqual({ requestId, state: 'applied' });
    await waitFor(() => toolLog.length === 1);
    expect(hub.respondApproval(requestId, 'allow')).toEqual({ requestId, state: 'duplicate' });
    await waitFor(() => settled.length === 1);
    expect(settled[0]).toMatchObject({ requestId, allowed: true, reason: 'response' });
    await hub.close();
  });

  it('child 审批在结束前对父可见：deliverTo 含父会话、pendingApprovalsFor(父) 含子卡、allow 后子工具执行', async () => {
    const root = tmpDir('h2-queue-child-');
    const manager = new SessionManager(join(root, 'sessions'));
    const childLog: string[] = [];
    const tools = new ToolRegistry();
    tools.register(toolDef('child_probe', childLog));
    const hub = new SessionHub({
      manager,
      provider: new MockProvider([
        { toolCalls: [{ id: 'c1', name: 'subagent_start', arguments: '{"prompt":"child work"}' }] },
        { textChunks: ['parent wrapped'] },
      ]),
      tools,
      cwd: root,
      subagent: {
        provider: new MockProvider([
          { toolCalls: [{ id: 'cc1', name: 'child_probe', arguments: '{}' }] },
          { textChunks: ['child done'] },
        ]),
        maxDepth: 1,
        maxTurns: 5,
      },
      decide: () => 'ask',
      approvalTimeoutMs: 3000,
      hooks: {},
    });
    const deliveries: Array<{ card: ApprovalRequestContract; to: string[] }> = [];
    hub.addHooks({ onApprovalRequest: (a, to) => deliveries.push({ card: a, to }) });
    const parentId = hub.create(root).id;
    hub.sendUserMessage(parentId, 'go');

    // 父 turn 的 subagent_start 自身也要审批（decide=ask）：先放行父卡，子会话才被派发
    await waitFor(() => deliveries.length >= 1);
    const parentCard = deliveries[0]!;
    expect(parentCard.card.tool).toBe('subagent_start');
    expect(hub.respondApproval(parentCard.card.requestId, 'allow')).toEqual({
      requestId: parentCard.card.requestId,
      state: 'applied',
    });

    // 子会话 ask：卡归属子会话；父在送达链上（child 结束前可见）
    await waitFor(() => deliveries.some((d) => d.card.sessionId !== parentId));
    const d = deliveries.find((x) => x.card.sessionId !== parentId)!;
    expect(d.card.tool).toBe('child_probe');
    expect(d.to).toContain(parentId);
    // 重连/订阅视角：父会话能看到后代（child）的待审批卡
    expect(hub.pendingApprovalsFor(parentId).some((a) => a.requestId === d.card.requestId)).toBe(true);
    // 放行 → 子工具真实执行
    expect(hub.respondApproval(d.card.requestId, 'allow')).toEqual({ requestId: d.card.requestId, state: 'applied' });
    await waitFor(() => childLog.length > 0);
    expect(childLog).toEqual(['child_probe']);
    await hub.close();
  });
});

describe('WS 接线：断线重连补发 pending approvals', () => {
  async function createSession(handle: ServeHandle): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: tmpDir('h2-queue-cwd-') }),
    });
    return ((await res.json()) as { id: string }).id;
  }

  it('订阅（重连）即补发该 session 的 pending approval（含 scope/expiresAt）；respond allow 后工具执行', async () => {
    const handle = await startServe({
      port: 0,
      home: tmpDir('h2-queue-home-'),
      root: tmpDir('h2-queue-root-'),
      provider: new MockProvider([
        { toolCalls: [{ id: 'c1', name: 'glob', arguments: JSON.stringify({ pattern: '*' }) }] },
        { textChunks: ['执行完'] },
      ]),
      decide: () => 'ask',
    });
    handles.push(handle);
    const id = await createSession(handle);

    // 直接经 hub 起 turn（无需先建订阅）：让审批进入待处理表
    let asked: ApprovalRequestContract | null = null;
    handle.hub.addHooks({ onApprovalRequest: (a) => (asked = a) } satisfies SessionHubHooks);
    handle.hub.sendUserMessage(id, '触发审批');
    await waitFor(() => asked !== null && handle.hub.listPendingApprovals().length === 1);

    const client = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
    await client.open;
    client.send({ op: 'subscribe', sessionId: id });
    const frame = await client.waitFor((f) => f.type === 'approval-request', '订阅后补发 approval-request');
    expect(frame.type === 'approval-request' && frame.requestId).toBe(asked!.requestId);
    if (frame.type === 'approval-request') {
      expect(frame.scope).toEqual({ mode: 'once' });
      expect(typeof frame.expiresAt).toBe('string');
    }

    client.send({ op: 'approval-response', requestId: asked!.requestId, decision: 'allow' });
    const result = await client.waitFor(
      (f) => f.type === 'event' && f.event.type === 'tool/result',
      'tool/result 镜像',
    );
    expect(result.type === 'event' && result.event.type === 'tool/result' && result.event.payload.ok).toBe(true);
    await client.waitFor((f) => f.type === 'turn-end', 'turn-end');
    client.close();
  });
});

// —— 轻量 WS 测试客户端（与 ws.test.ts 同款收集/等待语义） ——

class WsClient {
  readonly frames: Array<Record<string, unknown>> = [];
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
      this.frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
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
  async waitFor(pred: (f: WsServerMessage, index: number) => boolean, description: string): Promise<WsServerMessage> {
    for (let i = 0; i < 500; i++) {
      const idx = this.frames.findIndex((f) => pred(f as WsServerMessage, this.frames.indexOf(f)));
      if (idx >= 0) return this.frames[idx] as WsServerMessage;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 10);
      });
    }
    throw new Error(`等待帧超时: ${description}（已收到 ${this.frames.length} 帧）`);
  }
}