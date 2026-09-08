// S7a 计划状态只读投影边界（plan-execution-boundary）。
// 契约（计划 S7 / 验收 #7b）：
//   - planState 从磁盘投影/账本可重建（能指到来源事件/任务 id，非内存猜测）；
//   - 步骤与状态符合执行推进（task/transition 单调链 → 当前状态）；
//   - 展示计划不自动放行审批：有审批需求的步骤仍留在 approval-queue，需用户授权；
//   - planState 只读、non-mutating（不改 journal / 会话日志）；
//   - 计划状态与任务状态一致（复用 reconstructTasks，不再造一份状态）。
// 全部本地临时目录 + 真实 journal/session log 落盘重建，无网络。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/session/manager.js';
import { RuntimeJournal } from '../src/interaction/runtime-journal.js';
import type { TaskState } from '../src/interaction/types.js';
import { ApprovalQueue } from '../src/interaction/approval-queue.js';
import type { ApprovalQueueCard } from '../src/interaction/approval-queue.js';
import { reconstructTasks } from '../src/agent/task-coordinator.js';
import { loadPlanState, reconstructPlanState } from '../src/interaction/plan-state.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-plan-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 建一个带会话日志（header + user/message）的真实会话目录 */
function makeSessionDir(root: string, cwd: string, userText: string): { dir: string; id: string } {
  const manager = new SessionManager(join(root, 'sessions'));
  const created = manager.create(cwd, { fsync: false });
  created.writer.append('user/message', { text: userText });
  return { dir: created.dir, id: created.id };
}

/** 「计划稿」：root 已完成的父任务 + child 停在 waiting-approval（审批需求未放行） */
function writePlanJournal(
  dir: string,
): { journal: RuntimeJournal; transitions: Array<{ taskId: string; from: TaskState; to: TaskState }>; seqs: number[] } {
  const journal = RuntimeJournal.create(dir, { fsync: false });
  const transitions: Array<{ taskId: string; from: TaskState; to: TaskState }> = [];
  const seqs: number[] = [];
  const tx = (taskId: string, parentTaskId: string | undefined, from: TaskState, to: TaskState): void => {
    const entry = journal.append({
      kind: 'task/transition',
      taskId,
      ...(parentTaskId !== undefined ? { parentTaskId } : {}),
      from,
      to,
    });
    transitions.push({ taskId, from, to });
    seqs.push(entry.seq);
  };
  tx('task-root', undefined, 'registered', 'queued');
  tx('task-root', undefined, 'queued', 'starting');
  tx('task-root', undefined, 'starting', 'running');
  tx('task-root', undefined, 'running', 'completed');
  tx('task-child', 'task-root', 'registered', 'queued');
  tx('task-child', 'task-root', 'queued', 'starting');
  tx('task-child', 'task-root', 'starting', 'running');
  tx('task-child', 'task-root', 'running', 'waiting-approval');
  return { journal, transitions, seqs };
}

describe('planState 从磁盘投影/账本可重建（指到来源事件/任务 id）', () => {
  it('loadPlanState 重建 planId/目标/步骤/每步状态/证据 ID，全部来自落盘数据', () => {
    const root = tmpDir();
    const { dir } = makeSessionDir(root, join(root, 'work'), '实现桌面功能闭环契约');
    const { journal, seqs } = writePlanJournal(dir);
    try {
      const plan = loadPlanState(dir)!;
      expect(plan).not.toBeNull();
      expect(plan.readOnly).toBe(true);
      expect(plan.planId).toBe('task-root'); // 无父任务的根任务 = 计划 id
      expect(plan.goal).toBe('实现桌面功能闭环契约'); // 目标 = 会话日志 user/message 投影
      expect(plan.goalEvidence?.source).toBe('user-message');
      expect(plan.goalEvidence?.seq).toBeGreaterThanOrEqual(2); // header 之后的首条用户消息
      // 步骤 = 两个任务，状态与服务端任务状态一致
      expect(plan.steps.map((s) => s.stepId)).toEqual(['task-root', 'task-child']);
      expect(plan.steps[0]!.state).toBe('completed');
      expect(plan.steps[1]!.state).toBe('waiting-approval');
      // 证据 ID：每个步骤都指回 journal 的 task/transition seq（可逐条回放）
      for (const step of plan.steps) {
        expect(step.evidence.source).toBe('runtime-journal');
        expect(step.evidence.taskId).toBe(step.stepId);
        expect(step.evidence.journalSeqs.length).toBeGreaterThan(0);
        for (const seq of step.evidence.journalSeqs) expect(seqs).toContain(seq);
      }
    } finally {
      journal.close();
    }
  });

  it('planId 显式指定时生效（多任务可选定视角）', () => {
    const root = tmpDir();
    const { dir } = makeSessionDir(root, join(root, 'work'), 'hello');
    const { journal } = writePlanJournal(dir);
    try {
      const plan = loadPlanState(dir, { planId: 'task-child' })!;
      expect(plan.planId).toBe('task-child');
      // 步骤仍是全部任务（planId 只决定命名，不改变重建事实）
      expect(plan.steps.map((s) => s.stepId)).toEqual(['task-root', 'task-child']);
    } finally {
      journal.close();
    }
  });

  it('空账本 / 无 journal → null（不臆造计划）', () => {
    const root = tmpDir();
    const { dir } = makeSessionDir(root, join(root, 'work'), 'no plan');
    expect(loadPlanState(dir)).toBeNull(); // 无 runtime journal
    const journal = RuntimeJournal.create(dir, { fsync: false });
    try {
      journal.append({
        kind: 'queue/accepted',
        clientMessageId: 'cm-1',
        sessionId: 's',
        intent: 'queue',
        queueSeq: 0,
      });
      expect(loadPlanState(dir)).toBeNull(); // 有账本但无 task/transition → 无计划
    } finally {
      journal.close();
    }
  });
});

