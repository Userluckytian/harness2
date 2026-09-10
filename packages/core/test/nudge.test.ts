// nudge 后台复盘 + pending 审批测试（阶段 6 Task 4）。
// 覆盖：PendingMemoryStore stage/list/approve(重放)/reject、ask 模式暂存工具、
// hub 计数/重置/触发、mock small 复盘写记忆、复盘异常不影响主对话、off 零触发。
// 全部使用临时目录（记忆内容不入 git）。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHub } from '../src/server/sessions.js';
import { SessionManager } from '../src/session/manager.js';
import { MockProvider, type MockScript } from '../src/provider/mock.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/predefined/index.js';
import { MemoryStore, assembleMemorySnapshot } from '../src/memory/store.js';
import { PendingMemoryStore } from '../src/memory/pending.js';
import {
  buildConversationDigest,
  createMemoryToolForMode,
  NUDGE_REVIEW_SYSTEM,
  runNudgeReview,
} from '../src/memory/nudge.js';
import { SessionWriter } from '../src/session/writer.js';
import { defaultSessionsRoot } from '../src/session/manager.js';
import type { ApprovalDecision, ApprovalInput } from '../src/tools/types.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-nudge-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface HubFixture {
  hub: SessionHub;
  root: string;
  sessionId: string;
  /** 等待第 n 次 nudge-finished（去重后按序 resolve） */
  nextNudgeFinished(): Promise<{ staged: number; error?: string }>;
}

