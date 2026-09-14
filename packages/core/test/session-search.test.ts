// H-11 会话全文检索（索引化）测试：分词口径 / 索引可重建（增量==全量） /
// 遮蔽等价（与 reader.computeProjection 逐例对照，含 redo 链）/ 检索语义（AND/OR、CJK、limit）/
// 幂等不重扫（update 返回 added=0 且对象同一）/ 删除重建一致 / LLM 摘要注入与降级 / 性能有界。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SessionManager } from '../src/session/manager.js';
import { SessionWriter } from '../src/session/writer.js';
import { SESSION_LOG_FILE } from '../src/session/types.js';
import { computeProjection, loadSession } from '../src/session/reader.js';
import { generateSyntheticEvents, writeSyntheticSession, BENCH_SEARCH_WORD } from '../src/session/bench.js';
import {
  SEARCH_INDEX_FILE,
  SessionSearchIndex,
  rebuildSessionIndex,
  removeSessionIndex,
  searchInIndex,
  searchSessionIndex,
  summarizeSearchResults,
  tokenizeQuery,
  tokenizeSessionText,
} from '../src/session/searchIndex.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-search-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造会话（返回 writer，便于后续继续追加） */
function createSession(root: string, cwd: string, sessionId?: string) {
  const mgr = new SessionManager(root);
  return mgr.create(cwd, { fsync: false, ...(sessionId !== undefined ? { id: sessionId } : {}) });
}

describe('H-11 分词口径', () => {
  it('NFKC + 小写归一，全角与半角命中一致', () => {
    expect(tokenizeSessionText('Hello WORLD')).toEqual(['hello', 'world']);
    expect(tokenizeSessionText('ＡＢＣ１２３')).toEqual(['abc123']);
  });

  it('CJK 单字 + 相邻双字（可检索到「压缩」这类词）', () => {
    const tokens = tokenizeSessionText('会话压缩');
    expect(tokens).toContain('会');
    expect(tokens).toContain('会话');
    expect(tokens).toContain('话压');
    expect(tokens).toContain('压缩');
  });

  it('标点/空白为分隔符，超长 token 截断到上限', () => {
    expect(tokenizeSessionText('a,b;c\nd')).toEqual(['a', 'b', 'c', 'd']);
    expect(tokenizeSessionText('x'.repeat(200))[0]!.length).toBe(64);
  });

  it('查询分词去重且保持顺序', () => {
    expect(tokenizeQuery('alpha BETA alpha')).toEqual(['alpha', 'beta']);
    expect(tokenizeQuery('   ')).toEqual([]);
  });
});

