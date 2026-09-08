// S1：取消后不执行（executor-cancel-before-start）。
// 审计基线：executor.ts:96-101（raceAbort 先求值 def.execute 再检查 signal）、
//           123-180（runWave 无逐调用取消前置门）——「取消后后续工具仍可能先 execute」。
// 目标语义：
//   - 已取消的 execute 计数 0（不启动副作用）；
//   - 审批 allow 到达同时取消：未启动则该 callId 不再执行（计数 0），已启动只记录一次；
//   - 不合作工具（未声明取消保证）在取消竞态下结果归一为 unknown（≠ cancelled）；
//   - runWave 调度约束（safe 并行 / unsafe 独占 / lockKey 串行）在取消下保持；
//   - 执行生命周期观察：真正开始才 onExecuteStart；任何结果（含未启动取消）都 onExecuteEnd。
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolExecutor, type ToolExecutionRequest } from '../src/tools/executor.js';
import type { ApprovalHandler, ToolDefinition } from '../src/tools/types.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeTool(partial: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    description: 'test tool',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ output: 'done' }),
    ...partial,
  };
}

const req = (callId: string, tool: string, args: unknown = {}): ToolExecutionRequest => ({ callId, tool, args });
const cwd = process.cwd();

describe('executor-cancel-before-start（取消后不执行副作用）', () => {
  it('信号已取消时 execute 不启动工具（计数 0），结果 error=cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    let executed = 0;
    const reg = new ToolRegistry();
    reg.register(
      makeTool({ name: 'counter', execute: async () => { executed += 1; return { output: 'x' }; } }),
    );
    const r = await new ToolExecutor(reg).execute(req('c1', 'counter'), { signal: ac.signal, cwd });
    expect(executed).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('cancelled');
  });

  it('审批后竞态：allow 到达同时取消 → 未启动则不执行（计数 0）', async () => {
    const ac = new AbortController();
    let executed = 0;
    const reg = new ToolRegistry();
    reg.register(
      makeTool({ name: 'write_guard', execute: async () => { executed += 1; return { output: 'x' }; } }),
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const approval: ApprovalHandler = {
      decide: () => 'ask',
      onAsk: () => gate.then(() => true),
    };
    const p = new ToolExecutor(reg, approval).execute(req('c1', 'write_guard'), { signal: ac.signal, cwd });
    await sleep(10);
    ac.abort(); // 取消先到
    release(); // allow 随后到达
    const r = await p;
    expect(executed).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('cancelled');
  });

  it('已启动的 execute 只记录一次（取消在信号前启动，不重复执行）', async () => {
    const ac = new AbortController();
    let executed = 0;
    const reg = new ToolRegistry();
    reg.register(
      makeTool({
        name: 'coop',
        cancelGuaranteed: true,
        execute: async (_a, ctx) => {
          executed += 1;
          await sleep(50);
          ctx.signal.throwIfAborted();
          return { output: 'x' };
        },
      }),
    );
    const p = new ToolExecutor(reg).execute(req('c1', 'coop'), { signal: ac.signal, cwd });
    await sleep(10);
    ac.abort();
    const r = await p;
    expect(executed).toBe(1); // 只启动一次
    expect(r.ok).toBe(false);
    expect(r.error).toBe('cancelled');
  });

  it('不合作工具（未声明 cancelGuaranteed）取消归一为 unknown（≠ cancelled）', async () => {
    const ac = new AbortController();
    let started = 0;
    const reg = new ToolRegistry();
    reg.register(
      makeTool({
        name: 'stubborn',
        execute: async () => {
          started += 1;
          return new Promise<{ output?: string; error?: string }>(() => {}); // 忽略 signal，永不自行终止
        },
      }),
    );
    const p = new ToolExecutor(reg).execute(req('c1', 'stubborn'), { signal: ac.signal, cwd });
    await sleep(10);
    ac.abort();
    const r = await p;
    expect(started).toBe(1); // 已启动但无法保证停止
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown');
  });

  it('runWave：取消发生在排到前 → 该工具不启动（计数 0）', async () => {
    const ac = new AbortController();
    const order: string[] = [];
    const reg = new ToolRegistry();
    reg.register(
      makeTool({ name: 'first', execute: async () => { order.push('first'); await sleep(30); return { output: '1' }; } }),
    );
    let second = 0;
    reg.register(
      makeTool({ name: 'second', execute: async () => { second += 1; order.push('second'); return { output: '2' }; } }),
    );
    const p = new ToolExecutor(reg).runWave([req('a', 'first'), req('b', 'second')], { signal: ac.signal, cwd });
    await sleep(10);
    ac.abort();
    const results = await p;
    expect(order).toEqual(['first']); // second 不得启动
    expect(second).toBe(0);
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ callId: 'b', ok: false, error: 'cancelled' });
  });

  it('runWave：已取消的 safe 并行批不启动任何工具（计数 0，结果一一对应）', async () => {
    const ac = new AbortController();
    let executed = 0;
    const reg = new ToolRegistry();
    reg.register(
      makeTool({
        name: 'safe_ro',
        concurrencySafe: true,
        execute: async () => { executed += 1; return { output: 'x' }; },
      }),
    );
    ac.abort();
    const results = await new ToolExecutor(reg).runWave(
      [req('a', 'safe_ro'), req('b', 'safe_ro'), req('c', 'safe_ro')],
      { signal: ac.signal, cwd },
    );
    expect(executed).toBe(0);
    expect(results.map((r) => r.error)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(results.map((r) => r.callId)).toEqual(['a', 'b', 'c']);
  });

  it('取消下 unsafe 独占顺序保持：先排工具先完成、后排工具不启动', async () => {
    const ac = new AbortController();
    const order: string[] = [];
    const reg = new ToolRegistry();
    reg.register(
      makeTool({ name: 'slow_unsafe', execute: async () => { order.push('first'); await sleep(40); return { output: '1' }; } }),
    );
    let second = 0;
    reg.register(
      makeTool({ name: 'second_unsafe', execute: async () => { second += 1; order.push('second'); return { output: '2' }; } }),
    );
    const p = new ToolExecutor(reg).runWave([req('a', 'slow_unsafe'), req('b', 'second_unsafe')], {
      signal: ac.signal,
      cwd,
    });
    await sleep(5);
    ac.abort();
    const results = await p;
    expect(results.map((r) => r.callId)).toEqual(['a', 'b']);
    expect(order).toEqual(['first']);
    expect(second).toBe(0);
    expect(results[1]).toMatchObject({ ok: false, error: 'cancelled' });
  });
});

