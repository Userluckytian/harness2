// S5 子代理协调器接线（task-coordinator 经 hub 接入后台任务）测试。
// 覆盖：父 cancel → 子 abort（task 生命周期 + 子会话 cancelled）；expectedId 陈旧 task cancel 被拒；
// 审批上抛一路到父（task 内工具审批带 taskId/parentTaskId，父 pendingApprovalsFor 可见）；
// queue continue 清场（paused 队列 continue 后能接受新 submit）；task/transition 落 runtime journal。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSessionsRoot,
  MockProvider,
  registerBuiltinTools,
  SessionHub,
  SessionManager,
  ToolExecutor,
  ToolRegistry,
  runTurn,
  SnapshotStore,
} from '../src/index.js';
import { writeTool } from '../src/tools/predefined/index.js';
import { createSubagentTools } from '../src/agent/subagent.js';
import { RuntimeJournal } from '../src/interaction/runtime-journal.js';
import type { RuntimeJournalEntry } from '../src/interaction/runtime-journal.js';
import type { TaskRunResult } from '../src/agent/task-coordinator.js';
import type { CancelRequest } from '../src/interaction/types.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-subcoord-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 轮询等待条件成立（超时抛错） */
async function waitFor(pred: () => boolean, timeoutMs = 8000, step = 20): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > until) throw new Error('waitFor 超时');
    await sleep(step);
  }
}

/** 建一个开启后台子代理（backgroundTasks:true，走协调器）的生产 hub */
function makeProdHub(opts: { parent: MockProvider; child: MockProvider; taskWriteMode?: 'readonly' | 'write' }) {
  const root = tmpDir();
  const hub = new SessionHub({
    manager: new SessionManager(defaultSessionsRoot(tmpDir('h2-subcoord-home-'))),
    provider: opts.parent,
    tools: (() => {
      const r = new ToolRegistry();
      registerBuiltinTools(r);
      return r;
    })(),
    cwd: root,
    decide: () => 'allow',
    subagent: {
      provider: opts.child,
      maxDepth: 1,
      maxTurns: 25,
      backgroundTasks: true,
      ...(opts.taskWriteMode !== undefined ? { taskWriteMode: opts.taskWriteMode } : {}),
    },
  });
  return { hub, root };
}

/** 跑一个子会话 runTurn 的后台任务 run（subagent 风格：独立子会话 + 独立审批缝）。 */
function childRun(
  hub: SessionHub,
  opts: {
    cwd: string;
    parentSessionId: string;
    taskId: string;
    parentTaskId?: string;
    provider: MockProvider;
  },
) {
  return async (signal: AbortSignal): Promise<TaskRunResult> => {
    const created = hub.manager.create(opts.cwd, {
      parentSession: opts.parentSessionId,
      isSeeded: true,
      subagent: true,
      fsync: false,
    });
    hub.linkChildSession(opts.parentSessionId, created.id);
    const registry = new ToolRegistry();
    registry.register(writeTool);
    try {
      const result = await runTurn(created.writer, {
        provider: opts.provider,
        tools: registry,
        approval: hub.taskApprovalHandler(created.id, signal, { taskId: opts.taskId, parentTaskId: opts.parentTaskId }),
        cwd: opts.cwd,
        userText: 'child task',
        signal,
        maxSteps: 10,
        snapshots: new SnapshotStore(created.dir),
      });
      return { ok: result.stopReason === 'end_turn', error: result.error };
    } finally {
      created.writer.close();
    }
  };
}

function makeHub(opts: { provider: MockProvider; decide?: (i: { tool: string; args: unknown }) => 'ask' | 'allow' }) {
  const root = tmpDir();
  const hub = new SessionHub({
    manager: new SessionManager(defaultSessionsRoot(tmpDir('h2-subcoord-home-'))),
    provider: opts.provider,
    tools: (() => {
      const r = new ToolRegistry();
      registerBuiltinTools(r);
      return r;
    })(),
    cwd: root,
    ...(opts.decide !== undefined ? { decide: opts.decide as never } : {}),
  });
  return { hub, root };
}