describe('H-11 索引构建与可重建性', () => {
  it('全量重建结果与增量维护结果深度一致（不漏不重）', () => {
    const root = tmpDir();
    const cwd = join(root, 'proj');
    const { dir, writer } = createSession(root, cwd, '20260914-000000-aa0001');
    writer.append('user/message', { text: 'first quantum request' });
    writer.append('assistant/message', { text: 'answer one' });
    const indexPath = join(dir, SEARCH_INDEX_FILE);
    const index = new SessionSearchIndex(dir);
    index.update(); // 首次：构建并落盘
    expect(existsSync(indexPath)).toBe(true);
    // 追加后增量
    writer.append('user/message', { text: 'second quantum request' });
    writer.append('assistant/message', { text: 'answer two' });
    const incremental = index.update();
    expect(incremental.rebuilt).toBe(false);
    expect(incremental.added).toBe(2);
    // 全量重建（同目录）必须与增量结果逐字段一致
    const full = rebuildSessionIndex(dir);
    expect(full).toEqual(incremental.index);
    writer.close();
  });

  it('日志未变化时 update 是纯 no-op（同一缓存对象、索引文件 mtime 不变）', () => {
    const root = tmpDir();
    const { dir, writer } = createSession(root, join(root, 'p'), '20260914-000000-aa0002');
    writer.append('user/message', { text: 'stable content quantum' });
    const index = new SessionSearchIndex(dir);
    const first = index.update();
    const mtimeBefore = statSync(join(dir, SEARCH_INDEX_FILE)).mtimeMs;
    const second = index.update();
    expect(second.added).toBe(0);
    expect(second.rebuilt).toBe(false);
    expect(second.index).toBe(first.index);
    expect(statSync(join(dir, SEARCH_INDEX_FILE)).mtimeMs).toBe(mtimeBefore);
    writer.close();
  });

  it('日志被截断/替换（变小）→ 自动全量重建，结果与新事实源一致', () => {
    const root = tmpDir();
    const { dir, writer } = createSession(root, join(root, 'p'), '20260914-000000-aa0003');
    writer.append('user/message', { text: 'alpha quantum original' });
    writer.append('assistant/message', { text: 'beta reply' });
    writer.close();
    const index = new SessionSearchIndex(dir);
    index.update();
    // 直接重写日志（模拟外部替换成更短的历史）
    const shorter =
      [
        JSON.stringify({
          v: 1,
          seq: 1,
          ts: '2026-09-14T00:00:00.000Z',
          type: 'session/header',
          payload: { sessionId: '20260914-000000-aa0003' },
        }),
        JSON.stringify({
          v: 1,
          seq: 2,
          ts: '2026-09-14T00:00:01.000Z',
          type: 'user/message',
          payload: { text: 'gamma quantum replaced' },
        }),
      ].join('\n') + '\n';
    writeFileSync(join(dir, SESSION_LOG_FILE), shorter, 'utf8');
    const updated = index.update();
    expect(updated.rebuilt).toBe(true);
    const result = index.search('quantum', { sync: false });
    expect(result.hits.map((h) => h.seq)).toEqual([2]);
  });

  it('删除索引后自动重建，结果与删除前一致（指数级派生，事实源零触碰）', () => {
    const root = tmpDir();
    const { dir, writer } = createSession(root, join(root, 'p'), '20260914-000000-aa0004');
    writer.append('user/message', { text: 'delete me quantum' });
    writer.append('assistant/message', { text: 'ok quantum too' });
    writer.close();
    const before = searchSessionIndex(dir, 'quantum');
    expect(before.hits).toHaveLength(2);
    expect(removeSessionIndex(dir)).toBe(true);
    expect(existsSync(join(dir, SEARCH_INDEX_FILE))).toBe(false);
    const after = searchSessionIndex(dir, 'quantum');
    expect(after.hits).toEqual(before.hits);
    expect(existsSync(join(dir, SEARCH_INDEX_FILE))).toBe(true); // 检索时按需重建并落盘
    expect(removeSessionIndex(dir)).toBe(true);
  });

  it('损坏的索引文件被忽略并重建（不阻塞检索）', () => {
    const root = tmpDir();
    const { dir, writer } = createSession(root, join(root, 'p'), '20260914-000000-aa0005');
    writer.append('user/message', { text: 'corrupt index quantum' });
    writer.close();
    writeFileSync(join(dir, SEARCH_INDEX_FILE), '{not json', 'utf8');
    const result = searchSessionIndex(dir, 'quantum');
    expect(result.hits).toHaveLength(1);
  });

  it('坏行容错：非法行被跳过并计数，其余消息仍可检索（与 loadSession 同口径）', () => {
    const root = tmpDir();
    const { dir, writer } = createSession(root, join(root, 'p'), '20260914-000000-aa0006');
    writer.append('user/message', { text: 'kept quantum' });
    writer.close();
    const log = join(dir, SESSION_LOG_FILE);
    writeFileSync(log, `${readFileSync(log, 'utf8')}not-json-line\n`, 'utf8');
    const data = rebuildSessionIndex(dir);
    expect(data.badLines).toBe(1);
    expect(searchSessionIndex(dir, 'quantum').hits).toHaveLength(1);
  });

  it('索引绝不改写事实源（构建/更新前后日志字节一致）', () => {
    const root = tmpDir();
    const { dir, writer } = createSession(root, join(root, 'p'), '20260914-000000-aa0007');
    writer.append('user/message', { text: 'append only quantum' });
    writer.close();
    const log = join(dir, SESSION_LOG_FILE);
    const before = readFileSync(log);
    const index = new SessionSearchIndex(dir);
    index.update();
    index.search('quantum');
    index.rebuild();
    index.update();
    expect(readFileSync(log).equals(before)).toBe(true);
  });
});