describe('executor 执行生命周期观察（S3/S7 消费）', () => {
  it('启动前取消：observer 只收 end（cancelled），不收 start；计数 0', async () => {
    const ac = new AbortController();
    let executed = 0;
    const events: string[] = [];
    const reg = new ToolRegistry();
    reg.register(
      makeTool({ name: 'never', execute: async () => { executed += 1; return { output: 'x' }; } }),
    );
    ac.abort();
    const r = await new ToolExecutor(reg).execute(req('c1', 'never'), {
      signal: ac.signal,
      cwd,
      observer: {
        onExecuteStart: () => events.push('start'),
        onExecuteEnd: () => events.push('end'),
      },
    });
    expect(executed).toBe(0);
    expect(r.error).toBe('cancelled');
    expect(events).toEqual(['end']);
  });

  it('成功路径：start → end(ok)；取消路径：start → end(cancelled)', async () => {
    const ac = new AbortController();
    const reg = new ToolRegistry();
    reg.register(
      makeTool({
        name: 'obs',
        cancelGuaranteed: true,
        execute: async (_a, ctx) => { await sleep(40); ctx.signal.throwIfAborted(); return { output: 'x' }; },
      }),
    );
    const events: string[] = [];
    const env = {
      signal: ac.signal,
      cwd,
      observer: {
        onExecuteStart: (r: ToolExecutionRequest) => events.push(`start:${r.callId}`),
        onExecuteEnd: (r: ToolExecutionRequest, res: { ok: boolean; error?: string }) =>
          events.push(`end:${r.callId}:${res.ok}:${res.error ?? ''}`),
      },
    };
    const p = new ToolExecutor(reg).execute(req('c1', 'obs'), env);
    await sleep(5);
    ac.abort();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error).toBe('cancelled');
    expect(events).toEqual(['start:c1', 'end:c1:false:cancelled']);
  });
});