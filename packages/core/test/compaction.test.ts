// 上下文压缩测试（阶段 7 Task 1）：
// 触发/不触发/替换正确性/最新覆盖旧摘要/摘要失败跳过/不变量扩展/role 交替/写入口校验；
// 摘要输入尾部优先（审查 P2-2）；压缩 × rewind 交互（审查 P2-3）。
// 不变量回放（独立重建）不与 buildChatMessages 共享实现，避免同义反复。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChatMessages } from '../src/agent/loop.js';
import { runTurn } from '../src/agent/loop.js';
import { undoLastTurn } from '../src/session/undo.js';
import {
  buildCompactionDigest,
  COMPACTION_DIGEST_TOTAL_MAX_CHARS,
  COMPACTION_SUMMARY_PREFIX,
  computeCoveredUpToSeq,
  estimateContextTokens,
  requestCompactionSummary,
} from '../src/agent/compaction.js';
import { MockProvider } from '../src/provider/mock.js';
import type { ChatMessage, ChatProvider, ChatRequest } from '../src/provider/types.js';
import { computeProjection, loadSession } from '../src/session/reader.js';
import { SessionWriter } from '../src/session/writer.js';
import { SESSION_LOG_FILE, type AnySessionEvent } from '../src/session/types.js';
import { ToolRegistry } from '../src/tools/registry.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-compact-'));
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

/** 摘要 provider stub：固定回复 + 记录请求（供触发断言） */
function summarizerStub(reply = '这是摘要'): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    name: 'stub-summarizer',
    requests,
    // eslint-disable-next-line require-yield
    async *streamChat(req: ChatRequest): AsyncIterable<{ type: 'text-delta'; text: string }> {
      requests.push(req);
      yield { type: 'text-delta', text: reply };
    },
  } as ChatProvider & { requests: ChatRequest[] };
}

/** 抛错的摘要 provider stub（摘要失败路径） */
function summarizerBoom(): ChatProvider {
  return {
    name: 'boom-summarizer',
    async *streamChat(): AsyncIterable<never> {
      throw new Error('summarizer endpoint down');
    },
  };
}

const long = (n: number, tag = 'x'): string => tag.repeat(n);

/** 预置 seed 条 user/assistant 消息（writer 保持打开，供 runTurn 续写） */
function seedMessages(writer: SessionWriter, texts: string[]): void {
  for (const text of texts) {
    writer.append('user/message', { text });
    writer.append('assistant/message', { text: `回复:${text}` });
  }
}

describe('estimateContextTokens / computeCoveredUpToSeq（纯函数）', () => {
  it('估算 = 消息字符/4（含工具调用参数）', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a'.repeat(400) },
      {
        role: 'assistant',
        content: 'b'.repeat(36),
        toolCalls: [{ id: 'c1', name: 'tool', arguments: '{"p":1}' }],
      },
    ];
    // 400 + 36 + (id 2 + name 4 + args 7) = 449 → ceil/4 = 113
    expect(estimateContextTokens(messages)).toBe(113);
  });

  it('6 条消息：无可折叠区返回 null；7 条：上界 = 倒数第 7 条（尾部保留 6 条原文）', () => {
    const dir = tmpDir();
    const writer = SessionWriter.create(dir, { sessionId: 'boundary' }, { fsync: false });
    seedMessages(writer, Array.from({ length: 3 }, (_, i) => `m${i}`)); // 6 条
    expect(computeCoveredUpToSeq(loadSession(dir))).toBeNull();
    writer.append('user/message', { text: 'm3' }); // 第 7 条
    const boundary = computeCoveredUpToSeq(loadSession(dir));
    expect(boundary).not.toBeNull();
    // 上界指向倒数第 7 条消息（第 1 条 user）——其后恰余 6 条原文
    const session = loadSession(dir);
    computeProjection(session);
    const msgs = session.events.filter(
      ({ event, active }) => active && (event.type === 'user/message' || event.type === 'assistant/message'),
    );
    expect(boundary).toBe(msgs[0]!.event.seq);
    expect(msgs.length - 6).toBe(1);
    writer.close();
  });
});

