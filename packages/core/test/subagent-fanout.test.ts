// H-42 并行扇出测试（P7-C）。
//
// 覆盖：
//   ① 一次派多个子代理并行执行（用屏障证明**真的并发**，不是顺序跑）；
//   ② 并发隔离：每个子会话独立上下文/轨迹，互不污染；父会话只有 fanout 一行 tool/call+result，
//      子代理中间消息不进父日志、不进父的模型上下文；
//   ③ 失败隔离：单个子失败不影响其它子与父 turn；
//   ④ spawnHistoryStore：最近 10 次 FIFO 上限、顺序、可重放（/replay 渲染）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChatMessages, runTurn } from '../src/agent/loop.js';
import { buildSubagentChildTools } from '../src/agent/subagent.js';
import {
  FANOUT_MAX_CHILDREN,
  FANOUT_TOOL_NAME,
  SPAWN_HISTORY_LIMIT,
  SpawnHistoryStore,
  createFanoutTools,
  formatSpawnReplay,
  type FanoutOptions,
  type SpawnRecord,
} from '../src/agent/subagent-fanout.js';
import { MockProvider, type MockScript } from '../src/provider/mock.js';
import { SessionManager } from '../src/session/manager.js';
import { loadSession } from '../src/session/reader.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-fanout-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CALL_CTX = { signal: new AbortController().signal, cwd: '.' };

/** 屏障：n 个并发者全部进入后才放行；peak = 实测并发峰值 */
function makeBarrier(n: number) {
  let entered = 0;
  let peak = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async enter(): Promise<void> {
      entered += 1;
      peak = Math.max(peak, entered);
      if (entered >= n) release();
      await gate;
      entered -= 1;
    },
    peak: (): number => peak,
  };
}

/** 会卡在屏障上的探测工具（并发证明用） */
function barrierTool(barrier: { enter(): Promise<void> }, resultMarker: string): ToolDefinition {
  return {
    name: 'probe',
    description: '并发探测',
    parameters: { type: 'object', properties: {} },
    concurrencySafe: true,
    async execute() {
      await barrier.enter();
      return { output: resultMarker };
    },
  };
}

interface FanoutHarness {
  root: string;
  manager: SessionManager;
  parentId: string;
  parentWriter: ReturnType<SessionManager['create']>['writer'];
  parentProvider: MockProvider;
  childProviders: readonly MockProvider[];
  registry: ToolRegistry;
  history: SpawnHistoryStore;
  childEvents: Array<{ sessionId: string; type: string }>;
}

function makeFanoutHarness(opts: {
  parentScript: MockScript;
  childProviders: readonly MockProvider[];
  extraTools?: readonly ToolDefinition[];
  maxTurns?: number;
}): FanoutHarness {
  const root = tmpDir();
  const manager = new SessionManager(join(root, 'sessions'));
  const parentProvider = new MockProvider(opts.parentScript);
  const registry = new ToolRegistry();
  for (const def of opts.extraTools ?? []) registry.register(def);
  const parent = manager.create(root, { fsync: false });
  const history = new SpawnHistoryStore();
  const childEvents: Array<{ sessionId: string; type: string }> = [];
  const options: FanoutOptions = {
    manager,
    provider: opts.childProviders[0] ?? new MockProvider([]),
    baseTools: registry,
    cwd: root,
    maxDepth: 1,
    maxTurns: opts.maxTurns ?? 10,
    parentSessionId: parent.id,
    depth: 0,
    history,
    providerFor: (i) => opts.childProviders[i] ?? opts.childProviders[0]!,
    hooks: { onChildEvent: (sessionId, event) => childEvents.push({ sessionId, type: event.type }) },
    fsync: false,
  };
  for (const def of createFanoutTools(options)) registry.register(def);
  return {
    root,
    manager,
    parentId: parent.id,
    parentWriter: parent.writer,
    parentProvider,
    childProviders: opts.childProviders,
    registry,
    history,
    childEvents,
  };
}

/** 找 parentId 的直接子会话目录（创建顺序） */
function childDirs(manager: SessionManager, parentId: string): string[] {
  return manager
    .list()
    .filter((s) => loadSession(s.dir).header?.parentSession === parentId)
    .map((s) => s.dir);
}