describe('task 生命周期经 hub 协调器 + journal 落账', () => {
  it('registerTask → 终态；resumeSnapshot.tasks 反映；runtime.v1.jsonl 含 task/transition（带 clientMessageId）', async () => {
    const p1 = new MockProvider([{ textChunks: ['子任务完成'] }]);
    const { hub, root } = makeHub({ provider: p1 });
    const pid = hub.create(root).id;
    const dir = hub.locate(pid);
    const handle = hub.registerTask({
      taskId: 't1',
      sessionId: pid,
      background: true,
      writeMode: 'readonly',
      clientMessageId: 'cm-task-1',
      prompt: '后台只读任务',
      run: childRun(hub, { cwd: root, parentSessionId: pid, taskId: 't1', provider: p1 }),
    });
    expect(handle.taskId).toBe('t1');
    // 等终态
    const terminal = await hub.tasks.wait('t1');
    expect(['completed', 'failed', 'cancelled']).toContain(terminal.state);
    // resumeSnapshot.tasks 反映（task/transition 落父会话 journal 重建）
    const snap = hub.resumeSnapshot({ sessionId: pid, lastSeq: 0, epoch: 1 });
    expect(snap?.tasks.some((t) => t.taskId === 't1')).toBe(true);
    // journal 带 clientMessageId 溯源
    const entries = RuntimeJournal.readEntries(dir).entries;
    const isTransition = (e: RuntimeJournalEntry): e is Extract<RuntimeJournalEntry, { kind: 'task/transition' }> =>
      e.kind === 'task/transition';
    const t1 = entries.filter(isTransition).filter((e) => e.taskId === 't1');
    expect(t1.length).toBeGreaterThanOrEqual(4);
    expect(t1.every((t) => t.clientMessageId === 'cm-task-1')).toBe(true);
    await hub.close();
  });
});

describe('父 cancel → 子 abort（Q cancel task → 子会话 cancelled）', () => {
  it('cancel 运行中子任务 → stopping；child turn 取消；task 终态 cancelled', async () => {
    const pc = new MockProvider([{ textChunks: new Array(50).fill('x'), chunkDelayMs: 40 }]);
    const { hub, root } = makeHub({ provider: pc });
    const pid = hub.create(root).id;
    hub.registerTask({
      taskId: 't-cancel',
      sessionId: pid,
      background: true,
      writeMode: 'readonly',
      prompt: '取消窗口测试',
      run: childRun(hub, { cwd: root, parentSessionId: pid, taskId: 't-cancel', provider: pc }),
    });
    await sleep(150); // 等任务进入 running + 子 turn 开始流式
    expect(hub.tasks.status('t-cancel')?.state).toBe('running');
    const req: CancelRequest = { requestId: 'cnl-1', target: { kind: 'task', id: 't-cancel' }, expectedId: 'running' };
    const ack = hub.cancelAck(req);
    expect(ack.state).toBe('stopping');
    await hub.tasks.wait('t-cancel');
    expect(hub.tasks.status('t-cancel')?.state).toBe('cancelled');
    await hub.close();
  });
});

describe('expectedId 陈旧 task cancel 被拒', () => {
  it('expectedId ≠ 当前状态 → unknown 拒绝；正确 expectedId → stopping', async () => {
    const pe = new MockProvider([{ textChunks: new Array(50).fill('x'), chunkDelayMs: 40 }]);
    const { hub, root } = makeHub({ provider: pe });
    const pid = hub.create(root).id;
    hub.registerTask({
      taskId: 't-ex',
      sessionId: pid,
      background: true,
      writeMode: 'readonly',
      prompt: 'expectedId 测试',
      run: childRun(hub, { cwd: root, parentSessionId: pid, taskId: 't-ex', provider: pe }),
    });
    await sleep(150);
    expect(hub.tasks.status('t-ex')?.state).toBe('running');
    // 陈旧期望：期望 starting，实际 running → 拒绝
    const stale = hub.cancelAck({ requestId: 'c1', target: { kind: 'task', id: 't-ex' }, expectedId: 'starting' });
    expect(stale.state).toBe('unknown');
    expect(hub.tasks.status('t-ex')?.state).toBe('running'); // 未误伤
    // 正确 expectedId=running → stopping
    const ok = hub.cancelAck({ requestId: 'c2', target: { kind: 'task', id: 't-ex' }, expectedId: 'running' });
    expect(ok.state).toBe('stopping');
    await hub.close();
  });
});