function makeHub(opts: {
  main: MockScript;
  review?: MockScript;
  mode?: 'ask' | 'auto';
  nudgeInterval?: number;
  decide?: (input: ApprovalInput) => ApprovalDecision;
}): HubFixture {
  const root = tmpDir();
  const manager = new SessionManager(defaultSessionsRoot(root));
  const store = new MemoryStore(join(root, 'memories'));
  const pending = new PendingMemoryStore(join(root, 'memories', 'pending'), store);
  const hub = new SessionHub({
    manager,
    provider: new MockProvider(opts.main),
    tools: (() => {
      const r = new ToolRegistry();
      registerBuiltinTools(r);
      return r;
    })(),
    cwd: root,
    ...(opts.decide !== undefined ? { decide: opts.decide } : {}),
    ...(opts.review !== undefined || opts.mode !== undefined
      ? {
          memory: {
            store,
            mode: opts.mode ?? 'auto',
            nudgeInterval: opts.nudgeInterval ?? 2,
            reviewProvider: new MockProvider(opts.review ?? [{ text: '无需记忆' }]),
            pending,
          },
        }
      : {}),
  });
  const { id } = hub.create(root);
  const finished: Array<{ staged: number; error?: string }> = [];
  const waiters: Array<(v: { staged: number; error?: string }) => void> = [];
  hub.addHooks({
    onNudgeFinished: (_sessionId, result) => {
      const payload = { staged: result.staged, ...(result.error !== undefined ? { error: result.error } : {}) };
      const w = waiters.shift();
      if (w) w(payload);
      else finished.push(payload);
    },
  });
  return {
    hub,
    root,
    sessionId: id,
    nextNudgeFinished() {
      const queued = finished.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

describe('PendingMemoryStore', () => {
  it('stage → list（升序）→ approve 重放落盘 → 文件删除', async () => {
    const root = tmpDir();
    const store = new MemoryStore(join(root, 'memories'));
    const pending = new PendingMemoryStore(join(root, 'pending'), store);
    const a = await pending.stage('sess-1', [{ operation: 'add', target: 'user', text: '用户偏好深色主题' }]);
    const b = await pending.stage('sess-2', [{ operation: 'add', target: 'memory', text: '项目约定：pnpm' }]);
    expect(b.id).not.toBe(a.id);

    const list = await pending.list();
    expect(list.map((p) => p.id)).toEqual([a.id, b.id]); // createdAt 升序

    const r = await pending.approve(a.id);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(root, 'memories', 'USER.md'), 'utf8')).toBe('用户偏好深色主题');
    expect(await pending.get(a.id)).toBeNull(); // 成功后删除

    const r2 = await pending.approve(b.id);
    expect(r2.ok).toBe(true);
    expect(readFileSync(join(root, 'memories', 'MEMORY.md'), 'utf8')).toBe('项目约定：pnpm');
    expect(await pending.list()).toEqual([]);
  });

  it('approve 重放失败（预算超限）→ 暂存保留（只延迟不丢弃）+ 错误信息', async () => {
    const root = tmpDir();
    const store = new MemoryStore(join(root, 'memories'));
    const pending = new PendingMemoryStore(join(root, 'pending'), store);
    // 先把 USER.md 填到接近预算
    await store.apply([{ operation: 'add', target: 'user', text: 'x'.repeat(1370) }]);
    const p = await pending.stage('sess-1', [{ operation: 'add', target: 'user', text: 'y'.repeat(100) }]);
    const r = await pending.approve(p.id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/超出预算/);
    expect(await pending.get(p.id)).not.toBeNull(); // 保留
  });

  it('reject 删除暂存；approve/reject 未知 id 报告失败；stage 形状校验拒绝', async () => {
    const root = tmpDir();
    const store = new MemoryStore(join(root, 'memories'));
    const pending = new PendingMemoryStore(join(root, 'pending'), store);
    const p = await pending.stage('sess-1', [{ operation: 'add', target: 'user', text: '事实' }]);
    expect(await pending.reject(p.id)).toBe(true);
    expect(await pending.get(p.id)).toBeNull();
    expect(await pending.reject(p.id)).toBe(false);
    expect((await pending.approve('nope')).ok).toBe(false);
    await expect(pending.stage('sess-1', [{ operation: 'add', target: 'nope' as 'user', text: 'x' }])).rejects.toThrow(
      /target 必须是/,
    );
    await expect(pending.stage('sess-1', [])).rejects.toThrow(/不能为空/);
  });

  it('暂存上限 200（审查 P2-3）：第 201 条拒绝并提示先处理；清理后可继续写', async () => {
    const root = tmpDir();
    const store = new MemoryStore(join(root, 'memories'));
    const pending = new PendingMemoryStore(join(root, 'pending'), store);
    for (let i = 0; i < 200; i++) {
      await pending.stage('sess-limit', [{ operation: 'add', target: 'user', text: `条目 ${i}` }]);
    }
    expect(await pending.list()).toHaveLength(200);
    await expect(
      pending.stage('sess-limit', [{ operation: 'add', target: 'user', text: '超出上限的一条' }]),
    ).rejects.toThrow(/上限 200/);
    // 显式清空后可继续写（clearAll 返回清除条数）
    expect(await pending.clearAll()).toBe(200);
    const again = await pending.stage('sess-limit', [{ operation: 'add', target: 'user', text: '清理后可写' }]);
    expect(again.id).toBeTruthy();
    expect(await pending.list()).toHaveLength(1);
  });
});

describe('createMemoryToolForMode', () => {
  it('ask 模式：工具执行 → 暂存 pending（工具名保持 memory，结果带 staged id）', async () => {
    const root = tmpDir();
    const store = new MemoryStore(join(root, 'memories'));
    const pending = new PendingMemoryStore(join(root, 'pending'), store);
    const tool = createMemoryToolForMode(store, 'ask', pending, 'sess-9');
    expect(tool.name).toBe('memory');
    const out = await tool.execute(
      { operation: 'add', target: 'user', text: 'ask 模式记忆' },
      { signal: new AbortController().signal, cwd: root },
    );
    expect(out.error).toBeUndefined();
    expect(out.output).toMatch(/staged as \S+/);
    // 未直接落盘
    expect(existsSync(join(root, 'memories', 'USER.md'))).toBe(false);
    const items = await pending.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sessionId: 'sess-9' });
  });

  it('auto 模式：工具执行直接落盘', async () => {
    const root = tmpDir();
    const store = new MemoryStore(join(root, 'memories'));
    const tool = createMemoryToolForMode(store, 'auto', undefined, 'sess-1');
    const out = await tool.execute(
      { operation: 'add', target: 'memory', text: 'auto 直接写' },
      { signal: new AbortController().signal, cwd: root },
    );
    expect(out.output).toMatch(/MEMORY\.md: 1 entries/);
    expect(readFileSync(join(root, 'memories', 'MEMORY.md'), 'utf8')).toBe('auto 直接写');
  });
});

