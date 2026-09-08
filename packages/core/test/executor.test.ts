import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools/registry.js';
import { DENIED_MESSAGE, ToolExecutor, type ToolExecutionRequest } from '../src/tools/executor.js';
import type { ApprovalHandler, ToolDefinition } from '../src/tools/types.js';

const env = { signal: new AbortController().signal, cwd: process.cwd() };
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

describe('ToolExecutor.execute', () => {
  it('allow：执行成功并统一结果形态（ok/output/durationMs）', async () => {
    const reg = new ToolRegistry();
    reg.register(makeTool({ name: 'ok_tool', execute: async () => ({ output: 'payload' }) }));
    const r = await new ToolExecutor(reg).execute(req('c1', 'ok_tool'), env);
    expect(r.ok).toBe(true);
    expect(r.output).toBe('payload');
    expect(r.error).toBeUndefined();
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('deny：不执行工具，结果 error=denied by approval policy', async () => {
    let executed = 0;
    const reg = new ToolRegistry();
    reg.register(makeTool({ name: 'guarded', execute: async () => { executed += 1; return { output: 'x' }; } }));
    const approval: ApprovalHandler = { decide: () => 'deny' };
    const r = await new ToolExecutor(reg, approval).execute(req('c1', 'guarded'), env);
    expect(executed).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(DENIED_MESSAGE);
  });

  it('ask：onAsk 返回 true 放行 / false 拒绝；未提供 onAsk 时按拒绝处理', async () => {
    let executed = 0;
    const reg = new ToolRegistry();
    reg.register(makeTool({ name: 'asked', execute: async () => { executed += 1; return { output: 'x' }; } }));

    const yes: ApprovalHandler = { decide: () => 'ask', onAsk: () => true };
    expect((await new ToolExecutor(reg, yes).execute(req('c1', 'asked'), env)).ok).toBe(true);
    expect(executed).toBe(1);

    const no: ApprovalHandler = { decide: () => 'ask', onAsk: async () => false };
    const denied = await new ToolExecutor(reg, no).execute(req('c2', 'asked'), env);
    expect(executed).toBe(1);
    expect(denied.error).toBe(DENIED_MESSAGE);

    const noCallback: ApprovalHandler = { decide: () => 'ask' };
    expect((await new ToolExecutor(reg, noCallback).execute(req('c3', 'asked'), env)).error).toBe(DENIED_MESSAGE);
    expect(executed).toBe(1);
  });

  it('超时中断：timeoutMs 到期后结果 error 含 tool timeout，且 durationMs 远小于工具时长', async () => {
    const reg = new ToolRegistry();
    reg.register(
      makeTool({
        name: 'slow',
        execute: async () => {
          await sleep(2000);
          return { output: 'finished' };
        },
        timeoutMs: 60,
      }),
    );
    const r = await new ToolExecutor(reg).execute(req('c1', 'slow'), env);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/tool timeout after 60ms/);
    expect(r.durationMs).toBeLessThan(1000);
  }, 5000);

  it('外部 signal 取消：执行中触发取消 → error=cancelled', async () => {
    const ac = new AbortController();
    const reg = new ToolRegistry();
    reg.register(
      makeTool({
        name: 'cancellable',
        // 观察 signal 并 throwIfAborted 即保证及时停止 → 取消归一为 cancelled（S1 契约）
        cancelGuaranteed: true,
        execute: async (_args, ctx) => {
          await sleep(50);
          ctx.signal.throwIfAborted();
          return { output: 'finished' };
        },
      }),
    );
    const p = new ToolExecutor(reg).execute(req('c1', 'cancellable'), { signal: ac.signal, cwd: env.cwd });
    setTimeout(() => ac.abort(), 10);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error).toBe('cancelled');
  });

  it('工具抛异常：兜底捕获为 ok:false（进程不崩）', async () => {
    const reg = new ToolRegistry();
    reg.register(makeTool({ name: 'throwing', execute: () => { throw new Error('boom inside'); } }));
    const r = await new ToolExecutor(reg).execute(req('c1', 'throwing'), env);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('boom inside');
  });

  it('P2-2 回归：decide 抛异常 → 该调用 ok:false，不执行工具、不击穿调用方', async () => {
    let executed = 0;
    const reg = new ToolRegistry();
    reg.register(makeTool({ name: 'guarded', execute: async () => { executed += 1; return { output: 'x' }; } }));
    const approval: ApprovalHandler = { decide: () => { throw new Error('approval storage down'); } };
    const r = await new ToolExecutor(reg, approval).execute(req('c1', 'guarded'), env);
    expect(executed).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('approval callback threw: approval storage down');
  });

  it('P2-2 回归：onAsk 抛异常 → 该调用 ok:false，不执行工具', async () => {
    let executed = 0;
    const reg = new ToolRegistry();
    reg.register(makeTool({ name: 'asked', execute: async () => { executed += 1; return { output: 'x' }; } }));
    const approval: ApprovalHandler = { decide: () => 'ask', onAsk: () => { throw new Error('ui gone'); } };
    const r = await new ToolExecutor(reg, approval).execute(req('c1', 'asked'), env);
    expect(executed).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('approval callback threw: ui gone');
  });

  it('error 与 output 并存：ok=false 但输出保留（供回传模型诊断）', async () => {
    const reg = new ToolRegistry();
    reg.register(makeTool({ name: 'partial', execute: async () => ({ output: 'partial logs', error: 'exit code 1' }) }));
    const r = await new ToolExecutor(reg).execute(req('c1', 'partial'), env);
    expect(r.ok).toBe(false);
    expect(r.output).toBe('partial logs');
    expect(r.error).toBe('exit code 1');
  });
});