describe('H-11 遮蔽（rewind/redo）等价性：索引 vs reader.computeProjection', () => {
  /** 构造带 rewind/redo 的会话；断言索引活动消息数与命中集合与投影逐例一致 */
  function expectShadowingEquivalent(build: (w: SessionWriter) => void): void {
    const root = tmpDir();
    const { dir, writer } = createSession(root, join(root, 'p'), '20260914-000000-bb0001');
    build(writer);
    writer.close();
    const session = loadSession(dir);
    const projection = computeProjection(session);
    const data = rebuildSessionIndex(dir);
    const stats = searchInIndex(data, dir, 'zzz', {}); // 空命中：只取统计字段
    expect(stats.activeMessages).toBe(projection.messages.length);
    expect(stats.totalMessages).toBe(data.messages.length);
    // 用真实检索核对命中集合（每条测试消息都含 'common'）
    const hits = searchInIndex(data, dir, 'common');
    expect(hits.hits.map((h) => h.seq).sort((a, b) => a - b)).toEqual(
      projection.messages.filter((m) => m.text.includes('common')).map((m) => m.seq),
    );
  }

  it('单次 undo：被遮蔽消息不出现在检索结果中', () => {
    expectShadowingEquivalent((w) => {
      w.append('user/message', { text: 'common first' });
      w.append('assistant/message', { text: 'common reply first' });
      w.append('user/message', { text: 'common second' });
      w.append('assistant/message', { text: 'common reply second' });
      w.append('rewind/marker', { rewindToSeq: 1, reason: 'undo' });
      w.append('user/message', { text: 'common third after rewind' });
    });
  });

  it('undo + redo 链：每次 redo 只复活一层（与投影同口径）', () => {
    expectShadowingEquivalent((w) => {
      w.append('user/message', { text: 'common u1' });
      w.append('assistant/message', { text: 'common a1' });
      w.append('user/message', { text: 'common u2' });
      w.append('assistant/message', { text: 'common a2' });
      w.append('rewind/marker', { rewindToSeq: 2, reason: 'undo' }); // seq 5：遮蔽 seq 3..4
      w.append('rewind/marker', { rewindToSeq: 4, reason: 'redo' }); // seq 6：中立化 seq 5（逐层复活）
    });
  });

  it('n 级 undo/redo 链逐层复活', () => {
    expectShadowingEquivalent((w) => {
      w.append('user/message', { text: 'common u1' });
      w.append('assistant/message', { text: 'common a1' });
      w.append('user/message', { text: 'common u2' });
      w.append('assistant/message', { text: 'common a2' });
      w.append('user/message', { text: 'common u3' });
      w.append('rewind/marker', { rewindToSeq: 4, reason: 'undo' }); // seq 6 遮蔽 5
      w.append('rewind/marker', { rewindToSeq: 3, reason: 'undo' }); // seq 7 遮蔽 4..5
      w.append('rewind/marker', { rewindToSeq: 6, reason: 'redo' }); // seq 8 中立化 seq 7
      w.append('rewind/marker', { rewindToSeq: 5, reason: 'redo' }); // seq 9 中立化 seq 6... 逐层
    });
  });
});

