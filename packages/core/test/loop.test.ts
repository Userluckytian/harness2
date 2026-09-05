// Agent loop 测试。核心是「Model-visible ⟺ logged」不变量：
// mock.requests 的每条消息序列，必须能从最终日志独立逐步重建（测试内手写重建逻辑，
// 不与 loop 的 buildChatMessages 共享实现，避免同义反复）。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockProvider } from '../src/provider/mock.js';
import type { ChatMessage, ChatProvider } from '../src/provider/types.js';
import { computeProjection, loadSession } from '../src/session/reader.js';
import { SnapshotStore } from '../src/session/snapshots.js';
import { SessionWriter } from '../src/session/writer.js';
import { SESSION_LOG_FILE, type AnySessionEvent } from '../src/session/types.js';
import { runTurn } from '../src/agent/loop.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { editTool, writeTool } from '../src/tools/predefined/index.js';
import type { ApprovalHandler, ToolDefinition } from '../src/tools/types.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-loop-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTool(name: string, execute: ToolDefinition['execute'], extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: {} },
    execute,
    ...extra,
  };
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function loadEvents(dir: string): AnySessionEvent[] {
  return readFileSync(join(dir, SESSION_LOG_FILE), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AnySessionEvent);
}

describe('runTurn 基础语义', () => {
  it('纯文本回复：一步结束，assistant/message 落盘，finalText 返回', async () => {
    const dir = tmpDir();
    const provider = new MockProvider([{ text: '你好！', usage: { inputTokens: 5, outputTokens: 2 } }]);
    const result = await runTurn(dir, { provider, tools: new ToolRegistry(), cwd: dir, userText: '打个招呼' });

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(1);
    expect(result.finalText).toBe('你好！');

    const types = loadEvents(dir).map((e) => e.type);
    expect(types).toEqual([
      'session/header',
      'user/message',
      'step/start',
      'assistant/message',
      'step/end',
    ]);
    const session = loadSession(dir);
    const assistant = session.events.find((x) => x.event.type === 'assistant/message')?.event;
    expect(assistant && assistant.type === 'assistant/message' ? assistant.payload : null).toMatchObject({
      text: '你好！',
      model: 'mock',
      usage: { inputTokens: 5, outputTokens: 2 },
    });
  });

  it('工具调用后继续：tool/call+result 落盘，tool 结果作为 tool 消息进入第二请求', async () => {
    const dir = tmpDir();
    const provider = new MockProvider([
      { text: '读取文件', toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' }] },
      { text: '内容是 hello' },
    ]);
    const registry = new ToolRegistry();
    registry.register(makeTool('read_file', () => ({ output: 'hello' })));
    const result = await runTurn(dir, { provider, tools: registry, cwd: dir, userText: '读 a.txt' });

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toBe(1);

    // 事件顺序：assistant/message → tool/call → tool/result → step/end → 下一 step
    const types = loadEvents(dir).map((e) => e.type);
    expect(types).toEqual([
      'session/header',
      'user/message',
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/message',
      'step/end',
    ]);
    // 第二次请求包含 tool role 回传消息
    const second = provider.requests[1];
    const toolMsg = second?.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ content: 'hello', toolCallId: 'call-1', name: 'read_file' });
    // 请求携带工具规格
    expect(provider.requests[0]?.tools?.map((t) => t.name)).toEqual(['read_file']);
  });

  it('并行 safe 工具波次：同波 safe 调用并行，step 总时长远小于串行', async () => {
    const dir = tmpDir();
    const provider = new MockProvider([
      {
        text: '并行探测',
        toolCalls: [
          { id: 'p1', name: 'slow_probe', arguments: '{"ms":120}' },
          { id: 'p2', name: 'slow_probe', arguments: '{"ms":120}' },
        ],
      },
      { text: '完成' },
    ]);
    const registry = new ToolRegistry();
    registry.register(
      makeTool(
        'slow_probe',
        async (args) => {
          await sleep((args as { ms: number }).ms);
          return { output: 'ok' };
        },
        { concurrencySafe: true },
      ),
    );
    const started = performance.now();
    const result = await runTurn(dir, { provider, tools: registry, cwd: dir, userText: '探测' });
    const elapsed = performance.now() - started;

    expect(result.stopReason).toBe('end_turn');
    expect(result.toolCalls).toBe(2);
    expect(elapsed).toBeLessThan(220); // 串行需 ~240ms
    // tool/result 顺序与调用顺序一致
    const results = loadEvents(dir).filter((e) => e.type === 'tool/result');
    expect(results.map((e) => (e.payload as { callId: string }).callId)).toEqual(['p1', 'p2']);
  }, 8000);

  it('max_steps 守卫：达到上限停止并返回 max_steps', async () => {
    const dir = tmpDir();
    const reply = () => ({ text: '', toolCalls: [{ id: `c-${Math.random()}`, name: 'noop', arguments: '{}' }] });
    const provider = new MockProvider([reply(), reply(), reply(), reply(), reply()]);
    const registry = new ToolRegistry();
    registry.register(makeTool('noop', () => ({ output: 'ok' })));
    const result = await runTurn(dir, { provider, tools: registry, cwd: dir, userText: '循环', maxSteps: 3 });

    expect(result.stopReason).toBe('max_steps');
    expect(result.steps).toBe(3);
    expect(provider.consumed).toBe(3);
    const types = loadEvents(dir).map((e) => e.type);
    expect(types.filter((t) => t === 'step/start')).toHaveLength(3);
    expect(types.filter((t) => t === 'step/end')).toHaveLength(3);
    expect(types.at(-1)).toBe('step/end');
  });

  it('provider 抛错：assistant/attempt 记录错误 + step/end，返回 error', async () => {
    const dir = tmpDir();
    const provider = new MockProvider([{ error: 'boom: network down' }]);
    const result = await runTurn(dir, { provider, tools: new ToolRegistry(), cwd: dir, userText: 'hi' });

    expect(result.stopReason).toBe('error');
    expect(result.error).toBe('boom: network down');
    expect(result.steps).toBe(1);
    const events = loadEvents(dir);
    const attempt = events.find((e) => e.type === 'assistant/attempt');
    expect(attempt && attempt.type === 'assistant/attempt' ? attempt.payload : null).toMatchObject({
      error: 'boom: network down',
      model: 'mock',
    });
    expect(events.at(-1)?.type).toBe('step/end');
  });

  it('P2-4 回归：provider done.stopReason 白名单透传（length→length；paused→paused + warning）', async () => {
    const stoppedProvider = (stopReason: 'length' | 'paused'): ChatProvider => ({
      name: `stub-${stopReason}`,
      async *streamChat() {
        yield { type: 'text-delta', text: '半截回复' };
        yield { type: 'done', stopReason };
      },
    });
    const tools = new ToolRegistry();

    const dir1 = tmpDir();
    const r1 = await runTurn(dir1, { provider: stoppedProvider('length'), tools, cwd: dir1, userText: 'x' });
    expect(r1.stopReason).toBe('length'); // 不再折叠为 end_turn
    expect(r1.finalText).toBe('半截回复');
    expect(r1.warning).toBeUndefined();

    const dir2 = tmpDir();
    const r2 = await runTurn(dir2, { provider: stoppedProvider('paused'), tools, cwd: dir2, userText: 'x' });
    expect(r2.stopReason).toBe('paused');
    expect(r2.warning).toContain('pause_turn'); // 续跑未实现的如实告知
    expect(r2.finalText).toBe('半截回复');
    const events2 = loadEvents(dir2).map((e) => e.type);
    expect(events2).toContain('assistant/message'); // 流完整结束，文本正常落盘
    expect(events2.at(-1)).toBe('step/end'); // 日志无悬挂
  });

  it('approval deny：工具不执行、result 为 denied，loop 带着拒绝消息继续到 end_turn', async () => {
    const dir = tmpDir();
    const provider = new MockProvider([
      { text: '删库', toolCalls: [{ id: 'call-d', name: 'danger', arguments: '{}' }] },
      { text: '好的，已取消操作。' },
    ]);
    const registry = new ToolRegistry();
    let executed = 0;
    registry.register(makeTool('danger', () => { executed += 1; return { output: 'done' }; }));
    const approval: ApprovalHandler = { decide: () => 'deny' };
    const result = await runTurn(dir, { provider, tools: registry, approval, cwd: dir, userText: '执行危险操作' });

    expect(executed).toBe(0);
    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(2);
    const denied = provider.requests[1]?.messages.find((m) => m.role === 'tool');
    expect(denied?.content).toBe('denied by approval policy');
    const logged = loadEvents(dir).find((e) => e.type === 'tool/result');
    expect(logged && logged.type === 'tool/result' ? logged.payload : null).toMatchObject({
      callId: 'call-d',
      ok: false,
      error: 'denied by approval policy',
    });
  });

  it('session 可传已打开的 writer：调用方自行追加 user/message，loop 不重复写', async () => {
    const dir = tmpDir();
    const writer = SessionWriter.create(dir, { sessionId: 'writer-mode' }, { fsync: false });
    writer.append('user/message', { text: '手动写入的用户消息' });
    const provider = new MockProvider([{ text: '收到' }]);
    const result = await runTurn(writer, { provider, tools: new ToolRegistry(), cwd: dir });

    expect(result.stopReason).toBe('end_turn');
    expect(provider.requests[0]?.messages.map((m) => m.content)).toEqual(['手动写入的用户消息']);
    const types = loadEvents(dir).map((e) => e.type);
    expect(types.filter((t) => t === 'user/message')).toHaveLength(1);
    writer.close();
  });

  it('空工具注册表：请求不带 tools 字段', async () => {
    const dir = tmpDir();
    const provider = new MockProvider([{ text: 'ok' }]);
    await runTurn(dir, { provider, tools: new ToolRegistry(), cwd: dir, userText: 'x' });
    expect(provider.requests[0]?.tools).toBeUndefined();
  });
});

