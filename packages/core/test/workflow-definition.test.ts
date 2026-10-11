// A14 工作流定义/发现/命令面测试：
//   - 定义解析 fail-closed（未知键/缺字段/越界/图非法一律抛错）；
//   - dependsOn 缺省链式 vs 显式空数组（可并发）；
//   - 项目/用户目录发现（项目覆盖同名、非法文件进 errors、排序确定）；
//   - `/workflow` 扩展命令注册进 core 能力面（list/start/status/cancel）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverWorkflowDefinitions,
  findCoreCommand,
  parseCoreCommand,
  parseWorkflowDefinition,
  registerWorkflowCommand,
  registerWorkflowRunEventType,
  runWorkflowCommand,
  workflowDefinitionsDir,
  resetCoreCommands,
  listCoreCommands,
  WORKFLOW_DEFAULT_MAX_CONCURRENCY,
  WORKFLOW_DEFAULT_STEP_TIMEOUT_MS,
  WORKFLOW_MAX_CONCURRENCY_CEILING,
  WORKFLOW_MAX_RETRIES,
  WORKFLOW_MAX_STEPS,
  type WorkflowDefinition,
  type WorkflowRunState,
} from '../src/index.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-workflow-def-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetCoreCommands();
});

function rawDef(steps: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'demo', description: '演示工作流', steps, ...over };
}
function promptStep(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'prompt', prompt: `跑 ${id}`, ...over };
}

describe('工作流定义解析（fail-closed）', () => {
  it('最小定义：缺省值归一（链式依赖/策略 stop/并发 4/超时 120s/title=id）', () => {
    const def = parseWorkflowDefinition(rawDef([promptStep('a'), promptStep('b'), promptStep('c')]));
    expect(def.name).toBe('demo');
    expect(def.version).toBe('1');
    expect(def.failurePolicy).toBe('stop');
    expect(def.maxConcurrency).toBe(WORKFLOW_DEFAULT_MAX_CONCURRENCY);
    expect(def.maxRetries).toBe(1);
    expect(def.steps.map((s) => s.dependsOn)).toEqual([[], ['a'], ['b']]);
    expect(def.steps[0]!.timeoutMs).toBe(WORKFLOW_DEFAULT_STEP_TIMEOUT_MS);
    expect(def.steps[0]!.title).toBe('a');
    expect(def.steps[0]!.writeMode).toBe('readonly');
  });

  it('显式 dependsOn: [] 表示无依赖（可并发），不回落为链式', () => {
    const def = parseWorkflowDefinition(
      rawDef([promptStep('a', { dependsOn: [] }), promptStep('b', { dependsOn: [] })]),
    );
    expect(def.steps.map((s) => s.dependsOn)).toEqual([[], []]);
  });

  const badCases: Array<[string, Record<string, unknown>]> = [
    ['未知顶层键', rawDef([promptStep('a')], { bogus: 1 })],
    ['缺 description', { name: 'demo', steps: [promptStep('a')] }],
    ['非法 name', rawDef([promptStep('a')], { name: 'Demo_X' })],
    ['steps 为空', rawDef([])],
    ['未知步骤类型', rawDef([{ id: 'a', type: 'phase', prompt: 'x' }])],
    ['prompt 步骤缺 prompt', rawDef([{ id: 'a', type: 'prompt' }])],
    ['tool 步骤缺 tool', rawDef([{ id: 'a', type: 'tool' }])],
    ['subagent 步骤缺 prompt', rawDef([{ id: 'a', type: 'subagent' }])],
    ['步骤 id 重复', rawDef([promptStep('a'), promptStep('a', { dependsOn: [] })])],
    ['依赖未知步骤', rawDef([promptStep('a', { dependsOn: ['ghost'] })])],
    ['自依赖', rawDef([promptStep('a', { dependsOn: ['a'] })])],
    ['依赖环', rawDef([promptStep('a', { dependsOn: ['b'] }), promptStep('b', { dependsOn: ['a'] })])],
    ['步骤未知键', rawDef([promptStep('a', { whatever: 1 })])],
    ['并发 0', rawDef([promptStep('a')], { maxConcurrency: 0 })],
    ['并发超天花板', rawDef([promptStep('a')], { maxConcurrency: WORKFLOW_MAX_CONCURRENCY_CEILING + 1 })],
    ['重试超上限', rawDef([promptStep('a')], { maxRetries: WORKFLOW_MAX_RETRIES + 1 })],
    ['超时越界', rawDef([promptStep('a', { timeoutMs: 0 })])],
    ['策略非法', rawDef([promptStep('a')], { failurePolicy: 'pause' })],
  ];
  for (const [label, raw] of badCases) {
    it(`拒绝：${label}`, () => {
      expect(() => parseWorkflowDefinition(raw)).toThrow();
    });
  }

  it('步骤数超过上限即拒（不截断）', () => {
    const steps = Array.from({ length: WORKFLOW_MAX_STEPS + 1 }, (_, i) => promptStep(`s${i}`, { dependsOn: [] }));
    expect(() => parseWorkflowDefinition(rawDef(steps))).toThrow(/exceeds limit/);
  });
});