describe('审批上抛一路到父（task 内工具审批带 taskId/parentTaskId）', () => {
  it('子任务写工具审批：卡片带 taskId/parentTaskId；父 pendingApprovalsFor 可见；放行后完成', async () => {
    const cwd = tmpDir('h2-subcoord-ap-');
    const file = join(cwd, 'out.txt');
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c-w', name: 'write', arguments: JSON.stringify({ file_path: file, content: 'x' }) }] },
      { textChunks: ['子任务写好了'] },
    ]);
    const hub = new SessionHub({
      manager: new SessionManager(defaultSessionsRoot(tmpDir('h2-subcoord-home-'))),
      provider,
      tools: (() => {
        const r = new ToolRegistry();
        registerBuiltinTools(r);
        return r;
      })(),
      cwd: tmpDir('h2-subcoord-root-'),
      decide: () => 'ask',
    });
    const pid = hub.create(cwd).id;
    const approvals: Array<{ taskId?: string; parentTaskId?: string; requestId: string }> = [];
    hub.addHooks({
      onApprovalRequest: (a) =>
        approvals.push({ taskId: a.taskId, parentTaskId: a.parentTaskId, requestId: a.requestId }),
    });
    hub.registerTask({
      taskId: 't-ap',
      sessionId: pid,
      background: true,
      writeMode: 'write',
      parentTaskId: undefined,
      clientMessageId: 'cm-ap',
      prompt: '审批上抛测试',
      run: childRun(hub, { cwd, parentSessionId: pid, taskId: 't-ap', parentTaskId: 'parent-task-x', provider }),
    });
    // 等审批卡上抛（父子会话都在场）
    for (let i = 0; i < 100 && approvals.length === 0; i++) await sleep(20);
    expect(approvals.length).toBeGreaterThanOrEqual(1);
    expect(approvals[0]?.taskId).toBe('t-ap');
    expect(approvals[0]?.parentTaskId).toBe('parent-task-x');
    // 父（用户会话）可见该子任务审批
    const parentView = hub.pendingApprovalsFor(pid);
    expect(parentView.some((a) => a.requestId === approvals[0]?.requestId)).toBe(true);
    // 放行 → 子任务完成
    hub.respondApproval(approvals[0]!.requestId, 'allow');
    await hub.tasks.wait('t-ap');
    expect(hub.tasks.status('t-ap')?.state).toBe('completed');
    expect(existsSync(file)).toBe(true);
    await hub.close();
  });
});