describe('buildConversationDigest', () => {
  it('从主会话活动投影构建摘要；空会话给占位', async () => {
    const root = tmpDir();
    const hub = new SessionHub({
      manager: new SessionManager(defaultSessionsRoot(root)),
      provider: new MockProvider([{ text: '回复 A' }]),
      tools: new ToolRegistry(),
      cwd: root,
    });
    const { id } = hub.create(root);
    hub.sendUserMessage(id, '第一句话');
    await sleep(50);
    // 等待 turn 结束
    while (hub.isBusy(id)) await sleep(20);
    const dir = hub.locate(id);
    const digest = buildConversationDigest(dir);
    expect(digest).toContain('USER: 第一句话');
    expect(digest).toContain('ASSISTANT: 回复 A');

    // 空会话占位
    const { id: id2 } = hub.create(root);
    expect(buildConversationDigest(hub.locate(id2))).toBe('（对话为空）');
    await hub.close();
  });
});

describe('SessionHub nudge 计数与触发', () => {
  it('计数到 nudgeInterval 触发复盘：mock small 调 memory 工具直接写盘（auto），触发后归零', async () => {
    const fx = makeHub({
      main: [{ text: '回复 1' }, { text: '回复 2' }, { text: '回复 3' }],
      review: [
        {
          toolCalls: [
            {
              id: 'r1',
              name: 'memory',
              arguments: JSON.stringify({ operation: 'add', target: 'user', text: '复盘发现的偏好' }),
            },
          ],
        },
        { text: '无需记忆' },
      ],
      nudgeInterval: 2,
    });
    const finished = fx.nextNudgeFinished();
    fx.hub.sendUserMessage(fx.sessionId, '第一句');
    while (fx.hub.isBusy(fx.sessionId)) await sleep(20);
    expect(fx.hub.nudgeCount(fx.sessionId)).toBe(1); // 第一轮只计数
    fx.hub.sendUserMessage(fx.sessionId, '第二句');
    while (fx.hub.isBusy(fx.sessionId)) await sleep(20);
    expect(fx.hub.nudgeCount(fx.sessionId)).toBe(0); // 触发后归零
    await finished;
    expect(readFileSync(join(fx.root, 'memories', 'USER.md'), 'utf8')).toBe('复盘发现的偏好');
    // 复盘在独立临时会话运行：主日志绝不出现复盘系统提示（NUDGE_REVIEW_SYSTEM）
    let log = readFileSync(join(fx.hub.locate(fx.sessionId), 'session.v1.jsonl'), 'utf8');
    expect(log).not.toContain(NUDGE_REVIEW_SYSTEM);
    // 复盘写盘后主会话下一轮注入快照（审查 P1-1：serve 路径记忆不只写不读）
    fx.hub.sendUserMessage(fx.sessionId, '第三句');
    while (fx.hub.isBusy(fx.sessionId)) await sleep(20);
    log = readFileSync(join(fx.hub.locate(fx.sessionId), 'session.v1.jsonl'), 'utf8');
    const snapLine = log.split('\n').find((l) => l.includes('memory/snapshot'));
    expect(snapLine).toBeTruthy();
    expect(snapLine).toContain('复盘发现的偏好');
    await fx.hub.close();
  });

  it('模型 turn 内调过 memory 工具 → 计数归零（复盘不触发）', async () => {
    const fx = makeHub({
      main: [
        {
          toolCalls: [
            {
              id: 'm1',
              name: 'memory',
              arguments: JSON.stringify({ operation: 'add', target: 'user', text: '主对话直接记忆' }),
            },
          ],
        },
        { text: '记好了' },
        { text: '回复 2' },
      ],
      review: [{ text: '无需记忆' }],
      nudgeInterval: 2,
      decide: () => 'allow',
    });
    fx.hub.sendUserMessage(fx.sessionId, '第一句');
    while (fx.hub.isBusy(fx.sessionId)) await sleep(20);
    expect(fx.hub.nudgeCount(fx.sessionId)).toBe(0); // 调过 memory 工具 → 归零
    fx.hub.sendUserMessage(fx.sessionId, '第二句');
    while (fx.hub.isBusy(fx.sessionId)) await sleep(20);
    expect(fx.hub.nudgeCount(fx.sessionId)).toBe(1); // 只累计到 1，未触发
    expect(readFileSync(join(fx.root, 'memories', 'USER.md'), 'utf8')).toBe('主对话直接记忆');
    await fx.hub.close();
  });

  it('ask 模式：复盘写入进 pending（来源会话归因），主对话零阻塞继续收消息', async () => {
    const fx = makeHub({
      main: [{ text: '回复 1' }, { text: '回复 2' }],
      // nudgeInterval=1：两条消息各触发一次复盘，共享 reviewProvider——脚本给足 4 条
      //（每复盘最多 2 次请求），无论交错顺序两复盘都能正常收尾
      review: [
        {
          toolCalls: [
            {
              id: 'r1',
              name: 'memory',
              arguments: JSON.stringify({ operation: 'add', target: 'user', text: 'ask 暂存偏好' }),
            },
          ],
        },
        { text: '无需记忆' },
        { text: '无需记忆' },
        { text: '无需记忆' },
      ],
      mode: 'ask',
      nudgeInterval: 1,
    });
    const finished1 = fx.nextNudgeFinished();
    const finished2 = fx.nextNudgeFinished();
    fx.hub.sendUserMessage(fx.sessionId, '第一句');
    // 复盘慢（不阻塞）：立即发第二条消息，主对话照常进行
    fx.hub.sendUserMessage(fx.sessionId, '第二句');
    while (fx.hub.isBusy(fx.sessionId)) await sleep(20);
    // 两次复盘都无错误；staged 聚合 = 1（审查 P2-2 口径：只统计各自本次新增）
    const results = await Promise.all([finished1, finished2]);
    expect(results.map((r) => r.error)).toEqual([undefined, undefined]);
    expect(results.reduce((sum, r) => sum + r.staged, 0)).toBe(1);
    // 主对话两个 turn 都已完成且未写入记忆文件（ask = 只延迟）
    expect(existsSync(join(fx.root, 'memories', 'USER.md'))).toBe(false);
    const pending = new PendingMemoryStore(join(fx.root, 'memories', 'pending'));
    const items = await pending.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sessionId: fx.sessionId });
    // approve 重放后落盘（approve 需绑定与 hub 相同根的 store）
    const pendingForApprove = new PendingMemoryStore(
      join(fx.root, 'memories', 'pending'),
      new MemoryStore(join(fx.root, 'memories')),
    );
    const r = await pendingForApprove.approve(items[0]!.id);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(fx.root, 'memories', 'USER.md'), 'utf8')).toBe('ask 暂存偏好');
    await fx.hub.close();
  });

  it('staged 只统计本次复盘新增（审查 P2-2）：此前遗留的同会话暂存不计入', async () => {
    const fx = makeHub({
      main: [{ text: '回复 1' }],
      review: [
        {
          toolCalls: [
            {
              id: 'r1',
              name: 'memory',
              arguments: JSON.stringify({ operation: 'add', target: 'user', text: '本次复盘新增的暂存' }),
            },
          ],
        },
        { text: '无需记忆' },
      ],
      mode: 'ask',
      nudgeInterval: 1,
    });
    // 预置一条同 sessionId 的遗留暂存（旧实现会把全部未审批项计入 staged → 2）
    const legacy = new PendingMemoryStore(join(fx.root, 'memories', 'pending'));
    await legacy.stage(fx.sessionId, [{ operation: 'add', target: 'user', text: '此前遗留的暂存' }]);
    const finished = fx.nextNudgeFinished();
    fx.hub.sendUserMessage(fx.sessionId, '第一句');
    while (fx.hub.isBusy(fx.sessionId)) await sleep(20);
    const { staged, error } = await finished;
    expect(error).toBeUndefined();
    expect(staged).toBe(1); // 只算本次复盘新增
    expect(await legacy.list()).toHaveLength(2); // 遗留项仍在，等人工审批
    await fx.hub.close();
  });

  it('复盘 provider 失败 → nudge-finished 带 error，主对话无感继续', async () => {
    const fx = makeHub({
      main: [{ text: '回复 1' }],
      review: [{ error: '复盘模型不可用' }],
      nudgeInterval: 1,
    });
    const finished = fx.nextNudgeFinished();
    fx.hub.sendUserMessage(fx.sessionId, '第一句');
    while (fx.hub.isBusy(fx.sessionId)) await sleep(20);
    const { error } = await finished;
    expect(error).toMatch(/复盘模型不可用/);
    // 主对话日志完整（turn 正常结束）
    const log = readFileSync(join(fx.hub.locate(fx.sessionId), 'session.v1.jsonl'), 'utf8');
    expect(log).toContain('assistant/message');
    await fx.hub.close();
  });

  it('off（无 memory 装配）：永不触发复盘，memory 工具未注册（模型看不到）', async () => {
    const fx = makeHub({ main: [{ text: '回复 1' }, { text: '回复 2' }] });
    fx.hub.sendUserMessage(fx.sessionId, '第一句');
    while (fx.hub.isBusy(fx.sessionId)) await sleep(20);
    fx.hub.sendUserMessage(fx.sessionId, '第二句');
    while (fx.hub.isBusy(fx.sessionId)) await sleep(20);
    await sleep(80); // 给可能存在（不应存在）的复盘留时间
    expect(fx.hub.nudgeCount(fx.sessionId)).toBe(0);
    expect(existsSync(join(fx.root, 'memories'))).toBe(false);
    await fx.hub.close();
  });
});

