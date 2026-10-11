// A14 工作流引擎测试：
//   - 步进执行（prompt/tool/subagent 各步骤类型的 fake 注入；不真起模型/进程）；
//   - 每步状态机 + 失败策略（stop/continue/retry 有界重试）；
//   - 人工审批闸（allow/deny/ask/无 handler，复用既有 ApprovalHandler）；
//   - 并发不超限（复用 TaskCoordinator 并行闸）；
//   - 单步超时 + 取消收敛；
//   - 断点续跑（落台账 → 新引擎按投影恢复到中断步）；
//   - 扩展事件可重放（SessionWriter 落盘 → loadSession → 投影）与 validator fail-closed；
//   - 失控保护：步数/并发/重试/超时（解析期）+ 递归深度（启动期）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionWriter,
  WORKFLOW_RUN_EVENT_TYPE,
  WorkflowEngine,
  appendWorkflowRunEvent,
  assertWorkflowDepth,
  allowAllApproval,
  extensionEventTypes,
  findWorkflowRun,
  latestWorkflowRun,
  loadSession,
  parseExtensionEventLine,
  parseWorkflowDefinition,
  projectWorkflowRuns,
  readWorkflowRunEvents,
  registerWorkflowRunEventType,
  workflowRunEventPayload,
  type LoadedExtensionEvent,
  type WorkflowDefinition,
  type WorkflowRunEventPayload,
  type WorkflowStepOutcome,
  type WorkflowStepRunInput,
  type WorkflowStepRunners,
} from '../src/index.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-workflow-eng-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function def(steps: unknown[], over: Record<string, unknown> = {}): WorkflowDefinition {
  return parseWorkflowDefinition({ name: 'demo', description: '演示', steps, ...over });
}

/** 记录调用顺序 + 可编排结局的 fake 执行器 */
function recorder(
  behavior: Record<string, (input: WorkflowStepRunInput) => WorkflowStepOutcome | Promise<WorkflowStepOutcome>> = {},
) {
  const calls: string[] = [];
  const runs: WorkflowStepRunners = {
    prompt: async (input) => {
      calls.push(input.step.id);
      return (await behavior[input.step.id]?.(input)) ?? { ok: true, output: `out-${input.step.id}` };
    },
    tool: async (input) => {
      calls.push(input.step.id);
      return (await behavior[input.step.id]?.(input)) ?? { ok: true, output: `tool-${input.step.id}` };
    },
    subagent: async (input) => {
      calls.push(input.step.id);
      return (await behavior[input.step.id]?.(input)) ?? { ok: true, output: `sub-${input.step.id}` };
    },
  };
  return { calls, runs };
}

function statusOf(state: { steps: Array<{ stepId: string; status: string }> }, id: string): string {
  return state.steps.find((s) => s.stepId === id)!.status;
}