describe('queue continue 清场（S3c2 carry-over）', () => {
  it('重启恢复 paused 不计 20 上限；continue 出队后 pause 不再占用；新 submit 可受理', async () => {
    const home = tmpDir('h2-subcoord-home-');
    const root = tmpDir('h2-subcoord-root-');
    // A：提交一个 queue 项并执行（journal 落 durable accept）
    const A = new SessionHub({
      manager: new SessionManager(defaultSessionsRoot(home)),
      provider: new MockProvider([{ textChunks: ['A 执行'] }]),
      tools: (() => {
        const r = new ToolRegistry();
        registerBuiltinTools(r);
        return r;
      })(),
      cwd: root,
    });
    const pidA = A.create(root).id;
    const a = A.submitAck({ clientMessageId: 'cm-p', sessionId: pidA, rawText: '持久队列项', intent: 'queue' });
    expect(a.state).toBe('accepted');
    await sleep(200); // 等 A 执行完该 turn
    await A.close();
    // B 重启：同 home/root
    const B = new SessionHub({
      manager: new SessionManager(defaultSessionsRoot(home)),
      provider: new MockProvider([{ textChunks: ['B'] }]),
      tools: (() => {
        const r = new ToolRegistry();
        registerBuiltinTools(r);
        return r;
      })(),
      cwd: root,
    });
    const pidB = pidA;
    const snapB = B.resumeSnapshot({ sessionId: pidB, lastSeq: 0, epoch: 1 });
    expect(snapB?.queue.some((q) => q.id === 'cm-p' && q.state === 'paused')).toBe(true);
    // paused 不计上限：恢复队列里有 paused 项时新 submit 仍 accepted
    const nb = B.submitAck({ clientMessageId: 'cm-new-b', sessionId: pidB, rawText: '重启后新提交', intent: 'queue' });
    expect(nb.state).toBe('accepted');
    // continue 清场：paused 项出队，且（若回填正文）派发执行
    const cleared = B.continueQueue(pidB, (id) => (id === 'cm-p' ? '持久队列项' : undefined));
    expect(cleared).toBeGreaterThanOrEqual(1);
    const snapAfter = B.resumeSnapshot({ sessionId: pidB, lastSeq: 0, epoch: 2 });
    expect(snapAfter?.queue.some((q) => q.id === 'cm-p')).toBe(false); // paused 已出队
    await B.close();
  });
});

describe('S5 生产路径：后台子代理任务（buildTurnTools → createSubagentTools → 协调器）', () => {
  it('父在跑 turn 时 cancel 后台子代理任务：父 turn 保持 end_turn、子任务 cancelled（Important 1 回归）', async () => {
    const { hub, root } = makeProdHub({
      parent: new MockProvider([
        { toolCalls: [{ id: 'tk', name: 'subagent_start', arguments: JSON.stringify({ prompt: '子任务' }) }] },
        { textChunks: new Array(60).fill('p'), chunkDelayMs: 20 }, // 父继续流式，保持 in-turn
      ]),
      child: new MockProvider([{ textChunks: new Array(60).fill('c'), chunkDelayMs: 25 }]), // 慢子任务
    });
    const pid = hub.create(root).id;
    const startOutputs: string[] = [];
    let parentStop = '';
    hub.addHooks({
      onExecuteEnd: (_s, req, result) => {
        if (req.tool === 'subagent_start') startOutputs.push(result.output ?? '');
      },
      onTurnEnd: (sid, result) => {
        if (sid === pid) parentStop = result.stopReason;
      },
    });
    hub.sendUserMessage(pid, '派发子任务');
    await waitFor(() => startOutputs.length > 0);
    const meta = JSON.parse(startOutputs[0]!) as { taskId: string; state: string };
    expect(meta.taskId).toMatch(/^bg-/);
    await sleep(80);
    // 子任务应已 running；父 turn 仍 in-turn（流式未结束）
    expect(hub.tasks.status(meta.taskId)?.state).toBe('running');
    expect(parentStop).toBe('');
    // cancel 子任务：不应误伤父 turn
    const ack = hub.cancelAck({
      requestId: 'cnl-prod',
      target: { kind: 'task', id: meta.taskId },
      expectedId: 'running',
    });
    expect(ack.state).toBe('stopping');
    await waitFor(() => parentStop !== '');
    expect(parentStop).toBe('end_turn'); // 父 turn 正常收尾，未被 abort
    await hub.tasks.wait(meta.taskId);
    expect(hub.tasks.status(meta.taskId)?.state).toBe('cancelled');
    await hub.close();
  }, 20000);

  it('后台 subagent_start 注册进协调器跑完；subagent_continue(taskId) 取终态结果', async () => {
    const { hub, root } = makeProdHub({
      parent: new MockProvider([
        { toolCalls: [{ id: 'tk2', name: 'subagent_start', arguments: JSON.stringify({ prompt: '写一段' }) }] },
        { textChunks: ['父收尾'] },
      ]),
      child: new MockProvider([{ textChunks: ['子任务结果写好了'] }]),
    });
    const pid = hub.create(root).id;
    const startOutputs: string[] = [];
    hub.addHooks({
      onExecuteEnd: (_s, req, result) => {
        if (req.tool === 'subagent_start') startOutputs.push(result.output ?? '');
      },
    });
    hub.sendUserMessage(pid, '派发');
    await waitFor(() => startOutputs.length > 0);
    const meta = JSON.parse(startOutputs[0]!) as { taskId: string; childSessionId: string };
    await hub.tasks.wait(meta.taskId);
    expect(hub.tasks.status(meta.taskId)?.state).toBe('completed');
    // 生产路径：resumeSnapshot.tasks 反映该后台任务（via registerTask → taskSessions → journal 录入）
    const snap = hub.resumeSnapshot({ sessionId: pid, lastSeq: 0, epoch: 1 });
    expect(snap?.tasks.some((t) => t.taskId === meta.taskId)).toBe(true);
    // subagent_continue(taskId)：同一 hub 协调器 + taskOutcomes 取终态输出
    const defs = createSubagentTools({
      manager: hub.manager,
      provider: new MockProvider([{ textChunks: [] }]),
      baseTools: new ToolRegistry(),
      cwd: root,
      maxDepth: 1,
      maxTurns: 25,
      parentSessionId: pid,
      depth: 0,
      coordinator: hub.tasks,
      background: true,
    });
    // P1-1 修复回归：只传 taskId 经 ToolExecutor 端到端——不得被 A1-4 必填参数预校验误拦，
    // 且能真实取到协调器里的后台任务状态/结果。
    const contRegistry = new ToolRegistry();
    for (const d of defs) contRegistry.register(d);
    const contExecutor = new ToolExecutor(contRegistry);
    const r = await contExecutor.execute(
      { callId: 'cont-taskid', tool: 'subagent_continue', args: { taskId: meta.taskId } },
      { cwd: root, signal: new AbortController().signal },
    );
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    const parsed = JSON.parse(r.output!) as { childSessionId: string; stopReason: string; finalText?: string };
    expect(parsed.stopReason).toBe('end_turn');
    expect(parsed.finalText).toBeDefined();
    await hub.close();
  }, 20000);
});