describe('buildCompactionDigest / requestCompactionSummary（纯函数）', () => {
  it('折叠覆盖区消息为 USER/ASSISTANT 行；总量超限尾部优先——摘要输入含最新、不含最旧（审查 P2-2）', () => {
    const dir = tmpDir();
    const writer = SessionWriter.create(dir, { sessionId: 'digest' }, { fsync: false });
    writer.append('user/message', { text: '问: 早期问题' });
    writer.append('assistant/message', { text: 'B'.repeat(2000) }); // 单条裁到 500（本例中整体被截断在最旧端）
    // 60 条 filler：双位数行 ~419 字符、单位数行 ~373 字符，总量超 24000
    for (let i = 0; i < 60; i++) {
      writer.append('user/message', { text: `filler${i} `.repeat(46).trim() });
    }
    writer.close();

    const session = loadSession(dir);
    computeProjection(session);
    const lastSeq = session.events.at(-1)!.event.seq;
    const digest = buildCompactionDigest(session, lastSeq);
    // 尾部优先：最新端消息进入摘要输入，且 digest 内保持时间顺序
    expect(digest).toContain('filler59 ');
    expect(digest).toContain('filler2 ');
    expect(digest.indexOf('filler58 ')).toBeLessThan(digest.indexOf('filler59 '));
    // 超限截断发生在最旧端：最早的消息不进摘要输入
    expect(digest).not.toContain('问: 早期问题');
    expect(digest).not.toContain('B'.repeat(500));
    expect(digest).not.toContain('filler1 ');
    expect(digest.length).toBeLessThanOrEqual(COMPACTION_DIGEST_TOTAL_MAX_CHARS + 600);
  });

  it('单条超长消息裁到 500 字符（未超总量时全部进入摘要输入）', () => {
    const dir = tmpDir();
    const writer = SessionWriter.create(dir, { sessionId: 'clip' }, { fsync: false });
    writer.append('assistant/message', { text: 'B'.repeat(2000) }); // seq2
    writer.close();
    const session = loadSession(dir);
    computeProjection(session);
    const lastSeq = session.events.at(-1)!.event.seq;
    const digest = buildCompactionDigest(session, lastSeq);
    expect(digest).toBe(`ASSISTANT: ${'B'.repeat(500)}…`);
  });

  it('摘要调用：system 提示 + 超长输出截断；空输出抛错', async () => {
    const stub = summarizerStub('S'.repeat(3000));
    const summary = await requestCompactionSummary(stub, 'digest-input', { maxChars: 2000 });
    expect(summary).toBe('S'.repeat(2000));
    expect(stub.requests[0]?.system).toContain('摘要');
    expect(stub.requests[0]?.messages).toEqual([{ role: 'user', content: 'digest-input' }]);
    await expect(requestCompactionSummary(summarizerStub('   '), 'x')).rejects.toThrow('空摘要');
  });
});

