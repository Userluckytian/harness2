// 性能基线（阶段 11 Task 1，消化审查 P2-4 大日志留档）：
//   - 合成日志生成器：确定性 PRNG（mulberry32，同 seed 同日志）生成 N 事件量级会话
//     （user/assistant 混合 + tool 比例 + 若干 rewind/marker），写入会话库布局供测量；
//   - runSessionBench：计时 loadSession / computeProjection / 会话 list / 搜索 /
//     exportSession / importReplay，输出表（architecture.md「性能预算」节的数据来源）。
// 边界：合成日志是基准测量夹具，不是事件模型扩展（零新增事件类型）；
// 生成器放本模块供测试小样本复用（确定性/形状校验），大样本跑 scripts/bench-session.mjs。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadSession, computeProjection, type LoadedSession } from './reader.js';
import { SessionManager, encodeCwd, SESSION_ID_PATTERN } from './manager.js';
import { exportSession, importReplay } from './export.js';
import { SESSION_LOG_FILE, type AnySessionEvent } from './types.js';

/** 合成日志选项（确定性：同 seed 同事件序列） */
export interface SyntheticLogOptions {
  /** 事件总数（含 header 与 rewind/marker） */
  events: number;
  /** tool/call + tool/result 对占总事件的比例（缺省 0.2，成对计入） */
  toolRatio?: number;
  /** rewind/marker 数量（缺省 10；均匀穿插，遮蔽窗口 6..20 事件，模拟 undo 尾部回退） */
  rewinds?: number;
  /** PRNG 种子 */
  seed: number;
  /** 会话 id（缺省 '20260907-000000-beef01'，符合 SESSION_ID_PATTERN） */
  sessionId?: string;
}

/** mulberry32：小型确定性 PRNG（32 位状态，同 seed 序列一致，跨平台一致） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 词表（合成文本素材；BENCH_SEARCH_WORD 取自其中保证搜索命中） */
const WORDS = [
  'quantum', 'ledger', 'harvest', 'signal', 'cascade', 'orchard', 'lantern', 'meridian',
  'compass', 'beacon', 'willow', 'summit', 'harbor', 'driftwood', 'cobalt', 'ember',
  'glacier', 'meadow', 'thunder', 'velvet', 'cipher', 'compass', 'aurora', 'basalt',
];

/** 搜索基准用词（生成器文本必然包含） */
export const BENCH_SEARCH_WORD = 'quantum';

/** 确定性伪文本：3..6 句、每句 6..14 个词（种子驱动，同 seed 同文本） */
function fakeText(rng: () => number, minSentences = 3, maxSentences = 6): string {
  const sentences = minSentences + Math.floor(rng() * (maxSentences - minSentences + 1));
  const parts: string[] = [];
  for (let i = 0; i < sentences; i++) {
    const words = 6 + Math.floor(rng() * 9);
    const sentence: string[] = [];
    for (let w = 0; w < words; w++) sentence.push(WORDS[Math.floor(rng() * WORDS.length)]!);
    parts.push(sentence.join(' '));
  }
  return parts.join('. ') + '.';
}

const BENCH_TOOLS = ['bash', 'read', 'write', 'glob', 'grep'] as const;

/** 事件时间戳：base + seq 秒（确定性 ISO 字符串，不含真实当前时间） */
function fakeTs(baseMs: number, seq: number): string {
  return new Date(baseMs + seq * 1000).toISOString();
}

/**
 * 生成合成事件序列（含 header；seq 从 1 连续递增）。
 * 形状：user/assistant 交替为主体，按 toolRatio 概率插入 tool/call+tool/result 对，
 * rewinds 个 rewind/marker 均匀穿插（rewindToSeq 指向标记前 6..20 个事件，模拟 undo）。
 */
export function generateSyntheticEvents(opts: SyntheticLogOptions): AnySessionEvent[] {
  const total = Math.max(1, Math.floor(opts.events));
  const toolRatio = opts.toolRatio ?? 0.2;
  const rewinds = opts.rewinds ?? 10;
  const rng = mulberry32(opts.seed);
  const sessionId = opts.sessionId ?? '20260907-000000-beef01';
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`合成 sessionId 不符合 SESSION_ID_PATTERN: ${sessionId}`);
  }
  const baseMs = Date.UTC(2026, 8, 7, 0, 0, 0);
  const events: AnySessionEvent[] = [];
  const push = <T extends AnySessionEvent['type']>(
    type: T,
    payload: Extract<AnySessionEvent, { type: T }>['payload'],
  ): void => {
    const seq = events.length + 1;
    events.push({ v: 1, seq, ts: fakeTs(baseMs, seq), type, payload } as AnySessionEvent);
  };
  push('session/header', { sessionId, cwd: '/bench/project', createdAt: fakeTs(baseMs, 1) });
  // rewind 穿插点：rewinds 个内插位（total × i/(rewinds+1)）；阈值推进（越过即补放），
  // 避免成对事件（user/assistant、tool 对）跨过精确点位导致漏放
  const rewindPositions: number[] = [];
  for (let i = 1; i <= rewinds; i++) rewindPositions.push(Math.floor((total * i) / (rewinds + 1)));
  let nextRewindIdx = 0;
  while (events.length < total) {
    if (nextRewindIdx < rewindPositions.length && events.length >= rewindPositions[nextRewindIdx]!) {
      const lastSeq = events.length;
      const window = 6 + Math.floor(rng() * 15); // 6..20
      const rewindToSeq = Math.max(1, lastSeq - window);
      push('rewind/marker', { rewindToSeq, reason: 'undo' });
      nextRewindIdx += 1;
      continue;
    }
    if (rng() < toolRatio && events.length + 2 <= total) {
      const tool = BENCH_TOOLS[Math.floor(rng() * BENCH_TOOLS.length)]!;
      const callId = `bench-call-${events.length + 1}`;
      push('tool/call', { callId, tool, args: { target: fakeText(rng, 1, 2) } });
      push('tool/result', { callId, tool, ok: true, output: fakeText(rng) });
      continue;
    }
    push('user/message', { text: fakeText(rng, 1, 3) });
    if (events.length < total) push('assistant/message', { text: fakeText(rng), model: 'bench-model' });
  }
  return events;
}

