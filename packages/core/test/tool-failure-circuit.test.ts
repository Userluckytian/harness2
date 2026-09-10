// A1-3 / A1-4 / A1-5 验收测试：
//   A1-3 连续工具失败熔断（stopReason='tool_failures' + 非空 finalText，禁止空回复）
//   A1-4 缺必填参数 → error 带 schema 片段 + 最小正确调用示例
//   A1-5 browser_* 未安装 chromium/playwright → 明确指向 harness2 browser install
// 全部 mock/stub，零 API key、零网络。
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTurn } from '../src/agent/loop.js';
import { MockProvider } from '../src/provider/mock.js';
import { SESSION_LOG_FILE, type AnySessionEvent } from '../src/session/types.js';
import { ToolExecutor, type ToolExecutionRequest } from '../src/tools/executor.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { BrowserPool, BrowserNotInstalledError, createBrowserTools } from '../src/tools/predefined/browser.js';
import { writeTool } from '../src/tools/predefined/write.js';
import type { ToolDefinition } from '../src/tools/types.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-circuit-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function loadEvents(dir: string): AnySessionEvent[] {
  return readFileSync(join(dir, SESSION_LOG_FILE), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AnySessionEvent);
}

function tool(name: string, execute: ToolDefinition['execute']): ToolDefinition {
  return { name, description: `${name} test tool`, parameters: { type: 'object', properties: {} }, execute };
}

/** 连续 n 次调用指定工具的脚本（每次回复无文本，只有工具调用） */
function calls(
  name: string,
  n: number,
): Array<{ text: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }> {
  return Array.from({ length: n }, (_, i) => ({
    text: '',
    toolCalls: [{ id: `c-${i}`, name, arguments: '{}' }],
  }));
}

const env = { signal: new AbortController().signal, cwd: process.cwd() };
const req = (tool: string, args: unknown, callId = 'c1'): ToolExecutionRequest => ({ callId, tool, args });

describe('A1-3 连续工具失败熔断', () => {
  it('连续 5 次工具失败 → stopReason=tool_failures + 非空 finalText（且落盘为 assistant/message）', async () => {
    const dir = tmpDir();
    const provider = new MockProvider(calls('always_fail', 10));
    const registry = new ToolRegistry();
    registry.register(tool('always_fail', async () => ({ error: 'boom: 命令不存在' })));

    const result = await runTurn(dir, { provider, tools: registry, cwd: dir, userText: '查新闻' });

    expect(result.stopReason).toBe('tool_failures');
    expect(result.steps).toBe(5); // 第 5 次连续失败即熔断，不再烧到 maxSteps=25
    expect(result.finalText).toBeDefined();
    expect(result.finalText!.length).toBeGreaterThan(0);
    expect(result.finalText).toContain('连续 5 次工具调用失败');
    expect(result.finalText).toContain('always_fail');
    expect(result.finalText).toContain('boom: 命令不存在');
    expect(provider.consumed).toBe(5);

    // 非空回复必须对用户可见：以 assistant/message 落盘（desktop 事件投影 + CLI 流式都读它）
    const events = loadEvents(dir);
    const assistantTexts = events
      .filter((e): e is Extract<AnySessionEvent, { type: 'assistant/message' }> => e.type === 'assistant/message')
      .map((e) => e.payload.text)
      .filter((t) => t.length > 0);
    expect(assistantTexts).toContain(result.finalText);
    expect(events.at(-1)?.type).toBe('step/end'); // 日志无悬挂
  });

  it('阈值可配置：maxConsecutiveToolFailures=2 时第 2 次连续失败即熔断', async () => {
    const dir = tmpDir();
    const provider = new MockProvider(calls('always_fail', 5));
    const registry = new ToolRegistry();
    registry.register(tool('always_fail', async () => ({ error: 'nope' })));

    const result = await runTurn(dir, {
      provider,
      tools: registry,
      cwd: dir,
      userText: 'x',
      maxConsecutiveToolFailures: 2,
    });
    expect(result.stopReason).toBe('tool_failures');
    expect(result.steps).toBe(2);
    expect(result.finalText).toContain('阈值 2');
  });

  it('一次成功即重置计数：失败/成功交替不会误触熔断', async () => {
    const dir = tmpDir();
    const provider = new MockProvider([
      ...calls('always_fail', 1),
      ...calls('always_ok', 1),
      ...calls('always_fail', 1),
      ...calls('always_ok', 1),
      { text: '查询完成，共 3 条要闻。' },
    ]);
    const registry = new ToolRegistry();
    registry.register(tool('always_fail', async () => ({ error: 'transient' })));
    registry.register(tool('always_ok', async () => ({ output: 'ok' })));

    const result = await runTurn(dir, {
      provider,
      tools: registry,
      cwd: dir,
      userText: 'x',
      maxConsecutiveToolFailures: 2,
    });
    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(5);
    expect(result.finalText).toBe('查询完成，共 3 条要闻。');
  });

  it('阈值 0 = 关闭熔断（只受 maxSteps 约束，兼容旧行为）', async () => {
    const dir = tmpDir();
    const provider = new MockProvider(calls('always_fail', 10));
    const registry = new ToolRegistry();
    registry.register(tool('always_fail', async () => ({ error: 'nope' })));

    const result = await runTurn(dir, {
      provider,
      tools: registry,
      cwd: dir,
      userText: 'x',
      maxSteps: 3,
      maxConsecutiveToolFailures: 0,
    });
    expect(result.stopReason).toBe('max_steps');
    expect(result.steps).toBe(3);
  });

  it('P2-3：超大失败详情先截断再拼进熔断文案（finalText 与 assistant/message 均有界）', async () => {
    const dir = tmpDir();
    const huge = 'E'.repeat(120_000); // 模拟 grep 捕获的超大 error
    const provider = new MockProvider(calls('huge_fail', 6));
    const registry = new ToolRegistry();
    registry.register(tool('huge_fail', async () => ({ error: huge })));

    const result = await runTurn(dir, { provider, tools: registry, cwd: dir, userText: 'x' });

    expect(result.stopReason).toBe('tool_failures');
    expect(result.finalText).toBeDefined();
    expect(result.finalText!.length).toBeGreaterThan(0);
    expect(result.finalText!.length).toBeLessThan(1000); // 不再随 error 线性膨胀
    expect(result.finalText).toContain('连续 5 次工具调用失败');
    expect(result.finalText).toContain('已截断');
    expect(result.finalText).toContain('原文 120000 字符');
    // 落盘 assistant/message 同样有界：下一轮模型上下文不会灌入 MB 级失败详情
    const assistant = loadEvents(dir).find(
      (e): e is Extract<AnySessionEvent, { type: 'assistant/message' }> =>
        e.type === 'assistant/message' && e.payload.text.includes('已截断'),
    );
    expect(assistant).toBeDefined();
    expect(assistant!.payload.text).toBe(result.finalText);
  });
});