describe('压缩触发（runTurn + compaction 选项）', () => {
  it('触发：估算超阈值 → 摘要事件落盘，请求首条为摘要消息，覆盖区文本不再出现在请求中', async () => {
    const dir = tmpDir();
    const writer = SessionWriter.create(dir, { sessionId: 'trigger' }, { fsync: false });
    // 8 条 seed（覆盖区 2 条 + 尾部 6 条）；长文本使估算越过 128×0.75=96 token
    seedMessages(writer, [long(200, 'A'), long(200, 'B'), long(5, 'c'), long(5, 'd'), long(5, 'e'), long(5, 'f'), long(5, 'g'), long(5, 'h')]);
    const summarizer = summarizerStub('覆盖区摘要内容');
    const provider = new MockProvider([{ text: 'turn 回复' }, { text: 'turn3 回复' }]);

    const r1 = await runTurn(writer, {
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: long(10, 'N'),
      compaction: { contextWindow: 128, summarizer },
    });
    expect(r1.stopReason).toBe('end_turn');

    const compactions = loadEvents(dir).filter((e) => e.type === 'compaction/applied');
    expect(compactions).toHaveLength(1);
    const payload = compactions[0]!.payload as { summary: string; coveredUpToSeq: number };
    expect(payload.summary).toBe('覆盖区摘要内容');
    // coveredUpToSeq：压缩发生在本条 user 消息落盘后、assistant 回复前——
    // 以压缩事件自身位置计算：其前共 9 条消息（8 seed + 本轮 user），上界 = 倒数第 7 条
    const session = loadSession(dir);
    computeProjection(session);
    const msgs = session.events.filter(
      ({ event, active }) => active && (event.type === 'user/message' || event.type === 'assistant/message'),
    );
    const beforeCompaction = msgs.filter((m) => m.event.seq < compactions[0]!.seq);
    expect(beforeCompaction).toHaveLength(17); // 8 对 seed（16 条）+ 本轮 user
    expect(payload.coveredUpToSeq).toBe(beforeCompaction[beforeCompaction.length - 7]!.event.seq);
    // 摘要输入 = 覆盖区折叠（含被覆盖的前几条）
    expect(summarizer.requests[0]?.messages[0]?.content).toContain('A'.repeat(50));
    expect(summarizer.requests[0]?.messages[0]?.content).toContain('B'.repeat(50));
    expect(summarizer.requests[0]?.messages[0]?.content).not.toContain('hhhhh');

    // 请求首条 = 摘要（保留区首条是 assistant → 独立 user 摘要消息，不合并）
    const req = provider.requests[0]!;
    expect(req.messages[0]).toEqual({ role: 'user', content: `${COMPACTION_SUMMARY_PREFIX}\n覆盖区摘要内容` });
    const joined = req.messages.map((m) => m.content).join('\n');
    expect(joined).not.toContain('AAAAA'); // 覆盖区原文被替换
    expect(joined).not.toContain('ccccc'); // 同为覆盖区
    expect(joined).toContain('ggggg'); // 尾部 6 条原文保留
    expect(joined).toContain('hhhhh');
    expect(joined).toContain('NNNNNNNNNN'); // 本轮用户消息保留
    // role 交替：无连续 user
    for (let i = 1; i < req.messages.length; i++) {
      const prev = req.messages[i - 1]!;
      const cur = req.messages[i]!;
      expect(!(prev.role === 'user' && cur.role === 'user')).toBe(true);
    }

    // 估算回落：压缩后下一 turn 不再触发（摘要替换计入估算）
    await runTurn(writer, {
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: 'again',
      compaction: { contextWindow: 128, summarizer },
    });
    expect(loadEvents(dir).filter((e) => e.type === 'compaction/applied')).toHaveLength(1);
    expect(summarizer.requests).toHaveLength(1);
    writer.close();
  });

  it('不触发：估算低于阈值 → 无压缩事件、请求含全部原文', async () => {
    const dir = tmpDir();
    const writer = SessionWriter.create(dir, { sessionId: 'no-trigger' }, { fsync: false });
    seedMessages(writer, ['短一', '短二', '短三', '短四']);
    const summarizer = summarizerStub('不该被调用');
    const provider = new MockProvider([{ text: 'ok' }]);
    await runTurn(writer, {
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: '新的问题',
      compaction: { contextWindow: 128, summarizer },
    });
    expect(loadEvents(dir).some((e) => e.type === 'compaction/applied')).toBe(false);
    expect(summarizer.requests).toHaveLength(0);
    const joined = provider.requests[0]!.messages.map((m) => m.content).join('\n');
    expect(joined).toContain('短一');
    expect(joined).toContain('新的问题');
    writer.close();
  });

  it('摘要失败：不落事件、turn 正常完成（warning 告知、下轮可重试）', async () => {
    const dir = tmpDir();
    const writer = SessionWriter.create(dir, { sessionId: 'fail' }, { fsync: false });
    seedMessages(writer, [long(200, 'A'), long(200, 'B'), long(5, 'c'), long(5, 'd'), long(5, 'e'), long(5, 'f'), long(5, 'g'), long(5, 'h')]);
    const provider = new MockProvider([{ text: 'turn 回复' }]);
    const result = await runTurn(writer, {
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: long(10, 'N'),
      compaction: { contextWindow: 128, summarizer: summarizerBoom() },
    });
    expect(result.stopReason).toBe('end_turn');
    expect(result.warning).toContain('上下文压缩失败已跳过');
    expect(result.warning).toContain('summarizer endpoint down');
    expect(loadEvents(dir).some((e) => e.type === 'compaction/applied')).toBe(false);
    // turn 不中断：完整请求照发（未压缩的全量上下文）
    const joined = provider.requests[0]!.messages.map((m) => m.content).join('\n');
    expect(joined).toContain('AAAAA');
    expect(joined).toContain('hhhhh');
    writer.close();
  });
});