describe('ToolExecutor.runWave（并发波次）', () => {
  it('safe 并行总时长显著小于串行；结果顺序与请求一致', async () => {
    const reg = new ToolRegistry();
    reg.register(makeTool({ name: 'safe_slow', concurrencySafe: true, execute: async () => { await sleep(120); return { output: 'x' }; } }));
    const executor = new ToolExecutor(reg);
    const started = performance.now();
    const results = await executor.runWave([req('a', 'safe_slow'), req('b', 'safe_slow'), req('c', 'safe_slow')], env);
    const elapsed = performance.now() - started;
    expect(results.map((r) => r.callId)).toEqual(['a', 'b', 'c']);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(elapsed).toBeLessThan(300); // 串行需 ~360ms
  }, 5000);

  it('unsafe 串行：两个 unsafe 调用总时长 >= 单个时长之和', async () => {
    const reg = new ToolRegistry();
    reg.register(makeTool({ name: 'unsafe_slow', execute: async () => { await sleep(100); return { output: 'x' }; } }));
    const executor = new ToolExecutor(reg);
    const started = performance.now();
    await executor.runWave([req('a', 'unsafe_slow'), req('b', 'unsafe_slow')], env);
    expect(performance.now() - started).toBeGreaterThanOrEqual(190);
  }, 5000);

  it('lockKey：safe 调用同键串行、异键并行', async () => {
    const reg = new ToolRegistry();
    reg.register(
      makeTool({
        name: 'keyed',
        concurrencySafe: true,
        lockKey: (args) => (args as { file: string }).file,
        execute: async () => { await sleep(80); return { output: 'x' }; },
      }),
    );
    const executor = new ToolExecutor(reg);
    const started = performance.now();
    const results = await executor.runWave(
      [req('1', 'keyed', { file: 'a' }), req('2', 'keyed', { file: 'a' }), req('3', 'keyed', { file: 'b' })],
      env,
    );
    const elapsed = performance.now() - started;
    expect(results.map((r) => r.callId)).toEqual(['1', '2', '3']);
    // 同键 a 两次串行（160ms），异键 b 并行（80ms 内完成）→ 总时长 ~160ms 而非 240ms
    expect(elapsed).toBeLessThan(240);
    expect(elapsed).toBeGreaterThanOrEqual(150);
  }, 5000);

  it('混合波次：unsafe 独占打断 safe 并行批，顺序保持', async () => {
    const reg = new ToolRegistry();
    const order: string[] = [];
    reg.register(
      makeTool({
        name: 'safe_fast',
        concurrencySafe: true,
        execute: async () => { await sleep(60); order.push('safe'); return { output: 's' }; },
      }),
    );
    reg.register(
      makeTool({
        name: 'unsafe_fast',
        execute: async () => { await sleep(20); order.push('unsafe'); return { output: 'u' }; },
      }),
    );
    const executor = new ToolExecutor(reg);
    const results = await executor.runWave([req('1', 'safe_fast'), req('2', 'unsafe_fast'), req('3', 'safe_fast')], env);
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    // unsafe 独占：第一个 safe 批完成后才执行，再进入第二个 safe 批
    expect(order).toEqual(['safe', 'unsafe', 'safe']);
  }, 5000);

  it('未知工具：runWave/execute 返回 unknown tool 错误而非抛异常', async () => {
    const executor = new ToolExecutor(new ToolRegistry());
    const results = await executor.runWave([req('x', 'nope')], env);
    expect(results[0]).toMatchObject({ callId: 'x', ok: false, error: 'unknown tool: nope' });
    expect((await executor.execute(req('y', 'nope'), env)).error).toBe('unknown tool: nope');
  });

  it('P2-2 回归：lockKey 抛异常 → 该调用 ok:false 不执行，runWave 不 reject', async () => {
    let executed = 0;
    const reg = new ToolRegistry();
    reg.register(
      makeTool({
        name: 'keyed',
        concurrencySafe: true,
        lockKey: () => { throw new Error('bad key'); },
        execute: async () => { executed += 1; return { output: 'x' }; },
      }),
    );
    const results = await new ToolExecutor(reg).runWave([req('a', 'keyed'), req('b', 'keyed')], env);
    expect(results.map((r) => r.callId)).toEqual(['a', 'b']);
    expect(results.every((r) => r.ok === false && r.error?.includes('lockKey callback threw'))).toBe(true);
    expect(executed).toBe(0);
  });
});