describe('复盘临时会话与系统提示', () => {
  it('NUDGE_REVIEW_SYSTEM 非空且经 assembleMemorySnapshot 冻结（复盘会话 system 有独立提示）', () => {
    expect(NUDGE_REVIEW_SYSTEM).toMatch(/memory 工具/);
    expect(NUDGE_REVIEW_SYSTEM.length).toBeGreaterThan(20);
  });

  it('复盘请求 system === 预置的 NUDGE_REVIEW_SYSTEM 快照（审查 P1-2 防回归：缺注入则恒空）', async () => {
    const root = tmpDir();
    // 主会话：一轮对话（digest 有内容可回顾）
    const mainDir = join(root, 'main');
    const w = SessionWriter.create(mainDir, { sessionId: 'main' }, { fsync: false });
    w.append('user/message', { text: '我偏好深色主题', turnId: 't1' });
    w.append('assistant/message', { text: '好的', turnId: 't1' });
    w.close();

    const reviewProvider = new MockProvider([{ text: '无需记忆' }]);
    const result = await runNudgeReview({
      provider: reviewProvider,
      store: new MemoryStore(join(root, 'memories')),
      mode: 'auto',
      sessionId: 'main',
      sessionDir: mainDir,
      cwd: root,
    });
    expect(result.error).toBeUndefined();
    expect(reviewProvider.requests).toHaveLength(1);
    // 预置快照被 runTurn 复用为 system（memory: options.store 注入缝生效）
    expect(reviewProvider.requests[0]!.system).toBe(assembleMemorySnapshot(NUDGE_REVIEW_SYSTEM, ''));
    expect(reviewProvider.requests[0]!.system).toContain(NUDGE_REVIEW_SYSTEM);
  });
});

describe('SessionHub 装配校验（审查 P2-1）', () => {
  it('ask 模式缺 pending 装配：构造即抛错（fail-fast），装配齐全不抛', () => {
    const root = tmpDir();
    const manager = new SessionManager(defaultSessionsRoot(root));
    const store = new MemoryStore(join(root, 'memories'));
    const build = (memory: Record<string, unknown>) =>
      new SessionHub({
        manager,
        provider: new MockProvider([{ text: 'x' }]),
        tools: new ToolRegistry(),
        cwd: root,
        memory: memory as never,
      });
    // 残缺装配：此前每次 turn 抛错被 pump 吞掉（消息凭空消失）——现在构造期即拒绝
    expect(
      () => build({ store, mode: 'ask', nudgeInterval: 2 }), // pending 缺失
    ).toThrow(/pending/);
    // 齐全装配：正常构造
    const hub = build({
      store,
      mode: 'ask',
      nudgeInterval: 2,
      pending: new PendingMemoryStore(join(root, 'memories', 'pending'), store),
    });
    expect(hub.approvalTimeoutMs).toBe(120_000);
    void hub.close();
  });
});