describe('H-11 检索语义', () => {
  it('默认 AND（全部 token 命中）；--or 放宽为任一命中', () => {
    const root = tmpDir();
    const cwd = join(root, 'p');
    const { writer } = createSession(root, cwd, '20260914-000000-cc0001');
    writer.append('user/message', { text: 'alpha beta both' });
    writer.append('assistant/message', { text: 'alpha only' });
    writer.close();
    const mgr = new SessionManager(root);
    const and = mgr.searchIndexed(cwd, 'alpha beta');
    expect(and).toHaveLength(1);
    expect(and[0]!.hits.map((h) => h.seq)).toEqual([2]);
    const or = mgr.searchIndexed(cwd, 'alpha beta', { mode: 'or' });
    expect(or[0]!.hits.map((h) => h.seq).sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('大小写不敏感、CJK 双字可命中、片段带上下文且 ≤60 字', () => {
    const root = tmpDir();
    const cwd = join(root, 'p');
    const { writer } = createSession(root, cwd, '20260914-000000-cc0002');
    writer.append('user/message', { text: '请帮我分析会话压缩的实现路径与阈值' });
    writer.append('assistant/message', { text: 'OK' });
    writer.close();
    const mgr = new SessionManager(root);
    const hits = mgr.searchIndexed(cwd, '压缩');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.hits[0]!.snippet).toContain('压缩');
    expect(hits[0]!.hits[0]!.snippet.length).toBeLessThanOrEqual(61);
    expect(mgr.searchIndexed(cwd, '会话压缩')).toHaveLength(1);
    expect(mgr.searchIndexed(cwd, '不存在词')).toHaveLength(0);
  });

  it('limit 生效，得分降序（命中更多 token / 词频更高者在前）', () => {
    const root = tmpDir();
    const cwd = join(root, 'p');
    const { writer } = createSession(root, cwd, '20260914-000000-cc0003');
    writer.append('user/message', { text: 'needle' });
    writer.append('user/message', { text: 'needle needle needle payload' });
    writer.append('user/message', { text: 'needle haystack' });
    writer.close();
    const mgr = new SessionManager(root);
    const all = mgr.searchIndexed(cwd, 'needle');
    expect(all[0]!.hits).toHaveLength(3); // manager 层最多 3 条片段
    const single = mgr.searchIndexed(cwd, 'needle', { limit: 1 });
    // 词频最高的 seq 3 应排第一
    expect(single[0]!.hits[0]!.seq).toBe(3);
  });

  it('空查询返回空；索引检索与线性 search 的命中集合在无 rewind 时一致（语义交叉校验）', () => {
    const root = tmpDir();
    const cwd = join(root, 'p');
    const { writer } = createSession(root, cwd, '20260914-000000-cc0004');
    writer.append('user/message', { text: 'cross check quantum phrase' });
    writer.append('assistant/message', { text: 'no hit here' });
    writer.append('user/message', { text: 'another quantum mention' });
    writer.close();
    const mgr = new SessionManager(root);
    expect(mgr.searchIndexed(cwd, '   ')).toEqual([]);
    const linear = mgr.search(cwd, 'quantum');
    const indexed = mgr.searchIndexed(cwd, 'quantum');
    expect(indexed.map((h) => h.id)).toEqual(linear.map((h) => h.id));
    expect(indexed[0]!.hits.map((h) => h.seq).sort((a, b) => a - b)).toEqual(
      linear[0]!.hits.map((h) => h.seq).sort((a, b) => a - b),
    );
  });

  it('多会话按 mtime 倒序返回；cwd 过滤只搜该组', () => {
    const root = tmpDir();
    const cwdA = join(root, 'a');
    const cwdB = join(root, 'b');
    const a = createSession(root, cwdA, '20260914-000000-dd0001');
    a.writer.append('user/message', { text: 'shared quantum a' });
    a.writer.close();
    const b = createSession(root, cwdB, '20260914-000000-dd0002');
    b.writer.append('user/message', { text: 'shared quantum b' });
    b.writer.close();
    utimesSync(join(a.dir, SESSION_LOG_FILE), new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
    const mgr = new SessionManager(root);
    const all = mgr.searchIndexed(undefined, 'quantum');
    expect(all.map((h) => h.id)).toEqual(['20260914-000000-dd0002', '20260914-000000-dd0001']);
    expect(mgr.searchIndexed(cwdA, 'quantum').map((h) => h.id)).toEqual(['20260914-000000-dd0001']);
    // 标题/摘要字段仍可用（与 SessionSummary 形状兼容）
    expect(all[0]!.firstUserText).toContain('quantum');
    expect(typeof all[0]!.score).toBe('number');
  });
});

describe('H-11 /reindex 与 dropIndexes（可重建命令口径）', () => {
  it('reindex 全库重建并统计；dropIndexes 删除全部索引后检索仍可用（自动重建）', () => {
    const root = tmpDir();
    const cwd = join(root, 'p');
    const a = createSession(root, cwd, '20260914-000000-ee0001');
    a.writer.append('user/message', { text: 'reindex quantum one' });
    a.writer.close();
    const b = createSession(root, cwd, '20260914-000000-ee0002');
    b.writer.append('user/message', { text: 'reindex quantum two' });
    b.writer.close();
    const mgr = new SessionManager(root);
    const report = mgr.reindex();
    expect(report).toMatchObject({ sessions: 2, indexed: 2, failures: [] });
    expect(report.messages).toBe(2);
    expect(existsSync(join(a.dir, SEARCH_INDEX_FILE))).toBe(true);
    expect(mgr.dropIndexes()).toBe(2);
    expect(existsSync(join(a.dir, SEARCH_INDEX_FILE))).toBe(false);
    expect(mgr.searchIndexed(cwd, 'quantum')).toHaveLength(2);
  });
});

describe('H-11 LLM 摘要为注入式（未注入即如实降级）', () => {
  it('未注入 → source=snippets，输出原文片段拼接，不伪造摘要', async () => {
    const result = await summarizeSearchResults('q', [{ sessionId: 's1', snippet: '片段一' }], {});
    expect(result.source).toBe('snippets');
    expect(result.summary).toContain('片段一');
    expect(result.fallbackReason).toBeUndefined();
  });

  it('注入成功 → source=llm（core 内无模型调用硬编）', async () => {
    const result = await summarizeSearchResults('q', [{ sessionId: 's1', snippet: 'x' }], {
      summarizer: async ({ query, hits }) => `关于「${query}」的 ${hits.length} 条命中摘要`,
    });
    expect(result).toMatchObject({ source: 'llm' });
    expect(result.summary).toContain('1 条命中');
  });

  it('注入方抛错/返回空 → 降级为片段并登记原因', async () => {
    const boom = await summarizeSearchResults('q', [{ sessionId: 's1', snippet: 'y' }], {
      summarizer: async () => {
        throw new Error('provider 不可用');
      },
    });
    expect(boom.source).toBe('snippets');
    expect(boom.fallbackReason).toContain('provider 不可用');
    const empty = await summarizeSearchResults('q', [{ sessionId: 's1', snippet: 'y' }], {
      summarizer: async () => '   ',
    });
    expect(empty.source).toBe('snippets');
    expect(empty.fallbackReason).toContain('空摘要');
  });
});

describe('H-11 性能：万级事件日志检索时延有界', () => {
  it('10k 事件：索引构建/热查询耗时上界 + 索引文件规模可核', () => {
    const root = tmpDir();
    const { dir } = writeSyntheticSession(root, { events: 10_000, seed: 42 });
    const mgr = new SessionManager(root);
    const buildStart = performance.now();
    const report = mgr.reindex();
    const buildMs = performance.now() - buildStart;
    expect(report.failures).toEqual([]);
    const logBytes = statSync(join(dir, SESSION_LOG_FILE)).size;
    const indexBytes = statSync(join(dir, SEARCH_INDEX_FILE)).size;
    const index = new SessionSearchIndex(dir);
    index.load(); // 预热（解析索引文件）
    const queryStart = performance.now();
    const hits = index.search(BENCH_SEARCH_WORD);
    const queryMs = performance.now() - queryStart;
    // 相对线性扫描：同一查询下线性实现（loadSession + 投影）的耗时（全库口径）
    const linearStart = performance.now();
    mgr.search(undefined, BENCH_SEARCH_WORD);
    const linearMs = performance.now() - linearStart;
    const data = rebuildSessionIndex(dir);
    // 断言（宽松上界，避免 CI 抖动误红）：建索引 < 5s、热查询 < 500ms、token 规模有界
    expect(buildMs).toBeLessThan(5000);
    expect(queryMs).toBeLessThan(500);
    expect(hits.hits.length).toBeGreaterThan(0);
    expect(data.messages.length).toBeGreaterThan(1000);
    // 证据打印（报告数据来源）
    const summary = `[P7-B H-11 bench] events=${generateSyntheticEvents({ events: 10_000, seed: 42 }).length} log=${Math.round(logBytes / 1024)}KiB index=${Math.round(indexBytes / 1024)}KiB build=${buildMs.toFixed(0)}ms warmQuery=${queryMs.toFixed(1)}ms linearQuery=${linearMs.toFixed(1)}ms tokens=${index.stats().tokens}`;
    process.stdout.write(`${summary}\n`);
  });
});