describe('工作流定义发现（项目覆盖用户 / 非法文件进 errors）', () => {
  function writeDef(root: string, file: string, content: unknown): string {
    const dir = workflowDefinitionsDir(root);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, file);
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  it('项目覆盖用户同名；非法 JSON 进 errors；结果按名称排序', () => {
    const cwd = tmpDir('h2-wf-cwd-');
    const home = tmpDir('h2-wf-home-');
    writeDef(cwd, 'a.json', { name: 'alpha', description: '项目 alpha', steps: [promptStep('s', { dependsOn: [] })] });
    writeDef(cwd, 'z.json', { name: 'zeta', description: '项目 zeta', steps: [promptStep('s', { dependsOn: [] })] });
    writeDef(cwd, 'broken.json', { name: 'bad', steps: 'not-an-array' });
    writeDef(home, 'a.json', { name: 'alpha', description: '用户 alpha', steps: [promptStep('s', { dependsOn: [] })] });
    writeDef(home, 'u.json', { name: 'user-only', description: '仅用户', steps: [promptStep('s', { dependsOn: [] })] });

    const result = discoverWorkflowDefinitions({ cwd, home });
    expect(result.definitions.map((d) => d.definition.name)).toEqual(['alpha', 'user-only', 'zeta']);
    const alpha = result.definitions.find((d) => d.definition.name === 'alpha')!;
    expect(alpha.scope).toBe('project');
    expect(alpha.definition.description).toBe('项目 alpha');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.path.endsWith('broken.json')).toBe(true);
  });

  it('目录不存在 → 空结果、无错误', () => {
    const result = discoverWorkflowDefinitions({ cwd: tmpDir('h2-wf-none-'), home: tmpDir('h2-wf-none2-') });
    expect(result.definitions).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe('/workflow 命令面（扩展命令注册进 core 能力面）', () => {
  function runtime(over: Partial<Parameters<typeof registerWorkflowCommand>[0]> = {}) {
    return {
      listDefinitions: () => [],
      start: async () => ({ runId: 'run-1' }),
      status: () => undefined as WorkflowRunState | undefined,
      cancel: () => false,
      ...over,
    };
  }

  it('注册后进入命令分发面与 describeCapabilities（source=extension）；disposer 注销', () => {
    registerWorkflowRunEventType();
    const dispose = registerWorkflowCommand(runtime());
    const cmd = findCoreCommand('workflow');
    expect(cmd?.source).toBe('extension');
    expect(cmd?.group).toBe('调度');
    expect(listCoreCommands().some((c) => c.id === 'workflow')).toBe(true);
    dispose();
    expect(findCoreCommand('workflow')).toBeUndefined();
  });

  it('重复注册同名命令 → fail-closed 抛错', () => {
    registerWorkflowCommand(runtime());
    expect(() => registerWorkflowCommand(runtime())).toThrow(/already registered/);
  });

  it('list / start / status / cancel / 未知子命令 的输出文案', async () => {
    const out: string[] = [];
    const ctx = { print: (t: string) => out.push(t) };
    await runWorkflowCommand(
      ctx,
      { rest: '' },
      runtime({
        listDefinitions: () => [
          {
            definition: { name: 'demo', description: '演示' } as unknown as WorkflowDefinition,
            path: 'p',
            scope: 'project' as const,
          },
        ],
      }),
    );
    expect(out.some((l) => l.includes('demo') && l.includes('project'))).toBe(true);

    out.length = 0;
    const started = runtime({ start: async (name) => ({ runId: `run-${name}` }) });
    await runWorkflowCommand(ctx, { rest: 'start demo' }, started);
    expect(out).toEqual(['已启动工作流 demo：runId=run-demo']);

    out.length = 0;
    await runWorkflowCommand(ctx, { rest: 'start' }, started);
    expect(out[0]).toContain('error:');

    out.length = 0;
    await runWorkflowCommand(
      ctx,
      { rest: 'status r1' },
      runtime({
        status: (id) => ({
          runId: id ?? 'x',
          workflow: 'demo',
          status: 'ok',
          steps: [{ stepId: 'a', type: 'prompt', title: 'a', status: 'ok', attempts: 1 }],
        }),
      }),
    );
    expect(out[0]).toContain('r1');
    expect(out[1]).toContain('[✓] a');

    out.length = 0;
    await runWorkflowCommand(ctx, { rest: 'cancel r1' }, runtime({ cancel: () => true }));
    expect(out[0]).toContain('已请求取消 r1');
    out.length = 0;
    await runWorkflowCommand(ctx, { rest: 'cancel ghost' }, runtime({ cancel: () => false }));
    expect(out[0]).toContain('error:');

    out.length = 0;
    await runWorkflowCommand(ctx, { rest: 'bogus' }, runtime());
    expect(out[0]).toContain('未知子命令');
  });

  it('start 抛错 → error 行（不冒泡）', async () => {
    const out: string[] = [];
    await runWorkflowCommand(
      { print: (t) => out.push(t) },
      { rest: 'start nope' },
      runtime({
        start: async () => {
          throw new Error('未找到定义');
        },
      }),
    );
    expect(out[0]).toContain('error: 启动失败：未找到定义');
  });

  it('parseCoreCommand 能把 /workflow 解析为扩展命令 id', () => {
    registerWorkflowCommand(runtime());
    expect(parseCoreCommand('/workflow status x')?.id).toBe('workflow');
  });
});
