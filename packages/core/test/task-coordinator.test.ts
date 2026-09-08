// S5 任务协调器（task-coordinator.ts）测试。
// 覆盖：注册 ack 后立即 handle（background 立返）；只读过滤后 K=2 真实重叠（并存两个子任务）；
// 共享写全局串行（同一时刻至多一个写型在跑）；终态单调（状态不倒退）；
// status/wait/cancel 正确；expectedId 陈旧目标被拒；task/transition 打 clientMessageId 落账。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeJournal } from '../src/interaction/runtime-journal.js';
import { TASK_STATES, TASK_TERMINAL_STATES } from '../src/interaction/types.js';
import type { TaskState } from '../src/interaction/types.js';
import { TaskCoordinator } from '../src/agent/task-coordinator.js';
import type { TaskRunResult, TaskSpec, TaskTransitionRecorder } from '../src/agent/task-coordinator.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-task-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 内存账本记录器：断言任务迁移序列 + clientMessageId 溯源 */
class MemRecorder implements TaskTransitionRecorder {
  readonly log: Array<{ taskId: string; parentTaskId?: string; clientMessageId?: string; background?: boolean; from: TaskState; to: TaskState }> = [];
  appendTaskTransition(i: Parameters<TaskTransitionRecorder['appendTaskTransition']>[0]): void {
    this.log.push(i);
  }
}

function spec(over: Partial<TaskSpec> & { taskId: string; run: TaskSpec['run'] }): TaskSpec {
  return { sessionId: 's1', background: true, writeMode: 'readonly', prompt: 'p', ...over };
}

describe('注册 ack 后立即 handle（background 立返）', () => {
  it('background:true 注册同步返回 handle；状态为 queued（已入队待调度）', () => {
    const rec = new MemRecorder();
    const c = new TaskCoordinator({ recorder: rec });
    let called = false;
    const task = spec({
      taskId: 'task-1',
      background: true,
      clientMessageId: 'cm-1',
      run: async () => {
        called = true;
        return { ok: true };
      },
    });
    const handle = c.register(task);
    // 注册立即返回（不 await run）
    expect(handle.taskId).toBe('task-1');
    expect(handle.background).toBe(true);
    expect(TASK_STATES).toContain(handle.state);
    // 已落账 registered→queued（ack 后立即入队 handle）
    expect(rec.log.filter((l) => l.taskId === 'task-1' && l.from === 'registered' && l.to === 'queued')).toHaveLength(1);
    // clientMessageId 溯源落账
    expect(rec.log.some((l) => l.taskId === 'task-1' && l.clientMessageId === 'cm-1')).toBe(true);
    // run 由调度异步触发（本同步帧内尚未执行）
    expect(called).toBe(false);
  });
});

describe('只读 K=2 真实重叠', () => {
  it('readonly 并行 K=2：前 2 个真实重叠启动，第 3 个等槽位；全程 <=2 并存', async () => {
    const maxActive = { value: 0 };
    const c = new TaskCoordinator({ recorder: new MemRecorder(), maxReadonlyConcurrency: 2 });
    const runs: string[] = [];
    let active = 0;
    const gates: Array<() => void> = [];
    const mkRun = (label: string) => async () => {
      runs.push(`${label}:start`);
      active += 1;
      maxActive.value = Math.max(maxActive.value, active);
      await new Promise<void>((r) => gates.push(r));
      active -= 1;
      runs.push(`${label}:end`);
      return { ok: true } as TaskRunResult;
    };
    for (let i = 0; i < 3; i++) c.register(spec({ taskId: `r${i}`, run: mkRun(`r${i}`) }));
    await sleep(50);
    // 前 2 个并存（真实重叠）：r0/r1 都已 start
    expect(runs.indexOf('r0:start')).toBeGreaterThanOrEqual(0);
    expect(runs.indexOf('r1:start')).toBeGreaterThanOrEqual(0);
    // 第 3 个 r2 未启动（槽位被前 2 个占满）
    expect(runs.indexOf('r2:start')).toBe(-1);
    expect(maxActive.value).toBe(2);
    // 放行 r0 → 槽位腾出 → r2 启动；此时 r1+r2 并存，仍 ==2
    gates.shift()!();
    await sleep(50);
    expect(runs.indexOf('r2:start')).toBeGreaterThanOrEqual(0);
    expect(maxActive.value).toBe(2);
    // 放行剩余
    while (gates.length > 0) gates.shift()!();
    await sleep(50);
    expect(maxActive.value).toBe(2); // 全程从未超过 2
    for (let i = 0; i < 3; i++) expect(c.status(`r${i}`)?.state).toBe('completed');
  });
});