describe('H-42 并行扇出：真的并发 + 隔离', () => {
  it('一次派 2 个：屏障证明并发（峰值 2）；各自独立结果；父日志/父上下文无子代理中间消息', async () => {
    const barrier = makeBarrier(2);
    const h = makeFanoutHarness({
      parentScript: [
        {
          toolCalls: [
            { id: 'f1', name: FANOUT_TOOL_NAME, arguments: JSON.stringify({ prompts: ['任务甲', '任务乙'] }) },
          ],
        },
        { text: '父收尾' },
      ],
      extraTools: [barrierTool(barrier, 'CHILD-tool-result')],
      childProviders: [
        new MockProvider([
          { text: 'CHILD-0-INTERMEDIATE', toolCalls: [{ id: 'c1', name: 'probe', arguments: '{}' }] },
          { text: '甲完成' },
        ]),
        new MockProvider([
          { text: 'CHILD-1-INTERMEDIATE', toolCalls: [{ id: 'c2', name: 'probe', arguments: '{}' }] },
          { text: '乙完成' },
        ]),
      ],
    });
    const result = await runTurn(h.parentWriter, {
      provider: h.parentProvider,
      tools: h.registry,
      cwd: h.root,
      userText: '扇出两个子任务',
      maxSteps: 6,
    });
    h.parentWriter.close();

    // 真并发：两个子会话的 probe 同时在屏障内 → 峰值 2（顺序执行只可能 1）
    expect(barrier.peak()).toBe(2);
    expect(result.stopReason).toBe('end_turn');
    expect(result.finalText).toBe('父收尾');

    // 父日志：只有 fanout 一行 tool/call + 一行 tool/result
    const parentLog = loadSession(h.parentWriter.dir);
    const calls = parentLog.events.filter((e) => e.event.type === 'tool/call');
    const results = parentLog.events.filter((e) => e.event.type === 'tool/result');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.event.payload).toMatchObject({ tool: FANOUT_TOOL_NAME });
    expect(results).toHaveLength(1);
    const out = JSON.parse((results[0]!.event.payload as { output: string }).output) as SpawnRecord;
    expect(out.children.map((c) => c.index)).toEqual([0, 1]);
    expect(out.children.every((c) => c.ok)).toBe(true);
    expect(out.children.map((c) => c.finalText)).toEqual(['甲完成', '乙完成']);

    // 父日志与父模型上下文都不含子代理中间消息（文本/工具结果）
    const parentDump = JSON.stringify(parentLog.events);
    const parentMessages = JSON.stringify(buildChatMessages(loadSession(h.parentWriter.dir)));
    for (const marker of ['CHILD-0-INTERMEDIATE', 'CHILD-1-INTERMEDIATE', 'CHILD-tool-result']) {
      expect(parentDump).not.toContain(marker);
      expect(parentMessages).not.toContain(marker);
    }
    // 父上下文只看到 fanout 汇总（最终交付）
    expect(parentMessages).toContain('甲完成');
    expect(parentMessages).toContain('乙完成');
    expect(buildChatMessages(loadSession(h.parentWriter.dir)).filter((m) => m.role === 'tool')).toHaveLength(1);

    // 每个子会话：自己的 prompt、自己的轨迹；互不污染（按 prompt 定位，不依赖 manager.list 顺序）
    const childDirList = childDirs(h.manager, h.parentId);
    expect(childDirList).toHaveLength(2);
    const childSessions = childDirList.map((dir) => {
      const events = loadSession(dir).events;
      const user = events.filter((e) => e.event.type === 'user/message');
      expect(user).toHaveLength(1);
      return {
        prompt: (user[0]!.event.payload as { text: string }).text,
        dump: JSON.stringify(events),
      };
    });
    expect(childSessions.map((c) => c.prompt).sort()).toEqual(['任务乙', '任务甲'].sort());
    const byPrompt = new Map(childSessions.map((c) => [c.prompt, c]));
    for (const c of childSessions) {
      expect(c.dump.includes('CHILD-tool-result')).toBe(true); // 中间工具结果只在各自子会话里
    }
    expect(byPrompt.get('任务甲')?.dump.includes('乙完成')).toBe(false); // 交叉污染检查
    expect(byPrompt.get('任务乙')?.dump.includes('甲完成')).toBe(false);

    // 子会话事件按自己的 sessionId 流出，父 id 从未出现
    for (const e of h.childEvents) expect(e.sessionId).not.toBe(h.parentId);
    expect(h.childEvents.length).toBeGreaterThan(0);

    // 子会话请求工具集不含 subagent 工具（扇出不可递归）
    for (const provider of h.childProviders) {
      const names = (provider.requests[0]?.tools ?? []).map((t) => t.name);
      expect(names).not.toContain(FANOUT_TOOL_NAME);
      expect(names).not.toContain('subagent_start');
      expect(names).toContain('probe');
    }
  });

  it('子会话工具集（装配层依据）：不含 subagent_fanout / subagent_start，宿主普通工具保留', () => {
    const h = makeFanoutHarness({
      parentScript: [{ text: 'unused' }],
      extraTools: [barrierTool(makeBarrier(1), 'ok')],
      childProviders: [new MockProvider([{ text: 'x' }])],
    });
    const childTools = buildSubagentChildTools(
      {
        manager: h.manager,
        provider: h.childProviders[0]!,
        baseTools: h.registry,
        cwd: h.root,
        maxDepth: 1,
        maxTurns: 5,
        parentSessionId: h.parentId,
        depth: 0,
      },
      'child-x',
    );
    const names = childTools.list().map((d) => d.name);
    expect(names).not.toContain(FANOUT_TOOL_NAME);
    expect(names).not.toContain('subagent_start');
    expect(names).toContain('probe');
    h.parentWriter.close();
  });

  it('失败隔离：一个子 provider 报错，另一个正常；父 turn 仍 end_turn，结果按 index 汇总', async () => {
    const h = makeFanoutHarness({
      parentScript: [
        {
          toolCalls: [
            { id: 'f1', name: FANOUT_TOOL_NAME, arguments: JSON.stringify({ prompts: ['会失败', '会成功'] }) },
          ],
        },
        { text: '父收尾' },
      ],
      childProviders: [
        new MockProvider([{ error: 'child provider exploded' }]),
        new MockProvider([{ text: '成功子结果' }]),
      ],
    });
    const result = await runTurn(h.parentWriter, {
      provider: h.parentProvider,
      tools: h.registry,
      cwd: h.root,
      userText: 'go',
      maxSteps: 4,
    });
    h.parentWriter.close();
    expect(result.stopReason).toBe('end_turn');
    expect(result.finalText).toBe('父收尾');
    const tr = loadSession(h.parentWriter.dir).events.find((e) => e.event.type === 'tool/result')!;
    const out = JSON.parse((tr.event.payload as { output: string }).output) as SpawnRecord;
    expect(out.children).toHaveLength(2);
    expect(out.children[0]?.ok).toBe(false);
    expect(out.children[0]?.stopReason).toBe('error');
    expect(out.children[0]?.error).toContain('child provider exploded');
    expect(out.children[1]?.ok).toBe(true);
    expect(out.children[1]?.finalText).toBe('成功子结果');
  });

  // P2-2：建会话阶段中途抛错 → 已建子会话 writer 必须关闭（否则句柄/目录锁泄漏 + 空子会话残留）
  it('创建中途失败：已建子会话 writer 全部关闭、不记录历史、失败的那个不留目录', async () => {
    const root = tmpDir();
    const real = new SessionManager(join(root, 'sessions'));
    const closed: string[] = [];
    let calls = 0;
    /** 前 2 次委托真 manager（并把 close 包成可观测），第 3 次抛错（模拟磁盘/权限失败） */
    const manager = {
      create: (cwd: string, opts: Parameters<SessionManager['create']>[1]) => {
        calls += 1;
        if (calls === 3) throw new Error('create boom（磁盘满/权限）');
        const created = real.create(cwd, opts);
        const original = created.writer.close.bind(created.writer);
        created.writer.close = (): void => {
          closed.push(created.id);
          original();
        };
        return created;
      },
    } as unknown as SessionManager;
    const history = new SpawnHistoryStore();
    const parentId = '20260914-000000-abcdef';
    const [tool] = createFanoutTools({
      manager,
      provider: new MockProvider([{ text: 'unused' }]),
      baseTools: new ToolRegistry(),
      cwd: root,
      maxTurns: 2,
      maxDepth: 1,
      parentSessionId: parentId,
      depth: 0,
      history,
      fsync: false,
    });
    const out = await tool!.execute({ prompts: ['甲', '乙', '丙'] }, CALL_CTX);
    expect(out.error).toContain('子会话创建失败（第 2 个）');
    expect(out.error).toContain('create boom');
    expect(calls).toBe(3);
    // 已建的两个都关了（无未关闭句柄/锁）；失败的第三次没有留下第三个会话目录
    expect(closed).toHaveLength(2);
    expect(childDirs(real, parentId)).toHaveLength(2);
    // 失败不写历史（没有可重放的记录）
    expect(history.size).toBe(0);
  });
});

