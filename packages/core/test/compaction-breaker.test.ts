// Z6-A05-2 压缩断路器测试：连续 3 次自动压缩失败 → 熔断（本会话停用自动压缩 + 一次性
// 明确 warning）；成功清零；手动 /compact 路径（applyLayeredCompaction 直调）不受熔断影响；
// 新会话（新实例）重置。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn } from '../src/agent/loop.js';
import { CompactionBreaker, DEFAULT_MAX_CONSECUTIVE_COMPACTION_FAILURES } from '../src/agent/compactionBreaker.js';
import { MockProvider } from '../src/provider/mock.js';
import { loadSession } from '../src/session/reader.js';
import { SessionWriter } from '../src/session/writer.js';
import { SESSION_LOG_FILE, type AnySessionEvent } from '../src/session/types.js';
import { applyLayeredCompaction } from '../src/session/layeredCompaction.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ChatProvider } from '../src/provider/types.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-cbreaker-'));
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

/** 抛错且计数的摘要 provider stub（自动压缩恒失败） */
function summarizerBoomCounting(): ChatProvider & { attempts: number } {
  const state: { attempts: number } = { attempts: 0 };
  return {
    name: 'boom-summarizer',
    get attempts(): number {
      return state.attempts;
    },
    // eslint-disable-next-line require-yield -- 失败 stub：不产出任何块，直接抛错
    async *streamChat(): AsyncIterable<never> {
      state.attempts += 1;
      throw new Error('summarizer endpoint down');
    },
  } as ChatProvider & { attempts: number };
}

const long = (n: number, tag = 'x'): string => tag.repeat(n);

function seedMessages(writer: SessionWriter, texts: string[]): void {
  for (const text of texts) {
    writer.append('user/message', { text });
    writer.append('assistant/message', { text: `回复:${text}` });
  }
}

describe('CompactionBreaker（单元）', () => {
  it('默认阈值 3：连续 3 次失败 → 熔断；未达阈值返回 false', () => {
    expect(DEFAULT_MAX_CONSECUTIVE_COMPACTION_FAILURES).toBe(3);
    const breaker = new CompactionBreaker();
    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.recordFailure()).toBe(false);
    expect(breaker.recordFailure()).toBe(false);
    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.recordFailure()).toBe(true); // 第 3 次 → 触发
    expect(breaker.canAttempt()).toBe(false);
    expect(breaker.snapshot()).toEqual({ consecutiveFailures: 3, tripped: true });
  });

  it('成功清零计数（对齐工具熔断「成功即重置」）；熔断粘性：成功不解熔', () => {
    const breaker = new CompactionBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
    expect(breaker.recordFailure()).toBe(false); // 计数从 0 重新起算
    // 熔断后 recordSuccess 不解除
    const tripped = new CompactionBreaker(1);
    expect(tripped.recordFailure()).toBe(true);
    tripped.recordSuccess();
    expect(tripped.canAttempt()).toBe(false);
  });

  it('阈值 <= 0 = 关闭熔断；新实例 = 新会话重置', () => {
    const disabled = new CompactionBreaker(0);
    for (let i = 0; i < 10; i++) expect(disabled.recordFailure()).toBe(false);
    expect(disabled.canAttempt()).toBe(true);
    // 新会话：新实例从零开始（hub 按会话 id 懒创建的语义）
    expect(new CompactionBreaker().canAttempt()).toBe(true);
  });
});