describe('A1-4 缺必填参数：schema 片段 + 最小正确调用示例', () => {
  it('write 漏 file_path → error 含该参数 schema 与最小示例，且不执行写入', async () => {
    const dir = tmpDir();
    const registry = new ToolRegistry();
    registry.register(writeTool);
    const executor = new ToolExecutor(registry);

    const r = await executor.execute(req('write', { content: '你好' }), { ...env, cwd: dir });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('缺少必填参数');
    expect(r.error).toContain('"file_path"');
    expect(r.error).toContain('参数 schema 片段');
    expect(r.error).toContain('"file_path":{"type":"string"');
    expect(r.error).toContain('最小正确调用示例');
    expect(r.error).toContain('"file_path":"<string>"');
    expect(r.error).toContain('"content":"<string>"');
    expect(readdirSync(dir)).toEqual([]); // 参数非法 → 未执行写入
  });

  it('write 漏 content → 同样给出 content 的 schema 与示例', async () => {
    const registry = new ToolRegistry();
    registry.register(writeTool);
    const r = await new ToolExecutor(registry).execute(req('write', { file_path: 'a.txt' }), {
      ...env,
      cwd: tmpDir(),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('"content"');
    expect(r.error).toContain('最小正确调用示例');
  });

  it('参数完整时校验放行，write 真实执行', async () => {
    const dir = tmpDir();
    const registry = new ToolRegistry();
    registry.register(writeTool);
    const r = await new ToolExecutor(registry).execute(req('write', { file_path: 'ok.txt', content: 'hi' }), {
      ...env,
      cwd: dir,
    });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, 'ok.txt'), 'utf8')).toBe('hi');
  });

  it('参数不是对象（null/数组）→ 错误里带必填清单与示例', async () => {
    const registry = new ToolRegistry();
    registry.register(writeTool);
    const r = await new ToolExecutor(registry).execute(req('write', null), { ...env, cwd: tmpDir() });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('arguments must be an object');
    expect(r.error).toContain('file_path');
    expect(r.error).toContain('最小正确调用示例');
  });

  it('P1-1：anyOf「多选一」必填 schema 不被执行器硬拦，由工具自身校验', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'either_tool',
      description: 'either a, or b+c',
      parameters: {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
        anyOf: [{ required: ['a'] }, { required: ['b', 'c'] }],
      },
      execute: (args) => {
        const r = (args ?? {}) as Record<string, unknown>;
        if (r['a'] === undefined && (r['b'] === undefined || r['c'] === undefined)) {
          return { error: 'either a, or b+c' };
        }
        return { output: 'ok' };
      },
    });
    const executor = new ToolExecutor(registry);
    // 只满足第二分支：旧实现按顶层 required 会误杀，现应放行到工具并成功
    const r1 = await executor.execute(req('either_tool', { b: '1', c: '2' }), env);
    expect(r1.ok).toBe(true);
    expect(r1.output).toBe('ok');
    // 两分支都不满足：执行器不拦，错误来自工具自身（而非 A1-4 的「缺少必填参数」）
    const r2 = await executor.execute(req('either_tool', {}, 'c2'), env);
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('either a, or b+c');
  });
});

describe('A1-5 browser_* 未安装提示指向 harness2 browser install', () => {
  const moduleMissing = (): Promise<never> => Promise.reject(new Error("Cannot find package 'playwright'"));

  it('playwright 模块缺失：所有需要浏览器的工具都返回含 harness2 browser install 的指引', async () => {
    const pool = new BrowserPool({ loader: moduleMissing });
    const defs = createBrowserTools('s-hint', pool);
    const cases: Array<[string, unknown]> = [
      ['browser_navigate', { url: 'https://example.com/' }],
      ['browser_click', { ref: 's1e1' }],
      ['browser_type', { ref: 's1e1', text: 'x' }],
      ['browser_snapshot', {}],
      ['browser_screenshot', {}],
    ];
    for (const [name, args] of cases) {
      const def = defs.find((d) => d.name === name)!;
      const out = await def.execute(args, { signal: env.signal, cwd: env.cwd });
      expect(out.error, name).toBeDefined();
      expect(out.error, name).toContain('harness2 browser install');
      expect(out.error, name).toContain('playwright');
    }
  });

  it("chromium 二进制缺失（Executable doesn't exist）→ 指向 harness2 browser install", () => {
    const e = new BrowserNotInstalledError("Executable doesn't exist at .../chrome.exe");
    expect(e.message).toContain('harness2 browser install');
    expect(e.message).toContain("Executable doesn't exist");
  });
});