describe('H-42 参数护栏', () => {
  function fanoutTool(): ToolDefinition {
    const registry = new ToolRegistry();
    const [tool] = createFanoutTools({
      manager: new SessionManager(join(tmpDir(), 's')),
      provider: new MockProvider([]),
      baseTools: registry,
      cwd: tmpDir(),
      maxDepth: 1,
      maxTurns: 3,
      parentSessionId: 'parent',
      depth: 0,
    });
    return tool!;
  }

  it('prompts 校验：缺参/空数组/非字符串项/空串 → 明确 error', async () => {
    const tool = fanoutTool();
    expect((await tool.execute({}, CALL_CTX)).error).toContain('prompts');
    expect((await tool.execute({ prompts: [] }, CALL_CTX)).error).toContain('非空字符串数组');
    expect((await tool.execute({ prompts: ['ok', 1] }, CALL_CTX)).error).toContain('每一项');
    expect((await tool.execute({ prompts: ['ok', '  '] }, CALL_CTX)).error).toContain('每一项');
  });

  it('数量护栏：超过上限直接拒绝（不创建子会话）', async () => {
    const tool = fanoutTool();
    const tooMany = Array.from({ length: FANOUT_MAX_CHILDREN + 1 }, (_, i) => `t${i}`);
    expect((await tool.execute({ prompts: tooMany }, CALL_CTX)).error).toContain(
      `最多 ${FANOUT_MAX_CHILDREN} 个子代理`,
    );
    expect(FANOUT_MAX_CHILDREN).toBe(8);
  });
});