describe('断路器 × runTurn（自动压缩路径）', () => {
  function makeSession(id: string): { dir: string; writer: SessionWriter } {
    const dir = tmpDir();
    const writer = SessionWriter.create(dir, { sessionId: id }, { fsync: false });
    return { dir, writer };
  }

  it('3 连败熔断：第 3 次 warning 明确熔断；其后静默跳过、不再尝试摘要', async () => {
    const { dir, writer } = makeSession('breaker-trip');
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
    const summarizer = summarizerBoomCounting();
    const breaker = new CompactionBreaker();
    const provider = new MockProvider([{ text: 't1' }, { text: 't2' }, { text: 't3' }, { text: 't4' }, { text: 't5' }]);

    const r1 = await runTurn(writer, {
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: long(10, 'N'),
      compaction: { contextWindow: 128, summarizer, breaker },
    });
    expect(r1.warning).toContain('上下文压缩失败已跳过');
    const r2 = await runTurn(writer, {
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: long(10, 'N'),
      compaction: { contextWindow: 128, summarizer, breaker },
    });
    expect(r2.warning).toContain('上下文压缩失败已跳过');
    const r3 = await runTurn(writer, {
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: long(10, 'N'),
      compaction: { contextWindow: 128, summarizer, breaker },
    });
    // 第 3 次失败 → 熔断 warning（明确一次，含阈值与手动不受影响说明）
    expect(r3.warning).toContain('已熔断');
    expect(r3.warning).toContain('本会话停用自动压缩');
    expect(r3.warning).toContain('手动 /compact 不受影响');
    expect(r3.warning).toContain('summarizer endpoint down');
    expect(breaker.snapshot()).toEqual({ consecutiveFailures: 3, tripped: true });

    // 熔断后：自动压缩静默跳过（无 warning、无摘要尝试）
    const r4 = await runTurn(writer, {
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: long(10, 'N'),
      compaction: { contextWindow: 128, summarizer, breaker },
    });
    expect(r4.stopReason).toBe('end_turn');
    expect(r4.warning).toBeUndefined();
    expect(summarizer.attempts).toBe(3); // 只尝试 3 次，熔断后不再调用
    expect(loadEvents(dir).some((e) => e.type === 'compaction/applied')).toBe(false);
    writer.close();
  });

  it('失败后成功即清零：两次失败 + 一次成功 + 再两次失败不熔断', async () => {
    const { dir, writer } = makeSession('breaker-reset');
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
    const breaker = new CompactionBreaker();
    // 前两次 turn 用坏摘要器，之后换好摘要器（stub 固定回复）；长 userText 保证每 turn 都越过阈值
    const boom = summarizerBoomCounting();
    const good: ChatProvider = {
      name: 'good-summarizer',
      async *streamChat() {
        yield { type: 'text-delta' as const, text: '恢复后的摘要' };
      },
    };
    const provider = new MockProvider([{ text: 't1' }, { text: 't2' }, { text: 't3' }, { text: 't4' }, { text: 't5' }]);
    const opts = (summarizer: ChatProvider) => ({
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: long(400, 'N'),
      compaction: { contextWindow: 128, summarizer, breaker },
    });
    await runTurn(writer, opts(boom)); // 失败 1
    await runTurn(writer, opts(boom)); // 失败 2
    // 换好摘要器再触发一次压缩：成功 → 计数清零
    const okTurn = await runTurn(writer, opts(good));
    expect(okTurn.warning).toBeUndefined();
    expect(loadEvents(dir).some((e) => e.type === 'compaction/applied')).toBe(true);
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
    // 之后再失败两次：未达 3 → 不熔断
    await runTurn(writer, opts(boom)); // 失败 1（重新计数）
    const last = await runTurn(writer, opts(boom)); // 失败 2
    expect(last.warning).toContain('上下文压缩失败已跳过');
    expect(breaker.snapshot()).toEqual({ consecutiveFailures: 2, tripped: false });
    writer.close();
  });

  it('手动 /compact 路径不受熔断影响：熔断后 applyLayeredCompaction 直调仍可执行', async () => {
    const { dir, writer } = makeSession('breaker-manual');
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
    const summarizer = summarizerBoomCounting();
    const breaker = new CompactionBreaker();
    const provider = new MockProvider([{ text: 't1' }, { text: 't2' }, { text: 't3' }]);
    const opts = () => ({
      provider,
      tools: new ToolRegistry(),
      cwd: dir,
      userText: long(10, 'N'),
      compaction: { contextWindow: 128, summarizer, breaker },
    });
    await runTurn(writer, opts());
    await runTurn(writer, opts());
    await runTurn(writer, opts());
    expect(breaker.snapshot().tripped).toBe(true);

    // 手动压缩（/compact 与 /compact-layers 的 core 实现）不消费断路器：强制 session 层直接执行
    const manual = await applyLayeredCompaction(writer, loadSession(dir), { layer: 'session' });
    expect(manual).not.toBeNull();
    expect(manual?.layer).toBe('session');
    expect(loadEvents(dir).some((e) => e.type === 'compaction/applied')).toBe(true);
    writer.close();
  });
});