describe('S5 close 与协调器任务竞态（Important 2 回归）', () => {
  it('close 在后台任务运行时调用：settleAll 等待落定，journal 未在关闭后裸写', async () => {
    const slow = new MockProvider([{ textChunks: new Array(200).fill('x'), chunkDelayMs: 20 }]); // ~4s
    const { hub, root } = makeHub({ provider: slow });
    const pid = hub.create(root).id;
    hub.registerTask({
      taskId: 't-close',
      sessionId: pid,
      background: true,
      writeMode: 'readonly',
      prompt: 'close 竞态测试',
      run: childRun(hub, { cwd: root, parentSessionId: pid, taskId: 't-close', provider: slow }),
    });
    await sleep(120); // 任务进入 running
    expect(hub.tasks.status('t-close')?.state).toBe('running');
    const dir = hub.locate(pid);
    await hub.close(); // close 应等待任务落定（不悬挂、不向已关闭 journal 写）
    expect(hub.tasks.status('t-close')?.state).toBe('cancelled');
    // journal 在 close 后仍可读，且含终态 cancelled 迁移（说明 settle 先于 journal 关闭落账）
    const entries = RuntimeJournal.readEntries(dir).entries;
    const trans = entries.filter(
      (e): e is Extract<RuntimeJournalEntry, { kind: 'task/transition' }> =>
        e.kind === 'task/transition' && e.taskId === 't-close',
    );
    expect(trans.length).toBeGreaterThan(0);
    expect(trans[trans.length - 1]!.payload.to).toBe('cancelled');
  });
});