describe('runTurn 取消语义', () => {
  it('开始前已取消：不产生 step 事件，返回 cancelled', async () => {
    const dir = tmpDir();
    const ac = new AbortController();
    ac.abort();
    const provider = new MockProvider([{ text: 'never' }]);
    const result = await runTurn(dir, {
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: 'hi',
      signal: ac.signal,
    });

    expect(result.stopReason).toBe('cancelled');
    expect(result.steps).toBe(0);
    const types = loadEvents(dir).map((e) => e.type);
    expect(types).toEqual(['session/header', 'user/message']); // 只有用户消息落盘
  });

  it('流式中取消：assistant/attempt 含 cancelled + step/end，返回 cancelled', async () => {
    const dir = tmpDir();
    const ac = new AbortController();
    const provider = new MockProvider([{ textChunks: ['a', 'b', 'c', 'd'], chunkDelayMs: 40 }]);
    const registry = new ToolRegistry();
    registry.register(makeTool('noop', () => ({ output: 'x' })));
    const pending = runTurn(dir, { provider, tools: registry, cwd: dir, userText: 'hi', signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const result = await pending;

    expect(result.stopReason).toBe('cancelled');
    expect(result.steps).toBe(1);
    const events = loadEvents(dir);
    const attempt = events.find((e) => e.type === 'assistant/attempt');
    expect(attempt && attempt.type === 'assistant/attempt' ? attempt.payload.error : '').toContain('cancelled');
    expect(events.at(-1)?.type).toBe('step/end');
    // 失败的尝试不应留下 assistant/message
    expect(events.some((e) => e.type === 'assistant/message')).toBe(false);
  }, 8000);

  it('工具执行中取消：已取消调用落盘 ok:false 后，turn 以 cancelled 结束（append-only）', async () => {
    const dir = tmpDir();
    const ac = new AbortController();
    const provider = new MockProvider([
      {
        text: '触发取消',
        toolCalls: [
          { id: 'x1', name: 'cancel_trigger', arguments: '{}' },
          { id: 'x2', name: 'sleep_probe', arguments: '{"ms":100}' },
        ],
      },
      { text: 'never' },
    ]);
    const registry = new ToolRegistry();
    registry.register(makeTool('cancel_trigger', async () => { await sleep(10); ac.abort(); return { output: 'triggered' }; }));
    registry.register(
      makeTool('sleep_probe', async () => { await sleep(200); return { output: 'done' }; }, { concurrencySafe: true }),
    );
    const result = await runTurn(dir, { provider, tools: registry, cwd: dir, userText: 'go', signal: ac.signal });

    expect(result.stopReason).toBe('cancelled');
    const results = loadEvents(dir).filter((e) => e.type === 'tool/result');
    expect(results).toHaveLength(2);
    // append-only：取消发生在执行中 → 两个调用的结果都以 ok:false 事件落盘（不删除、不静默）
    for (const callId of ['x1', 'x2']) {
      const r = results.find((e) => (e.payload as { callId: string }).callId === callId);
      expect(r && r.type === 'tool/result' ? r.payload.ok : null).toBe(false);
      expect(r && r.type === 'tool/result' ? r.payload.error : '').toBe('cancelled');
    }
    const types = loadEvents(dir).map((e) => e.type);
    expect(types.filter((t) => t === 'step/end')).toHaveLength(1);
  }, 8000);

  it('P2-1 回归：provider 按契约在 abort 时正常结束迭代而非抛错——半截文本不冒充 end_turn', async () => {
    const dir = tmpDir();
    const ac = new AbortController();
    const provider: ChatProvider = {
      name: 'mock',
      async *streamChat() {
        yield { type: 'text-delta', text: '半截回复' };
        // 契约允许：感知 abort 后正常收尾迭代（不抛错）——loop 必须自行补检信号
        while (!ac.signal.aborted) await sleep(10);
      },
    };
    const pending = runTurn(dir, { provider, tools: new ToolRegistry(), cwd: dir, userText: 'hi', signal: ac.signal });
    setTimeout(() => ac.abort(), 60);
    const result = await pending;

    expect(result.stopReason).toBe('cancelled');
    const events = loadEvents(dir);
    // 半截文本不得落 assistant/message（否则会被下一请求当 end_turn 回复重建）
    expect(events.some((e) => e.type === 'assistant/message')).toBe(false);
    const attempt = events.find((e) => e.type === 'assistant/attempt');
    expect(attempt && attempt.type === 'assistant/attempt' ? attempt.payload.error : '').toContain('cancelled');
    expect(events.at(-1)?.type).toBe('step/end');
  }, 8000);

  it('P2-2 回归：审批回调抛错 → 该调用 ok:false，turn 正常完成且日志无悬挂', async () => {
    const dir = tmpDir();
    const provider = new MockProvider([
      { text: '触发审批', toolCalls: [{ id: 'call-e', name: 'guarded', arguments: '{}' }] },
      { text: '审批回调异常，操作未执行。' },
    ]);
    const registry = new ToolRegistry();
    let executed = 0;
    registry.register(makeTool('guarded', () => { executed += 1; return { output: 'done' }; }));
    const approval: ApprovalHandler = { decide: () => { throw new Error('approval storage down'); } };
    const result = await runTurn(dir, { provider, tools: registry, approval, cwd: dir, userText: 'go' });

    expect(executed).toBe(0);
    expect(result.stopReason).toBe('end_turn'); // 回调异常不击穿 turn
    const events = loadEvents(dir);
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'step/start')).toHaveLength(2);
    expect(types.filter((t) => t === 'step/end')).toHaveLength(2); // step/start+end 成对必落盘
    const logged = events.find((e) => e.type === 'tool/result');
    expect(logged && logged.type === 'tool/result' ? logged.payload : null).toMatchObject({ callId: 'call-e', ok: false });
    expect(logged && logged.type === 'tool/result' ? logged.payload.error : '').toContain('approval callback threw');
    // 模型在下一请求看到该失败结果（而不是整个 turn 抛出）
    const toolMsg = provider.requests[1]?.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('approval callback threw');
  });
});