describe('引擎步进（各步骤类型 fake 注入）', () => {
  it('prompt/tool/subagent 链式顺序执行 → ok，状态与输出摘要齐备', async () => {
    const { calls, runs } = recorder();
    const engine = new WorkflowEngine({
      runId: 'r1',
      definition: def([
        { id: 'a', type: 'prompt', prompt: 'a' },
        { id: 'b', type: 'tool', tool: 'read', args: { path: 'x' } },
        { id: 'c', type: 'subagent', prompt: 'c' },
      ]),
      cwd: '/tmp',
      steps: runs,
    });
    const state = await engine.run();
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(state.status).toBe('ok');
    expect(state.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok']);
    expect(state.steps[1]!.outputPreview).toBe('tool-b');
    expect(state.steps.every((s) => s.attempts === 1)).toBe(true);
  });

  it('未装配 runner 的步骤 → failed 且不冒泡', async () => {
    const engine = new WorkflowEngine({
      runId: 'r1',
      definition: def([{ id: 'a', type: 'subagent', prompt: 'a' }]),
      cwd: '/tmp',
      steps: {},
    });
    const state = await engine.run();
    expect(state.status).toBe('failed');
    expect(state.steps[0]!.error).toContain('未装配');
  });

  it('无 writer 也能跑（不落盘只返回内存态）', async () => {
    const { runs } = recorder();
    const engine = new WorkflowEngine({
      runId: 'r1',
      definition: def([{ id: 'a', type: 'prompt', prompt: 'a' }]),
      cwd: '/tmp',
      steps: runs,
    });
    expect((await engine.run()).status).toBe('ok');
  });
});

describe('失败策略', () => {
  const failB = (): Record<string, (i: WorkflowStepRunInput) => WorkflowStepOutcome> => ({
    b: () => ({ ok: false, error: 'boom' }),
  });

  it('stop：首败即停，余下 pending 落 skipped，run=failed', async () => {
    const { runs } = recorder(failB());
    const state = await new WorkflowEngine({
      runId: 'r1',
      definition: def([
        { id: 'a', type: 'prompt', prompt: 'a' },
        { id: 'b', type: 'prompt', prompt: 'b' },
        { id: 'c', type: 'prompt', prompt: 'c' },
      ]),
      cwd: '/tmp',
      steps: runs,
    }).run();
    expect(state.status).toBe('failed');
    expect(state.steps.map((s) => s.status)).toEqual(['ok', 'failed', 'skipped']);
    expect(statusOf(state, 'c')).toBe('skipped');
  });

  it('continue：独立分支继续；依赖失败者的下游落 blocked，run=failed', async () => {
    const { calls, runs } = recorder(failB());
    const state = await new WorkflowEngine({
      runId: 'r1',
      definition: def(
        [
          { id: 'a', type: 'prompt', prompt: 'a', dependsOn: [] },
          { id: 'b', type: 'prompt', prompt: 'b', dependsOn: [] },
          { id: 'c', type: 'prompt', prompt: 'c', dependsOn: ['b'] },
        ],
        { failurePolicy: 'continue' },
      ),
      cwd: '/tmp',
      steps: runs,
    }).run();
    expect(state.status).toBe('failed');
    expect(statusOf(state, 'a')).toBe('ok');
    expect(statusOf(state, 'b')).toBe('failed');
    expect(statusOf(state, 'c')).toBe('blocked');
    expect(calls).toContain('a');
  });

  it('retry：有界重试后成功（attempts=3）', async () => {
    let n = 0;
    const { runs } = recorder({ a: () => (++n < 3 ? { ok: false, error: 'flaky' } : { ok: true, output: 'done' }) });
    const state = await new WorkflowEngine({
      runId: 'r1',
      definition: def([{ id: 'a', type: 'prompt', prompt: 'a', maxRetries: 2 }], { failurePolicy: 'retry' }),
      cwd: '/tmp',
      steps: runs,
    }).run();
    expect(state.status).toBe('ok');
    expect(state.steps[0]!.attempts).toBe(3);
    expect(state.steps[0]!.status).toBe('ok');
  });

  it('retry 耗尽：attempts=maxRetries+1，run=failed，后续 skipped', async () => {
    const { runs } = recorder({ a: () => ({ ok: false, error: 'always' }) });
    const state = await new WorkflowEngine({
      runId: 'r1',
      definition: def(
        [
          { id: 'a', type: 'prompt', prompt: 'a', maxRetries: 1 },
          { id: 'b', type: 'prompt', prompt: 'b' },
        ],
        { failurePolicy: 'retry' },
      ),
      cwd: '/tmp',
      steps: runs,
    }).run();
    expect(state.status).toBe('failed');
    expect(state.steps[0]!.attempts).toBe(2);
    expect(statusOf(state, 'b')).toBe('skipped');
  });
});

describe('人工审批闸（复用既有 ApprovalHandler）', () => {
  const gateDef = def([{ id: 'gate', type: 'approval', tool: 'bash', args: { command: 'rm -rf /' }, prompt: '放行?' }]);

  it('allow → ok', async () => {
    const state = await new WorkflowEngine({
      runId: 'r1',
      definition: gateDef,
      cwd: '/tmp',
      steps: {},
      approval: allowAllApproval,
    }).run();
    expect(state.status).toBe('ok');
    expect(state.steps[0]!.status).toBe('ok');
  });

  it('deny → blocked（run=failed）', async () => {
    const state = await new WorkflowEngine({
      runId: 'r1',
      definition: gateDef,
      cwd: '/tmp',
      steps: {},
      approval: { decide: () => 'deny' },
    }).run();
    expect(state.status).toBe('failed');
    expect(state.steps[0]!.status).toBe('blocked');
    expect(state.steps[0]!.error).toContain('审批拒绝');
  });

  it('ask + onAsk(true) → ok；onAsk(false) → blocked', async () => {
    const okState = await new WorkflowEngine({
      runId: 'r1',
      definition: gateDef,
      cwd: '/tmp',
      steps: {},
      approval: { decide: () => 'ask', onAsk: () => true },
    }).run();
    expect(okState.steps[0]!.status).toBe('ok');
    const blockState = await new WorkflowEngine({
      runId: 'r2',
      definition: gateDef,
      cwd: '/tmp',
      steps: {},
      approval: { decide: () => 'ask', onAsk: () => false },
    }).run();
    expect(blockState.steps[0]!.status).toBe('blocked');
  });

  it('无 handler / ask 无确认回调 → fail-closed 落 blocked', async () => {
    const noHandler = await new WorkflowEngine({ runId: 'r1', definition: gateDef, cwd: '/tmp', steps: {} }).run();
    expect(noHandler.steps[0]!.status).toBe('blocked');
    const noAsk = await new WorkflowEngine({
      runId: 'r2',
      definition: gateDef,
      cwd: '/tmp',
      steps: {},
      approval: { decide: () => 'ask' },
    }).run();
    expect(noAsk.steps[0]!.status).toBe('blocked');
  });
});

describe('并发闸与失控保护', () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function overlapRunner() {
    let active = 0;
    let maxActive = 0;
    const runners: WorkflowStepRunners = {
      prompt: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(40);
        active -= 1;
        return { ok: true };
      },
    };
    return { runners, maxActive: () => maxActive };
  }

  const parallelDef = (maxConcurrency: number) =>
    def(
      [
        { id: 'a', type: 'prompt', prompt: 'a', dependsOn: [] },
        { id: 'b', type: 'prompt', prompt: 'b', dependsOn: [] },
        { id: 'c', type: 'prompt', prompt: 'c', dependsOn: [] },
      ],
      { maxConcurrency },
    );

  it('无依赖步骤并发执行，且不超过 maxConcurrency（=2）', async () => {
    const { runners, maxActive } = overlapRunner();
    const state = await new WorkflowEngine({
      runId: 'r1',
      definition: parallelDef(2),
      cwd: '/tmp',
      steps: runners,
    }).run();
    expect(state.status).toBe('ok');
    expect(maxActive()).toBe(2);
  });

  it('maxConcurrency=1 → 完全串行（maxActive=1）', async () => {
    const { runners, maxActive } = overlapRunner();
    await new WorkflowEngine({ runId: 'r1', definition: parallelDef(1), cwd: '/tmp', steps: runners }).run();
    expect(maxActive()).toBe(1);
  });

  it('单步超时 → failed（超时文案）', async () => {
    const runners: WorkflowStepRunners = {
      prompt: (input) =>
        new Promise<WorkflowStepOutcome>((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    const state = await new WorkflowEngine({
      runId: 'r1',
      definition: def([{ id: 'a', type: 'prompt', prompt: 'a', timeoutMs: 30 }]),
      cwd: '/tmp',
      steps: runners,
    }).run();
    expect(state.steps[0]!.status).toBe('failed');
    expect(state.steps[0]!.error).toContain('超时');
  });

  it('取消信号 → run=cancelled，未启动步骤落 skipped', async () => {
    const controller = new AbortController();
    const runners: WorkflowStepRunners = {
      prompt: async (input) => {
        if (input.step.id === 'b') {
          return new Promise<WorkflowStepOutcome>((_resolve, reject) => {
            input.signal.addEventListener('abort', () => reject(new Error('cancelled')));
          });
        }
        setTimeout(() => controller.abort(), 10);
        return { ok: true };
      },
    };
    const state = await new WorkflowEngine({
      runId: 'r1',
      definition: def([
        { id: 'a', type: 'prompt', prompt: 'a' },
        { id: 'b', type: 'prompt', prompt: 'b' },
        { id: 'c', type: 'prompt', prompt: 'c' },
      ]),
      cwd: '/tmp',
      steps: runners,
      signal: controller.signal,
    }).run();
    expect(state.status).toBe('cancelled');
    expect(statusOf(state, 'a')).toBe('ok');
    expect(statusOf(state, 'c')).toBe('skipped');
  });

  it('递归深度：assertWorkflowDepth(0) 放行，(1) 拒绝；引擎 depth=1 启动即抛', () => {
    expect(() => assertWorkflowDepth(0)).not.toThrow();
    expect(() => assertWorkflowDepth(1)).toThrow(/recursion rejected/);
    expect(
      () =>
        new WorkflowEngine({
          runId: 'r1',
          definition: def([{ id: 'a', type: 'prompt', prompt: 'a' }]),
          cwd: '/tmp',
          steps: {},
          depth: 1,
        }),
    ).toThrow(/recursion rejected/);
  });
});

describe('断点续跑（写台账 → 新引擎按投影恢复）', () => {
  let seq = 0;
  function loaded(payload: WorkflowRunEventPayload): LoadedExtensionEvent {
    seq += 1;
    return {
      event: {
        v: 1,
        seq,
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
        type: WORKFLOW_RUN_EVENT_TYPE,
        payload: workflowRunEventPayload(payload),
      },
      active: true,
    };
  }

  it('已 ok 的步骤跳过，running/pending 步骤重跑', async () => {
    const d = def([
      { id: 'a', type: 'prompt', prompt: 'a' },
      { id: 'b', type: 'prompt', prompt: 'b' },
      { id: 'c', type: 'prompt', prompt: 'c' },
    ]);
    // 模拟上一世崩溃时的台账：a 完成、b 中断在 running
    const events: LoadedExtensionEvent[] = [
      loaded({ runId: 'r1', workflow: 'demo', phase: 'started', status: 'running' }),
      loaded({
        runId: 'r1',
        workflow: 'demo',
        phase: 'step',
        status: 'running',
        stepId: 'a',
        stepType: 'prompt',
        stepTitle: 'a',
        attempt: 1,
      }),
      loaded({
        runId: 'r1',
        workflow: 'demo',
        phase: 'step',
        status: 'ok',
        stepId: 'a',
        stepType: 'prompt',
        stepTitle: 'a',
      }),
      loaded({
        runId: 'r1',
        workflow: 'demo',
        phase: 'step',
        status: 'running',
        stepId: 'b',
        stepType: 'prompt',
        stepTitle: 'b',
        attempt: 1,
      }),
    ];
    const resume = projectWorkflowRuns(events).find((r) => r.runId === 'r1')!;
    expect(statusOf(resume, 'a')).toBe('ok');
    expect(statusOf(resume, 'b')).toBe('running');

    const { calls, runs } = recorder();
    const state = await new WorkflowEngine({ runId: 'r1', definition: d, cwd: '/tmp', steps: runs, resume }).run();
    expect(calls).toEqual(['b', 'c']); // a 不重跑
    expect(statusOf(state, 'a')).toBe('ok');
    expect(statusOf(state, 'b')).toBe('ok');
    expect(statusOf(state, 'c')).toBe('ok');
    expect(state.status).toBe('ok');
  });

  it('上一世终态（failed/blocked/skipped）保持不变，不重跑', async () => {
    const d = def([
      { id: 'a', type: 'prompt', prompt: 'a' },
      { id: 'b', type: 'prompt', prompt: 'b' },
    ]);
    const events: LoadedExtensionEvent[] = [
      loaded({ runId: 'r2', workflow: 'demo', phase: 'started', status: 'running' }),
      loaded({
        runId: 'r2',
        workflow: 'demo',
        phase: 'step',
        status: 'running',
        stepId: 'a',
        stepType: 'prompt',
        stepTitle: 'a',
        attempt: 1,
      }),
      loaded({
        runId: 'r2',
        workflow: 'demo',
        phase: 'step',
        status: 'failed',
        stepId: 'a',
        stepType: 'prompt',
        stepTitle: 'a',
        error: 'boom',
      }),
    ];
    const resume = projectWorkflowRuns(events).find((r) => r.runId === 'r2')!;
    const { calls, runs } = recorder();
    const state = await new WorkflowEngine({ runId: 'r2', definition: d, cwd: '/tmp', steps: runs, resume }).run();
    expect(calls).toEqual([]); // a 已 failed（终态），b blocked（依赖未成功）→ 无步骤执行
    expect(statusOf(state, 'a')).toBe('failed');
    expect(statusOf(state, 'b')).toBe('blocked');
    expect(state.status).toBe('failed');
  });
});

describe('扩展事件落账与重放（红线①：不落盘的就不显示）', () => {
  it('SessionWriter 落盘 → loadSession → 投影与引擎内存态一致', async () => {
    const dir = tmpDir();
    const writer = SessionWriter.create(dir, { sessionId: 's1' }, { fsync: false });
    const { runs } = recorder();
    try {
      const engine = new WorkflowEngine({
        runId: 'r1',
        definition: def([
          { id: 'a', type: 'prompt', prompt: 'a' },
          { id: 'b', type: 'tool', tool: 'read', args: {} },
        ]),
        cwd: '/tmp',
        steps: runs,
        writer,
      });
      const memory = await engine.run();
      writer.close();

      const session = loadSession(dir);
      const events = readWorkflowRunEvents(session.extensionEvents);
      expect(events.length).toBeGreaterThan(0);
      const projected = findWorkflowRun(session.extensionEvents, 'r1')!;
      expect(projected.status).toBe(memory.status);
      expect(projected.workflow).toBe('demo');
      expect(projected.steps.map((s) => ({ id: s.stepId, status: s.status }))).toEqual(
        memory.steps.map((s) => ({ id: s.stepId, status: s.status })),
      );
      expect(latestWorkflowRun(session.extensionEvents)!.runId).toBe('r1');
    } finally {
      // writer 可能已在上面 close；再次 close 幂等（内部 closed 守卫）
      try {
        writer.close();
      } catch {
        /* ignore */
      }
    }
  });

  it('validator fail-closed：step 事件缺 stepType / 非法 status 被拒', () => {
    registerWorkflowRunEventType();
    const validator = extensionEventTypes.get(WORKFLOW_RUN_EVENT_TYPE)!.validator;
    expect(validator({})).toBe(false);
    expect(validator({ runId: 'r', workflow: 'w', phase: 'started', status: 'running' })).toBe(true);
    expect(validator({ runId: 'r', workflow: 'w', phase: 'step', status: 'running', stepId: 'a' })).toBe(false);
    expect(
      validator({ runId: 'r', workflow: 'w', phase: 'step', status: 'running', stepId: 'a', stepType: 'prompt' }),
    ).toBe(true);
    expect(
      validator({ runId: 'r', workflow: 'w', phase: 'step', status: 'nope', stepId: 'a', stepType: 'prompt' }),
    ).toBe(false);
    // 读侧：非法行返回 null
    const bad = JSON.stringify({
      v: 1,
      seq: 1,
      ts: new Date().toISOString(),
      type: WORKFLOW_RUN_EVENT_TYPE,
      payload: { runId: 'r' },
    });
    expect(parseExtensionEventLine(bad)).toBeNull();
    const good = JSON.stringify({
      v: 1,
      seq: 2,
      ts: new Date().toISOString(),
      type: WORKFLOW_RUN_EVENT_TYPE,
      payload: { runId: 'r', workflow: 'w', phase: 'settled', status: 'ok' },
    });
    expect(parseExtensionEventLine(good)?.type).toBe(WORKFLOW_RUN_EVENT_TYPE);
  });

  it('输出摘要截断 + 脱敏后落盘（内存态与落盘一致）', async () => {
    const dir = tmpDir();
    const writer = SessionWriter.create(dir, { sessionId: 's1' }, { fsync: false });
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const { runs } = recorder({ a: () => ({ ok: true, output: `${secret} ${'x'.repeat(1000)}` }) });
    try {
      const engine = new WorkflowEngine({
        runId: 'r1',
        definition: def([{ id: 'a', type: 'prompt', prompt: 'a' }]),
        cwd: '/tmp',
        steps: runs,
        writer,
      });
      const memory = await engine.run();
      writer.close();
      const session = loadSession(dir);
      const projected = findWorkflowRun(session.extensionEvents, 'r1')!;
      expect(projected.steps[0]!.outputPreview!.length).toBeLessThanOrEqual(500);
      expect(projected.steps[0]!.outputPreview).not.toContain(secret);
      expect(memory.steps[0]!.outputPreview).toBe(projected.steps[0]!.outputPreview);
    } finally {
      try {
        writer.close();
      } catch {
        /* ignore */
      }
    }
  });

  it('appendWorkflowRunEvent 无 writer 时静默跳过（观测面不阻断）', () => {
    expect(() =>
      appendWorkflowRunEvent(undefined, { runId: 'r', workflow: 'w', phase: 'settled', status: 'ok' }),
    ).not.toThrow();
  });
});