/** 把合成事件写成会话库布局 <root>/<encoded-cwd>/<id>/session.v1.jsonl（直接整文件写，不走 writer） */
export function writeSyntheticSession(root: string, opts: SyntheticLogOptions): { dir: string; logBytes: number } {
  const events = generateSyntheticEvents(opts);
  const sessionId = opts.sessionId ?? '20260907-000000-beef01';
  const dir = join(root, encodeCwd('/bench/project'), sessionId);
  mkdirSync(dir, { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(dir, SESSION_LOG_FILE), body, 'utf8');
  return { dir, logBytes: Buffer.byteLength(body, 'utf8') };
}

/** 单项测量结果 */
export interface BenchOpResult {
  op: string;
  ms: number;
  detail?: string;
}

/** 基线测量结果（architecture.md「性能预算」表的数据来源） */
export interface SessionBenchResult {
  env: { node: string; platform: string; cpu: string; memoryMiB: number };
  events: number;
  logBytes: number;
  ops: BenchOpResult[];
}

function measure<T>(op: string, fn: () => T, detail?: (r: T) => string): { result: T; record: BenchOpResult } {
  const start = performance.now();
  const result = fn();
  const ms = Math.round(performance.now() - start);
  return { result, record: { op, ms, ...(detail !== undefined ? { detail: detail(result) } : {}) } };
}

/**
 * 跑完整基线：合成日志 → 逐操作计时。outZip 缺省落在临时目录；默认结束时清理临时目录
 * （keepDir: true 保留，供人工检查产物）。loadSession/computeProjection 先跑一次热身后
 * 再测量（JIT 预热；单次测量口径在 architecture.md 如实标注）。
 */
export function runSessionBench(
  opts: SyntheticLogOptions & { keepDir?: boolean } = { events: 100_000, seed: 20260907 },
): SessionBenchResult {
  const { keepDir = false, ...logOpts } = opts;
  const scratch = mkdtempSync(join(tmpdir(), 'h2-bench-'));
  try {
    const sessionsRoot = join(scratch, 'sessions');
    const { dir, logBytes } = writeSyntheticSession(sessionsRoot, logOpts);
    const ops: BenchOpResult[] = [];

    // 热身（不计入）：loadSession + computeProjection 各一次
    const warm = loadSession(dir);
    computeProjection(warm);

    const loaded = measure('loadSession', () => loadSession(dir), (s) => `${s.events.length} events`);
    ops.push(loaded.record);
    const projected = measure(
      'computeProjection',
      () => {
        const s: LoadedSession = { ...loaded.result, events: loaded.result.events.map((e) => ({ ...e })) };
        const p = computeProjection(s);
        return { messages: p.messages.length, shadowed: p.shadowedCount, rewinds: p.rewindCount };
      },
      (r) => `${r.messages} msgs, ${r.shadowed} shadowed, ${r.rewinds} rewinds`,
    );
    ops.push(projected.record);

    const manager = new SessionManager(sessionsRoot);
    const listed = measure('manager.list（全库）', () => manager.list(), (r) => `${r.length} sessions`);
    ops.push(listed.record);
    const searched = measure(
      'manager.search（全库）',
      () => manager.search(undefined, BENCH_SEARCH_WORD),
      (r) => `${r.length} hits`,
    );
    ops.push(searched.record);

    const zipPath = join(scratch, 'bench-export.zip');
    const exported = measure(
      'exportSession',
      () => exportSession(dir, zipPath),
      (r) => `${r.entryCount} entries`,
    );
    ops.push(exported.record);
    const replayed = measure(
      'importReplay',
      () => importReplay(zipPath),
      (r) => `${r.sessions.length} sessions`,
    );
    ops.push(replayed.record);

    return {
      env: {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        cpu: process.env['PROCESSOR_IDENTIFIER'] ?? process.env['PROCESSOR_ARCH'] ?? 'unknown',
        memoryMiB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
      },
      events: loaded.result.events.length,
      logBytes,
      ops,
    };
  } finally {
    if (!keepDir) rmSync(scratch, { recursive: true, force: true });
  }
}

/** 渲染为对齐文本表（scripts/bench-session.mjs 输出用） */
export function formatBenchTable(r: SessionBenchResult): string {
  const lines: string[] = [];
  lines.push(`harness2 会话基线（${r.events} 事件，日志 ${Math.round(r.logBytes / 1024 / 1024)} MiB）`);
  lines.push(`环境: Node ${r.env.node} / ${r.env.platform} / ${r.env.cpu} / rss ${r.env.memoryMiB} MiB`);
  lines.push('操作                          耗时ms   明细');
  for (const op of r.ops) {
    const name = op.op.padEnd(26, ' ');
    const ms = String(op.ms).padStart(7, ' ');
    lines.push(`${name}  ${ms}   ${op.detail ?? ''}`);
  }
  return lines.join('\n');
}