describe('Model-visible ⟺ logged 不变量', () => {
  it('mock.requests 每条消息序列 === 从日志独立重建的序列（多轮工具调用）', async () => {
    const dir = tmpDir();
    const provider = new MockProvider([
      {
        text: '我先做两件事。',
        toolCalls: [
          { id: 'call-1', name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'hello' }) },
          { id: 'call-2', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
        ],
      },
      { text: '再看一次。', toolCalls: [{ id: 'call-3', name: 'read_file', arguments: '{"path":"a.txt"}' }] },
      { text: '全部完成，内容是 hello。' },
    ]);
    const registry = new ToolRegistry();
    registry.register(makeTool('write_file', () => ({ output: 'written' })));
    registry.register(makeTool('read_file', () => ({ output: 'hello' })));
    const result = await runTurn(dir, { provider, tools: registry, cwd: dir, userText: '写并读 a.txt' });
    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(3);

    // —— 独立回放：遍历最终日志，按 step/start 快照当时的消息序列 ——
    const session = loadSession(dir);
    computeProjection(session);
    const messages: Array<Record<string, unknown>> = [];
    const expectedRequests: string[] = [];
    for (const { event: e, active } of session.events) {
      if (!active) continue;
      if (e.type === 'step/start') {
        expectedRequests.push(JSON.stringify(messages));
        continue;
      }
      if (e.type === 'user/message') {
        messages.push({ role: 'user', content: e.payload.text });
      } else if (e.type === 'assistant/message') {
        messages.push({ role: 'assistant', content: e.payload.text });
      } else if (e.type === 'tool/call' && messages.at(-1)?.role === 'assistant') {
        const last = messages.at(-1) as { toolCalls?: Array<Record<string, unknown>> };
        (last.toolCalls ??= []).push({
          id: e.payload.callId,
          name: e.payload.tool,
          arguments: JSON.stringify(e.payload.args ?? {}),
        });
      } else if (e.type === 'tool/result') {
        const content = e.payload.ok
          ? (e.payload.output ?? '')
          : [e.payload.error, e.payload.output].filter(Boolean).join('\n');
        messages.push({ role: 'tool', content, toolCallId: e.payload.callId, name: e.payload.tool });
      }
    }
    const actualRequests = provider.requests.map((r) => JSON.stringify(r.messages));
    expect(actualRequests).toEqual(expectedRequests);
    expect(actualRequests).toHaveLength(3);

    // 正向补强：请求中的 tool 消息都能对应日志中的 tool/result 事件
    const loggedResultIds = new Set(
      loadEvents(dir).filter((e) => e.type === 'tool/result').map((e) => (e.payload as { callId: string }).callId),
    );
    for (const req of provider.requests) {
      for (const m of req.messages as ChatMessage[]) {
        if (m.role === 'tool') expect(loggedResultIds.has(m.toolCallId as string)).toBe(true);
      }
    }
  });
});