describe('共享写全局串行（同一时刻至多一个写型）', () => {
  it('两个 write 任务：第二个直到第一个完成才启动（不重叠）', async () => {
    const c = new TaskCoordinator({ recorder: new MemRecorder() });
    const timeline: string[] = [];
    let activeWrite = 0;
    let maxWriteActive = 0;
    const mkWrite = (label: string, delayMs: number) => async () => {
      activeWrite += 1;
      maxWriteActive = Math.max(maxWriteActive, activeWrite);
      timeline.push(`${label}:start`);
      await sleep(delayMs);
      timeline.push(`${label}:end`);
      activeWrite -= 1;
      return { ok: true } as TaskRunResult;
    };
    c.register(spec({ taskId: 'w1', writeMode: 'write', run: mkWrite('w1', 80) }));
    c.register(spec({ taskId: 'w2', writeMode: 'write', run: mkWrite('w2', 10) }));
    await sleep(200);
    // 串行：w1 完整结束后才 w2 开始
    expect(timeline.indexOf('w1:start')).toBeLessThan(timeline.indexOf('w2:start'));
    expect(timeline.indexOf('w1:end')).toBeLessThan(timeline.indexOf('w2:start'));
    expect(maxWriteActive).toBe(1); // 同一时刻至多一个写型
    expect(c.status('w1')?.state).toBe('completed');
    expect(c.status('w2')?.state).toBe('completed');
  });

  it('write 不与 readonly 互相阻塞（只读不阻塞，写不因只读等待）', async () => {
    const c = new TaskCoordinator({ recorder: new MemRecorder() });
    const timeline: string[] = [];
    const gates: Array<() => void> = [];
    const readonly = async () => {
      timeline.push('r:start');
      await new Promise<void>((r) => gates.push(r));
      timeline.push('r:end');
      return { ok: true } as TaskRunResult;
    };
    const write = async () => {
      timeline.push('w:start');
      await sleep(20);
      timeline.push('w:end');
      return { ok: true } as TaskRunResult;
    };
    c.register(spec({ taskId: 'r', writeMode: 'readonly', run: readonly }));
    c.register(spec({ taskId: 'w', writeMode: 'write', run: write }));
    await sleep(50);
    // 只读任务挂起时，写任务仍能启动（不只读阻塞）
    expect(timeline.indexOf('w:start')).toBeGreaterThanOrEqual(0);
    gates.shift()!();
    await sleep(50);
  });
});

describe('终态单调（状态不倒退）', () => {
  it('完成/失败/取消进入终态后不迁移；状态只向前', async () => {
    const c = new TaskCoordinator({ recorder: new MemRecorder() });
    c.register(spec({ taskId: 'ok', writeMode: 'readonly', run: async () => ({ ok: true }) }));
    c.register(spec({ taskId: 'fail', writeMode: 'readonly', run: async () => ({ ok: false, error: 'boom' }) }));
    c.register(
      spec({
        taskId: 'cancel',
        writeMode: 'readonly',
        run: (signal) =>
          new Promise<TaskRunResult>((resolve) => {
            signal.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled' }), { once: true });
          }),
      }),
    );
    await sleep(50);
    expect(c.status('ok')?.state).toBe('completed');
    expect(c.status('fail')?.state).toBe('failed');
    // 终态单调：完成后 status 不再变化（同一任务二次查询仍是终态）
    expect(TASK_TERMINAL_STATES.has(c.status('ok')!.state)).toBe(true);
    // 取消运行中任务 → cancelled（终态）
    c.cancel('cancel');
    await sleep(50);
    expect(c.status('cancel')?.state).toBe('cancelled');
    // 所有终态都在终态集合内
    for (const t of ['ok', 'fail', 'cancel']) expect(TASK_TERMINAL_STATES.has(c.status(t)!.state)).toBe(true);
  });
});