describe('buildChatMessages 消费 compaction/applied（单元）', () => {
  function draftSession(build: (w: SessionWriter) => void): string {
    const dir = tmpDir();
    const writer = SessionWriter.create(dir, { sessionId: 'unit' }, { fsync: false });
    build(writer);
    writer.close();
    return dir;
  }

  it('替换正确性：覆盖区（含工具流量）替换为摘要；保留区照常映射', () => {
    const dir = draftSession((w) => {
      w.append('user/message', { text: 'u1' }); // seq2
      w.append('assistant/message', { text: 'a1' }); // seq3
      w.append('tool/call', { callId: 'c1', tool: 'read', args: { p: 1 } }); // seq4（属于 a1）
      w.append('tool/result', { callId: 'c1', tool: 'read', ok: true, output: 'r1' }); // seq5
      w.append('user/message', { text: 'u2' }); // seq6
      w.append('assistant/message', { text: 'a2' }); // seq7
      w.append('compaction/applied', { summary: 'S', coveredUpToSeq: 3 }); // seq8
    });
    const messages = buildChatMessages(loadSession(dir));
    // 覆盖区 = u1,a1；边界 a1 的工具流量（seq4/5）一并跳过；保留区 = u2,a2
    // 摘要 user 与保留区首条 u2（user）合并为一条 → 无连续 user
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0]!.content).toBe(`${COMPACTION_SUMMARY_PREFIX}\nS\n\nu2`);
    expect(messages[1]!.content).toBe('a2');
    expect(messages.some((m) => m.role === 'tool')).toBe(false);
  });

  it('覆盖区上界含保留区前的 assistant：其 toolCalls 落入摘要区，保留区无孤儿 tool 消息', () => {
    const dir = draftSession((w) => {
      w.append('user/message', { text: 'u1' }); // seq2
      w.append('assistant/message', { text: 'a1' }); // seq3
      w.append('tool/call', { callId: 'c1', tool: 'read', args: {} }); // seq4
      w.append('tool/result', { callId: 'c1', tool: 'read', ok: true, output: 'r1' }); // seq5
      w.append('user/message', { text: 'u2' }); // seq6
      w.append('assistant/message', { text: 'a2' }); // seq7
      w.append('tool/call', { callId: 'c2', tool: 'bash', args: {} }); // seq8（属于 a2，保留区）
      w.append('tool/result', { callId: 'c2', tool: 'bash', ok: true, output: 'r2' }); // seq9
      w.append('user/message', { text: 'u3' }); // seq10
      w.append('compaction/applied', { summary: 'S2', coveredUpToSeq: 5 }); // seq11
    });
    const messages = buildChatMessages(loadSession(dir));
    // 保留区 = u2, a2(+c2), r2, u3；首条 u2 是 user → 摘要与其合并为一条
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(messages[0]!.content).toBe(`${COMPACTION_SUMMARY_PREFIX}\nS2\n\nu2`);
    expect(messages[1]!.toolCalls).toEqual([{ id: 'c2', name: 'bash', arguments: '{}' }]);
    expect(messages[2]).toMatchObject({ toolCallId: 'c2', content: 'r2' });
    expect(messages[3]!.content).toBe('u3');
  });

  it('最新覆盖旧摘要：两条压缩事件取最新一条的 summary 与 coveredUpToSeq', () => {
    const dir = draftSession((w) => {
      w.append('user/message', { text: 'u1' }); // seq2
      w.append('assistant/message', { text: 'a1' }); // seq3
      w.append('user/message', { text: 'u2' }); // seq4
      w.append('assistant/message', { text: 'a2' }); // seq5
      w.append('compaction/applied', { summary: '旧摘要', coveredUpToSeq: 3 }); // seq6
      w.append('compaction/applied', { summary: '新摘要', coveredUpToSeq: 5 }); // seq7
    });
    const messages = buildChatMessages(loadSession(dir));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toBe(`${COMPACTION_SUMMARY_PREFIX}\n新摘要`);
    expect(messages[0]!.content).not.toContain('旧摘要');
  });

  it('无压缩事件：行为与既有映射完全一致（回归）', () => {
    const dir = draftSession((w) => {
      w.append('user/message', { text: 'u1' });
      w.append('assistant/message', { text: 'a1' });
      w.append('tool/call', { callId: 'c1', tool: 'read', args: {} });
      w.append('tool/result', { callId: 'c1', tool: 'read', ok: true, output: 'r1' });
    });
    const messages = buildChatMessages(loadSession(dir));
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(messages[1]!.toolCalls).toHaveLength(1);
  });
});