describe('快照钩子（TurnOptions.snapshots）', () => {
  it('write 工具执行前后产生快照条目；seq = tool/call 事件 seq；undo 恢复后文件复原（loop 级）', async () => {
    const dir = tmpDir(); // 会话目录
    const work = tmpDir(); // 工具工作目录
    const file = join(work, 'hello.txt');
    writeFileSync(file, 'original', 'utf8');

    const provider = new MockProvider([
      { text: '写入文件', toolCalls: [{ id: 'w1', name: 'write', arguments: JSON.stringify({ file_path: 'hello.txt', content: 'updated' }) }] },
      { text: '完成' },
    ]);
    const registry = new ToolRegistry();
    registry.register(writeTool);
    const snapshots = new SnapshotStore(dir);
    const result = await runTurn(dir, { provider, tools: registry, cwd: work, userText: '写 hello.txt', snapshots });
    expect(result.stopReason).toBe('end_turn');
    expect(readFileSync(file, 'utf8')).toBe('updated');

    // 条目：seq 与日志 tool/call 事件 seq 一致，before/after 正确
    const toolCallSeq = loadEvents(dir).find((e) => e.type === 'tool/call')!.seq;
    const entries = snapshots.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ seq: toolCallSeq, before: 'original', after: 'updated' });
    expect(entries[0]!.file).toBe(file); // 绝对路径

    // loop 级 undo：追加 rewind marker + 快照恢复 → 文件回到 original
    const writer = SessionWriter.open(dir, { fsync: false });
    writer.append('rewind/marker', { rewindToSeq: toolCallSeq - 1, reason: 'undo' });
    const restored = snapshots.restore(toolCallSeq - 1);
    writer.close();
    expect(restored.items[0]).toMatchObject({ file, target: 'original', externallyModified: false, restored: true });
    expect(readFileSync(file, 'utf8')).toBe('original');
  });

  it('read/bash 工具不产生快照条目', async () => {
    const dir = tmpDir();
    const provider = new MockProvider([
      {
        text: '读并执行',
        toolCalls: [
          { id: 'r1', name: 'read', arguments: '{"file_path":"a.txt"}' },
          { id: 'b1', name: 'bash', arguments: '{"cmd":"echo hi"}' },
        ],
      },
      { text: '完成' },
    ]);
    const registry = new ToolRegistry();
    registry.register(makeTool('read', () => ({ output: 'x' })));
    registry.register(makeTool('bash', () => ({ output: 'hi' })));
    const snapshots = new SnapshotStore(dir);
    await runTurn(dir, { provider, tools: registry, cwd: dir, userText: 'x', snapshots });
    expect(snapshots.entries()).toEqual([]);
  });

  it('工具失败（ok:false）不记 after；取消路径同样不落盘', async () => {
    const dir = tmpDir();
    const provider = new MockProvider([
      { text: '会失败的编辑', toolCalls: [{ id: 'e1', name: 'edit', arguments: JSON.stringify({ file_path: 'nope.txt', old_text: 'a', new_text: 'b' }) }] },
      { text: '收到失败' },
    ]);
    const registry = new ToolRegistry();
    registry.register(editTool);
    const snapshots = new SnapshotStore(dir);
    const result = await runTurn(dir, { provider, tools: registry, cwd: dir, userText: 'x', snapshots });

    expect(result.stopReason).toBe('end_turn');
    const results = loadEvents(dir).filter((e) => e.type === 'tool/result');
    expect(results[0] && results[0].type === 'tool/result' ? results[0].payload.ok : null).toBe(false);
    expect(snapshots.entries()).toEqual([]); // capture 后未 commitAfter → 无条目
  });

  it('工具执行中被取消：不 commitAfter，不产生条目（append-only，取消路径无恢复点）', async () => {
    const dir = tmpDir();
    const work = tmpDir();
    const ac = new AbortController();
    const provider = new MockProvider([
      { text: '慢慢写', toolCalls: [{ id: 'w1', name: 'write', arguments: JSON.stringify({ file_path: 'slow.txt', content: 'x' }) }] },
      { text: 'never' },
    ]);
    const registry = new ToolRegistry();
    // 名为 write 的慢工具：模拟执行中取消（快照钩子按工具名判定，与实现无关）
    registry.register(makeTool('write', async () => { await sleep(150); return { output: 'written' }; }));
    const snapshots = new SnapshotStore(dir);
    const pending = runTurn(dir, { provider, tools: registry, cwd: work, userText: 'x', snapshots, signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    const result = await pending;

    expect(result.stopReason).toBe('cancelled');
    const logged = loadEvents(dir).find((e) => e.type === 'tool/result');
    expect(logged && logged.type === 'tool/result' ? logged.payload.ok : null).toBe(false);
    expect(snapshots.entries()).toEqual([]);
  }, 8000);

  it('同 turn 两次写同一文件：两次 capture 各取执行前状态（unsafe 串行语义）', async () => {
    const dir = tmpDir();
    const work = tmpDir();
    const provider = new MockProvider([
      {
        text: '连续写两次',
        toolCalls: [
          { id: 'w1', name: 'write', arguments: JSON.stringify({ file_path: 'a.txt', content: 'v2' }) },
          { id: 'w2', name: 'write', arguments: JSON.stringify({ file_path: 'a.txt', content: 'v3' }) },
        ],
      },
      { text: '完成' },
    ]);
    const registry = new ToolRegistry();
    registry.register(writeTool);
    const snapshots = new SnapshotStore(dir);
    writeFileSync(join(work, 'a.txt'), 'v1', 'utf8');
    await runTurn(dir, { provider, tools: registry, cwd: work, userText: 'x', snapshots });

    const entries = snapshots.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ before: 'v1', after: 'v2' });
    expect(entries[1]).toMatchObject({ before: 'v2', after: 'v3' });
    // 撤到两次写之前 → v1
    expect(snapshots.restore(entries[0]!.seq - 1).items[0]!.target).toBe('v1');
  });
});

