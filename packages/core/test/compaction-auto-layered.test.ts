// Z6-A05-1 自动压缩分层接入测试：0.75 触发 → 分层落盘（compaction/applied + turn 明细）；
// 摘要失败语义保持（不落事件、下轮重试）；分层不可用 → 回退单层（不双落事件）。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn } from '../src/agent/loop.js';
import { COMPACTION_SUMMARY_PREFIX } from '../src/agent/compaction.js';
import { MockProvider } from '../src/provider/mock.js';
import { SessionWriter } from '../src/session/writer.js';
import { SESSION_LOG_FILE, type AnySessionEvent } from '../src/session/types.js';
import { COMPACTION_LAYERS_FILE, CompactionLayerStore } from '../src/session/layeredCompaction.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ChatProvider, ChatRequest } from '../src/provider/types.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-auto-layer-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function loadEvents(dir: string): AnySessionEvent[] {
  return readEventsFile(join(dir, SESSION_LOG_FILE));
}

function readEventsFile(path: string): AnySessionEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AnySessionEvent);
}

/** 摘要 provider stub：固定回复 + 记录请求 */
function summarizerStub(reply = '这是摘要'): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    name: 'stub-summarizer',
    requests,
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
    // eslint-disable-next-line require-yield -- 失败 stub：不产出任何块，直接抛错
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

function makeSession(id: string): { dir: string; writer: SessionWriter } {
  const dir = tmpDir();
  const writer = SessionWriter.create(dir, { sessionId: id }, { fsync: false });
  return { dir, writer };
}

describe('A05-1 自动路径分层压缩（runTurn + compaction 选项）', () => {
  it('0.75 触发 → compaction/applied 落盘 + turn 明细写 compaction.layers.jsonl（session 层）', async () => {
    const { dir, writer } = makeSession('auto-layer');
    seedMessages(writer, [
      long(200, 'A'),
      long(200, 'B'),
      long(5, 'c'),
      long(5, 'd'),
      long(5, 'e'),
      long(5, 'f'),
      long(5, 'g'),
      long(5, 'h'),
    ]);
    const summarizer = summarizerStub('覆盖区摘要内容');
    const provider = new MockProvider([{ text: 'turn 回复' }]);

    const r = await runTurn(writer, {
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: long(10, 'N'),
      compaction: { contextWindow: 128, summarizer },
    });
    expect(r.stopReason).toBe('end_turn');
    expect(r.warning).toBeUndefined();

    // 会话级摘要事件：形状与既有单层一致，summary = 摘要 provider 产物
    const compactions = loadEvents(dir).filter((e) => e.type === 'compaction/applied');
    expect(compactions).toHaveLength(1);
    const payload = compactions[0]!.payload as { summary: string; coveredUpToSeq: number };
    expect(payload.summary).toBe('覆盖区摘要内容');

    // 分层明细：turn 层 + session 层记录落辅助文件，session 层 summary 与事件一致
    const store = new CompactionLayerStore(dir);
    const records = store.records();
    expect(records.some((rec) => rec.layer === 'session' && rec.summary === '覆盖区摘要内容')).toBe(true);
    expect(records.filter((rec) => rec.layer === 'turn').length).toBeGreaterThan(0);
    const sessionRec = records.find((rec) => rec.layer === 'session');
    expect(sessionRec?.coveredUpToSeq).toBe(payload.coveredUpToSeq);

    // 模型请求首条 = 摘要消息（分层事件被 buildChatMessages 原样消费——事件形状未变）
    const req = provider.requests[0]!;
    expect(req.messages[0]).toEqual({ role: 'user', content: `${COMPACTION_SUMMARY_PREFIX}\n覆盖区摘要内容` });
    writer.close();
  });

  it('摘要失败 → 不落事件、不写分层明细、warning 告知下轮重试（既有语义保持）', async () => {
    const { dir, writer } = makeSession('auto-layer-fail');
    seedMessages(writer, [
      long(200, 'A'),
      long(200, 'B'),
      long(5, 'c'),
      long(5, 'd'),
      long(5, 'e'),
      long(5, 'f'),
      long(5, 'g'),
      long(5, 'h'),
    ]);
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
    expect(loadEvents(dir).some((e) => e.type === 'session/header')).toBe(true); // 日志正常
    writer.close();
  });

  it('分层不可用（明细辅助文件写失败）→ 回退单层：恰好一条 compaction/applied + 如实 warning', async () => {
    const { dir, writer } = makeSession('auto-layer-broken');
    seedMessages(writer, [
      long(200, 'A'),
      long(200, 'B'),
      long(5, 'c'),
      long(5, 'd'),
      long(5, 'e'),
      long(5, 'f'),
      long(5, 'g'),
      long(5, 'h'),
    ]);
    // 让明细辅助文件路径不可写：同名目录占位 → CompactionLayerStore.append 抛错
    mkdirSync(join(dir, COMPACTION_LAYERS_FILE));
    const summarizer = summarizerStub('回退摘要');
    const provider = new MockProvider([{ text: 'turn 回复' }]);
    const result = await runTurn(writer, {
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: long(10, 'N'),
      compaction: { contextWindow: 128, summarizer },
    });
    expect(result.stopReason).toBe('end_turn');
    expect(result.warning).toContain('分层压缩明细落盘失败');
    // 压缩本身已生效：恰好一条事件（事件在明细失败前已落，回退不重复 append）
    const compactions = loadEvents(dir).filter((e) => e.type === 'compaction/applied');
    expect(compactions).toHaveLength(1);
    expect((compactions[0]!.payload as { summary: string }).summary).toBe('回退摘要');
    // 模型请求仍吃到摘要替换
    expect(provider.requests[0]!.messages[0]!.content).toContain('回退摘要');
    writer.close();
  });

  it('未达阈值：不触发（无事件、无明细文件、摘要不被调用）', async () => {
    const { dir, writer } = makeSession('auto-layer-quiet');
    seedMessages(writer, ['短一', '短二']);
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
    writer.close();
  });
});