describe('status / wait / cancel', () => {
  it('status 不存在 → undefined；wait 阻塞至终态返回终态契约', async () => {
    const c = new TaskCoordinator({ recorder: new MemRecorder() });
    c.register(spec({ taskId: 't1', writeMode: 'readonly', run: async () => { await sleep(40); return { ok: true }; } }));
    expect(c.status('ghost')).toBeUndefined();
    const terminal = await c.wait('t1');
    expect(TASK_TERMINAL_STATES.has(terminal.state)).toBe(true);
  });

  it('cancel 运行中任务 → stopping（先）→ cancelled（终态收敛）', async () => {
    const c = new TaskCoordinator({ recorder: new MemRecorder() });
    let entered = false;
    const run = (signal: AbortSignal) =>
      new Promise<TaskRunResult>((resolve) => {
        entered = true;
        signal.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled' }), { once: true });
      });
    c.register(spec({ taskId: 'x', writeMode: 'readonly', run }));
    await sleep(30);
    expect(entered).toBe(true);
    const ack = c.cancel('x', { expectedId: 'running' });
    expect(ack.state).toBe('stopping');
    await c.wait('x');
    expect(c.status('x')?.state).toBe('cancelled');
  });

  it('cancel 排队未启动任务 → 直接 cancelled；cancel 已终态任务 → cancelled 确认', async () => {
    const c = new TaskCoordinator({ recorder: new MemRecorder(), maxReadonlyConcurrency: 1 });
    const gates: Array<() => void> = [];
    c.register(spec({ taskId: 'big', writeMode: 'readonly', run: async () => { await new Promise<void>((r) => gates.push(r)); return { ok: true }; } }));
    // 第二个 readonly 排队（槽位被 big 占满）
    c.register(spec({ taskId: 'queued', writeMode: 'readonly', run: async () => ({ ok: true }) }));
    await sleep(30);
    expect(c.status('queued')?.state === 'queued' || c.status('queued')?.state === 'registered').toBe(true);
    const qack = c.cancel('queued');
    expect(qack.state).toBe('cancelled');
    expect(c.status('queued')?.state).toBe('cancelled');
    // 放行 big
    gates.shift()!();
    await sleep(30);
    const c2 = c.cancel('big');
    expect(c2.state).toBe('cancelled'); // 已终态 → 确认 cancelled
  });
});

describe('expectedId 陈旧目标校验（S3c2 carry-over）', () => {
  it('cancel 带错误 expectedId（≠ 当前状态）→ unknown 被拒，不误伤', async () => {
    const c = new TaskCoordinator({ recorder: new MemRecorder() });
    const gates: Array<() => void> = [];
    c.register(spec({ taskId: 't', writeMode: 'readonly', run: async () => { await new Promise<void>((r) => gates.push(r)); return { ok: true }; } }));
    await sleep(30);
    expect(c.status('t')?.state).toBe('running');
    // 陈旧期望：期望 starting，但实际 running → 拒绝
    const stale = c.cancel('t', { expectedId: 'starting' });
    expect(stale.state).toBe('unknown');
    // 未被取消（仍在 running，未误伤）
    expect(c.status('t')?.state).toBe('running');
    // 正确 expectedId=running → 放行 stopping
    const ok = c.cancel('t', { expectedId: 'running' });
    expect(ok.state).toBe('stopping');
    gates.shift()!();
    await sleep(30);
    expect(c.status('t')?.state).toBe('cancelled');
  });

  it('cancel 不存在的任务 → unknown', () => {
    const c = new TaskCoordinator({ recorder: new MemRecorder() });
    expect(c.cancel('nope').state).toBe('unknown');
  });
});

describe('runtime journal 落账（S3a 账本 + clientMessageId 溯源）', () => {
  it('task/transition 写入 runtime.v1.jsonl，带 clientMessageId 溯源', async () => {
    const dir = tmpDir();
    const journal = RuntimeJournal.create(dir, { fsync: false });
    const recorder: TaskTransitionRecorder = {
      appendTaskTransition: (i) =>
        journal.append({
          kind: 'task/transition',
          taskId: i.taskId,
          parentTaskId: i.parentTaskId,
          clientMessageId: i.clientMessageId,
          background: i.background,
          from: i.from,
          to: i.to,
        }),
    };
    const c = new TaskCoordinator({ recorder });
    c.register(spec({ taskId: 'task-j', background: true, clientMessageId: 'cm-j', writeMode: 'readonly', run: async () => ({ ok: true }) }));
    await sleep(50);
    // 从 journal 重建：registered→queued→starting→running→completed 单调，含 clientMessageId
    const transitions = journal
      .readEntries()
      .entries.filter((e) => e.kind === 'task/transition')
      .map((e) => e as Extract<typeof e, { kind: 'task/transition' }>);
    const taskJ = transitions.filter((t) => t.taskId === 'task-j');
    // registered→queued→starting→running→completed = 4 条迁移
    expect(taskJ.length).toBeGreaterThanOrEqual(4);
    expect(taskJ.every((t) => t.clientMessageId === 'cm-j')).toBe(true);
    const seq = taskJ.map((t) => t.payload.to);
    expect(seq[seq.length - 1]).toBe('completed');
    // 单调：后续状态不倒退（按出现顺序依次推进）
    const order = ['registered', 'queued', 'starting', 'running', 'completed'];
    const pos = seq.map((s) => order.indexOf(s));
    for (let i = 1; i < pos.length; i++) {
      expect(pos[i]!).toBeGreaterThan(pos[i - 1]!);
    }
    journal.close();
  });
});