describe('压缩 × rewind（阶段 7 审查 P2-3）', () => {
  it('压缩事件被 rewind 遮蔽 → buildChatMessages 从原文重建（无摘要）', () => {
    const dir = tmpDir();
    const writer = SessionWriter.create(dir, { sessionId: 'rewind-masked' }, { fsync: false });
    writer.append('user/message', { text: 'u1' }); // seq2
    writer.append('assistant/message', { text: 'a1' }); // seq3
    writer.append('user/message', { text: 'u2' }); // seq4
    writer.append('assistant/message', { text: 'a2' }); // seq5
    writer.append('compaction/applied', { summary: '覆盖摘要', coveredUpToSeq: 3 }); // seq6
    writer.append('user/message', { text: 'u3' }); // seq7
    writer.append('assistant/message', { text: 'a3' }); // seq8
    undoLastTurn(writer); // 撤 u3 turn（rewindTo 6）
    undoLastTurn(writer); // 撤 u2 turn（rewindTo 3）→ 压缩事件（seq6）一并被遮蔽
    writer.close();

    const messages = buildChatMessages(loadSession(dir));
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0]!.content).toBe('u1');
    expect(messages[1]!.content).toBe('a1');
    expect(messages.some((m) => m.content.includes(COMPACTION_SUMMARY_PREFIX))).toBe(false);
    expect(messages.some((m) => m.content.includes('覆盖摘要'))).toBe(false);
  });

  it('两条压缩事件间 undo → 旧摘要继续生效 + 分段原文（新摘要被遮蔽）', () => {
    const dir = tmpDir();
    const writer = SessionWriter.create(dir, { sessionId: 'between-undos' }, { fsync: false });
    writer.append('user/message', { text: 'u1' }); // seq2
    writer.append('assistant/message', { text: 'a1' }); // seq3
    writer.append('user/message', { text: 'u2' }); // seq4
    writer.append('assistant/message', { text: 'a2' }); // seq5
    writer.append('compaction/applied', { summary: '旧摘要', coveredUpToSeq: 3 }); // seq6
    writer.append('user/message', { text: 'u3' }); // seq7
    writer.append('assistant/message', { text: 'a3' }); // seq8
    writer.append('compaction/applied', { summary: '新摘要', coveredUpToSeq: 8 }); // seq9
    undoLastTurn(writer); // 撤 u3 turn（rewindTo 6，落在两条压缩事件之间）→ 新摘要（seq9）被遮蔽
    writer.close();

    const messages = buildChatMessages(loadSession(dir));
    // 旧摘要（seq6）仍是最新活动压缩 → 覆盖 seq<=3；保留区 = u2, a2 原文
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0]!.content).toBe(`${COMPACTION_SUMMARY_PREFIX}\n旧摘要\n\nu2`);
    expect(messages[1]!.content).toBe('a2');
    expect(messages.some((m) => m.content.includes('新摘要'))).toBe(false);
    expect(messages.some((m) => m.content.includes('u3'))).toBe(false);
  });
});