describe('步骤与状态符合执行推进', () => {
  it('每个步骤的状态 = 该任务最后一条 task/transition 的 to（单调推进）', () => {
    const root = tmpDir();
    const { dir } = makeSessionDir(root, join(root, 'work'), '推进');
    const { journal, transitions } = writePlanJournal(dir);
    try {
      const plan = loadPlanState(dir)!;
      for (const step of plan.steps) {
        const last = transitions.filter((t) => t.taskId === step.stepId).at(-1)!;
        expect(step.state).toBe(last.to);
      }
      // 与 reconstructTasks 直接结果一致（同源状态，不另造）
      const tasks = reconstructTasks(
        transitions.map((t) => ({ taskId: t.taskId, from: t.from, to: t.to })),
      );
      for (const [i, task] of tasks.entries()) {
        expect(plan.steps[i]!.state).toBe(task.state);
      }
    } finally {
      journal.close();
    }
  });
});

describe('展示计划不自动放行审批（审批仍走 approval-queue 需用户授权）', () => {
  it('计划视图含 waiting-approval 步骤时，审批卡停留在队列中；用户授权后才放行', () => {
    const root = tmpDir();
    const { dir } = makeSessionDir(root, join(root, 'work'), '审批边界');
    const { journal } = writePlanJournal(dir);
    try {
      const queue = new ApprovalQueue();
      let settled: boolean | null = null;
      const ok = queue.register({
        approval: {
          requestId: 'req-write',
          sessionId: 'plan-sess',
          tool: 'write',
          args: { file_path: join(root, 'work', 'x.txt') },
          scope: { mode: 'once' },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        settle: (allowed, reason) => {
          settled = allowed;
          void reason;
        },
      } satisfies ApprovalQueueCard);
      expect(ok).toBe(true);

      // 计划投影展示该步骤处于 waiting-approval（只读，不因「展示」自动放行）
      const plan = loadPlanState(dir)!;
      const pendingStep = plan.steps.find((s) => s.state === 'waiting-approval');
      expect(pendingStep?.stepId).toBe('task-child');

      // planState 构造前后，审批卡仍在队列、未落定
      expect(queue.listPending().map((a) => a.requestId)).toContain('req-write');
      expect(settled).toBeNull();

      // 用户授权前 planState 不提供任何 allow 通道；用户授权（respond allow）才放行
      const ack = queue.respond('req-write', 'allow');
      expect(ack.state).toBe('applied');
      expect(settled).toBe(true);
      expect(queue.listPending()).toHaveLength(0);
    } finally {
      journal.close();
    }
  });
});

describe('planState 只读 / non-mutating', () => {
  it('重建不写任何文件（journal 水位与行数不变）；结果深度冻结', () => {
    const root = tmpDir();
    const { dir } = makeSessionDir(root, join(root, 'work'), '只读');
    const { journal } = writePlanJournal(dir);
    try {
      const before = journal.readEntries();
      const plan = loadPlanState(dir)!;
      const after = journal.readEntries();
      expect(after.watermark.lastSeq).toBe(before.watermark.lastSeq);
      expect(after.watermark.lineCount).toBe(before.watermark.lineCount);
      expect(Object.isFrozen(plan)).toBe(true);
      expect(Object.isFrozen(plan.steps)).toBe(true);
      expect(Object.isFrozen(plan.steps[0]!.evidence)).toBe(true);
      // 重复重建 → 确定性一致
      const again = loadPlanState(dir)!;
      expect(JSON.stringify(again)).toBe(JSON.stringify(plan));
      // 只读契约钉：readOnly 恒为 true
      expect(plan.readOnly).toBe(true);
    } finally {
      journal.close();
    }
  });

  it('reconstructPlanState（纯函数）同样只投影不写盘；空输入 → null', () => {
    expect(reconstructPlanState([], {})).toBeNull();
    const root = tmpDir();
    const { dir } = makeSessionDir(root, join(root, 'work'), 'pure');
    const { journal } = writePlanJournal(dir);
    try {
      const entries = journal.readEntries().entries;
      const plan = reconstructPlanState(entries, { sourceDir: dir });
      expect(plan).not.toBeNull();
      expect(plan!.sourceDir).toBe(dir);
      expect(plan!.steps.map((s) => s.stepId)).toEqual(['task-root', 'task-child']);
    } finally {
      journal.close();
    }
  });
});

describe('计划状态与任务状态一致（不另造状态）', () => {
  it('计划步骤状态是任务状态本身（复用 TaskState，无独立计划状态机）', () => {
    const root = tmpDir();
    const { dir } = makeSessionDir(root, join(root, 'work'), '一致');
    const { journal } = writePlanJournal(dir);
    try {
      const plan = loadPlanState(dir)!;
      const allowed = new Set<string>(['completed', 'waiting-approval']);
      for (const step of plan.steps) {
        expect(step.state.length).toBeGreaterThan(0);
        expect(allowed.has(step.state)).toBe(true);
      }
    } finally {
      journal.close();
    }
  });
});