describe('H-42 spawnHistoryStore（最近 10 次 fan-out，供 /replay）', () => {
  function fakeRecord(id: string, children = 1): SpawnRecord {
    return {
      id,
      parentSessionId: 'parent-1',
      startedAt: `2026-09-14T00:00:${id.padStart(2, '0')}.000Z`,
      finishedAt: `2026-09-14T00:01:${id.padStart(2, '0')}.000Z`,
      children: Array.from({ length: children }, (_, i) => ({
        index: i,
        prompt: `p-${id}-${i}`,
        childSessionId: `child-${id}-${i}`,
        ok: true,
        stopReason: 'end_turn' as const,
        finalText: `done-${id}-${i}`,
        durationMs: 5,
      })),
    };
  }

  it('上限 10：FIFO 淘汰最旧；list 旧→新，latest 新→旧', () => {
    const store = new SpawnHistoryStore();
    for (let i = 1; i <= 12; i++) store.record(fakeRecord(String(i)));
    expect(SPAWN_HISTORY_LIMIT).toBe(10);
    expect(store.size).toBe(SPAWN_HISTORY_LIMIT);
    expect(store.list().map((r) => r.id)).toEqual(['3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    expect(store.latest(3).map((r) => r.id)).toEqual(['12', '11', '10']);
    expect(store.latest()).toHaveLength(10);
  });

  it('可重放：按 id 取回完整记录；记录是纯数据（JSON 往返等价）；返回副本', () => {
    const store = new SpawnHistoryStore();
    const rec = fakeRecord('42', 2);
    store.record(rec);
    const got = store.get('42');
    expect(got).toEqual(rec);
    expect(JSON.parse(JSON.stringify(got))).toEqual(rec);
    expect(store.get('nope')).toBeUndefined();
    (store.list() as SpawnRecord[]).push(fakeRecord('99'));
    expect(store.size).toBe(1);
    store.clear();
    expect(store.size).toBe(0);
  });

  it('formatSpawnReplay：逐子一行（index/状态/stopReason/耗时/childSessionId/prompt）', () => {
    const text = formatSpawnReplay(fakeRecord('7', 2));
    expect(text).toContain('fan-out 7（父会话 parent-1）');
    expect(text).toContain('子代理 2 个:');
    expect(text).toContain('child=child-7-0');
    expect(text).toContain('end_turn');
    expect(text).toContain('p-7-1');
  });

  it('真实扇出会写入历史：一次 fanout = 一条记录，可 /replay 复现结果', async () => {
    const h = makeFanoutHarness({
      parentScript: [
        {
          toolCalls: [{ id: 'f1', name: FANOUT_TOOL_NAME, arguments: JSON.stringify({ prompts: ['甲', '乙'] }) }],
        },
        { text: 'done' },
      ],
      childProviders: [new MockProvider([{ text: '甲完成' }]), new MockProvider([{ text: '乙完成' }])],
    });
    await runTurn(h.parentWriter, {
      provider: h.parentProvider,
      tools: h.registry,
      cwd: h.root,
      userText: 'go',
      maxSteps: 4,
    });
    h.parentWriter.close();
    expect(h.history.size).toBe(1);
    const latest = h.history.latest()[0]!;
    expect(latest.parentSessionId).toBe(h.parentId);
    expect(latest.children.map((c) => c.finalText)).toEqual(['甲完成', '乙完成']);
    expect(latest.children.every((c) => c.ok)).toBe(true);
    const replay = formatSpawnReplay(latest);
    expect(replay).toContain('end_turn');
    expect(replay).toContain(latest.children[0]!.childSessionId);
    expect(h.history.get(latest.id)).toEqual(latest);
  });
});