describe('loop demo session 生成（供手工验证 traj 渲染；设 H2_GEN_LOOP_DEMO=1 时执行）', () => {
  const demoDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'loop-demo');

  it.skipIf(!process.env.H2_GEN_LOOP_DEMO)('生成 loop-demo fixture', async () => {
    rmSync(demoDir, { recursive: true, force: true });
    const provider = new MockProvider([
      { text: '我来创建演示文件。', toolCalls: [{ id: 'call-1', name: 'write', arguments: JSON.stringify({ file_path: 'hello.txt', content: '由 agent loop 生成的演示内容\n第二行：你好 harness2\n' }) }] },
      { text: '读取确认一下。', toolCalls: [{ id: 'call-2', name: 'read', arguments: '{"file_path":"hello.txt"}' }] },
      { text: '已写入并读取 hello.txt，内容确认无误。' },
    ]);
    const registry = new ToolRegistry();
    registry.register(makeTool('write', () => ({ output: 'written' })));
    registry.register(makeTool('read', () => ({ output: '由 agent loop 生成的演示内容' })));
    const writer = SessionWriter.create(demoDir, { sessionId: 'loop-demo', cwd: demoDir }, { fsync: false });
    const result = await runTurn(writer, { provider, tools: registry, cwd: demoDir, userText: '创建 hello.txt 并读取验证' });
    writer.close();
    expect(result.stopReason).toBe('end_turn');
    expect(existsSync(join(demoDir, SESSION_LOG_FILE))).toBe(true);
  }, 10000);
});