describe('Model-visible ⟺ logged 不变量扩展（含压缩）', () => {
  it('每个 step/start 的请求（含摘要替换）可从日志独立重建', async () => {
    const dir = tmpDir();
    const writer = SessionWriter.create(dir, { sessionId: 'invariant' }, { fsync: false });
    seedMessages(writer, [long(200, 'A'), long(200, 'B'), long(5, 'c'), long(5, 'd'), long(5, 'e'), long(5, 'f'), long(5, 'g'), long(5, 'h')]);
    const summarizer = summarizerStub('回放摘要');
    const provider = new MockProvider([{ text: 't1' }, { text: 't2' }]);
    await runTurn(writer, {
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: long(10, 'N'),
      compaction: { contextWindow: 128, summarizer },
    });
    await runTurn(writer, {
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: '第二轮',
      compaction: { contextWindow: 128, summarizer },
    });
    writer.close();

    // —— 独立回放：带 seq 的消息流 + 最新压缩生效的替换逻辑（测试内实现） ——
    const session = loadSession(dir);
    computeProjection(session);
    const messages: Array<{ seq: number; role: string; content: string }> = [];
    let compaction: { summary: string; coveredUpToSeq: number } | undefined;
    const expected: string[] = [];
    for (const { event: e, active } of session.events) {
      if (!active) continue;
      if (e.type === 'compaction/applied') {
        compaction = e.payload as { summary: string; coveredUpToSeq: number };
        continue;
      }
      if (e.type === 'step/start') {
        expected.push(JSON.stringify(applyCompactionTestSide(messages, compaction)));
        continue;
      }
      if (e.type === 'user/message') messages.push({ seq: e.seq, role: 'user', content: e.payload.text });
      else if (e.type === 'assistant/message')
        messages.push({ seq: e.seq, role: 'assistant', content: e.payload.text });
    }
    const actual = provider.requests.map((r) => JSON.stringify(r.messages));
    expect(actual).toEqual(expected);
    // 且最终请求确实经历了摘要替换（首条含摘要前缀）
    const lastReq = provider.requests.at(-1)!;
    expect(lastReq.messages[0]!.content).toContain(COMPACTION_SUMMARY_PREFIX);

    function applyCompactionTestSide(
      msgs: Array<{ seq: number; role: string; content: string }>,
      c: { summary: string; coveredUpToSeq: number } | undefined,
    ): Array<{ role: string; content: string }> {
      if (c === undefined) return msgs.map((m) => ({ role: m.role, content: m.content }));
      const kept = msgs.filter((m) => m.seq > c.coveredUpToSeq).map((m) => ({ role: m.role, content: m.content }));
      const summaryText = `${COMPACTION_SUMMARY_PREFIX}\n${c.summary}`;
      if (kept.length === 0) return [{ role: 'user', content: summaryText }];
      if (kept[0]!.role === 'user') kept[0] = { role: 'user', content: `${summaryText}\n\n${kept[0]!.content}` };
      else kept.unshift({ role: 'user', content: summaryText });
      return kept;
    }
  });
});

describe('compaction/applied 校验（写入口 + 解析层）', () => {
  it('writer：空 summary / 越界 coveredUpToSeq 拒绝写入', () => {
    const dir = tmpDir();
    const writer = SessionWriter.create(dir, { sessionId: 'validate' }, { fsync: false });
    writer.append('user/message', { text: 'u1' });
    expect(() => writer.append('compaction/applied', { summary: '', coveredUpToSeq: 2 })).toThrow(
      /summary must be a non-empty string/,
    );
    expect(() => writer.append('compaction/applied', { summary: 'S', coveredUpToSeq: 99 })).toThrow(
      /out of range/,
    );
    writer.append('compaction/applied', { summary: 'S', coveredUpToSeq: 2 }); // 合法：不抛
    writer.close();
    const events = loadEvents(dir);
    expect(events.at(-1)!.type).toBe('compaction/applied');
  });

  it('parseEventLine：payload 缺字段/类型不符 → null（非法行不进投影）', async () => {
    const { parseEventLine } = await import('../src/session/types.js');
    const base = JSON.stringify({ v: 1, seq: 3, ts: 't', type: 'compaction/applied' });
    expect(parseEventLine(`${base} summary: "" , coveredUpToSeq: 1 }`)).toBeNull(); // 非法 JSON
    expect(
      parseEventLine(JSON.stringify({ v: 1, seq: 3, ts: 't', type: 'compaction/applied', payload: { summary: '', coveredUpToSeq: 1 } })),
    ).toBeNull();
    expect(
      parseEventLine(JSON.stringify({ v: 1, seq: 3, ts: 't', type: 'compaction/applied', payload: { summary: 'S', coveredUpToSeq: 0 } })),
    ).toBeNull();
    expect(
      parseEventLine(JSON.stringify({ v: 1, seq: 3, ts: 't', type: 'compaction/applied', payload: { summary: 'S', coveredUpToSeq: 1.5 } })),
    ).toBeNull();
    expect(
      parseEventLine(JSON.stringify({ v: 1, seq: 3, ts: 't', type: 'compaction/applied', payload: { summary: 'S', coveredUpToSeq: 3 } })),
    ).not.toBeNull();
  });
});
