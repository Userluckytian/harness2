// 性能基线测试（阶段 11 Task 1，消化审查 P2-4 留档）：
//   - 合成日志生成器确定性（同 seed 同日志 / 异 seed 异日志）与形状（tool 比例 / rewind 数）；
//   - importReplay 解压体积上限：正常包通过 / 超限包友好报错（小上限注入测）；
//   - runSessionBench 小样本端到端（bench 管线自检；大样本跑 scripts/bench-session.mjs）。
// 大样本（10 万事件）不在每测运行——计划风险口径：测试用小样本 + 采样校验。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BENCH_SEARCH_WORD,
  formatBenchTable,
  generateSyntheticEvents,
  runSessionBench,
  writeSyntheticSession,
} from '../src/session/bench.js';
import { computeProjection } from '../src/session/reader.js';
import { SESSION_LOG_FILE, parseEventLine } from '../src/session/types.js';
import { exportSession, importReplay, DEFAULT_MAX_REPLAY_BYTES, ReplayTooLargeError } from '../src/session/export.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-bench-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('合成日志生成器', () => {
  it('确定性：同 seed 两次生成逐字节相同；异 seed 不同', () => {
    const a1 = generateSyntheticEvents({ events: 300, seed: 42 }).map((e) => JSON.stringify(e));
    const a2 = generateSyntheticEvents({ events: 300, seed: 42 }).map((e) => JSON.stringify(e));
    const b = generateSyntheticEvents({ events: 300, seed: 43 }).map((e) => JSON.stringify(e));
    expect(a2).toEqual(a1);
    expect(a1).not.toEqual(b);
    // seq 连续 1..N，全部可被 parseEventLine 接受（合法日志）
    const events = generateSyntheticEvents({ events: 300, seed: 42 });
    events.forEach((e, i) => {
      expect(e.seq).toBe(i + 1);
      expect(parseEventLine(JSON.stringify(e))).not.toBeNull();
    });
  });

  it('形状：tool 事件占比接近 toolRatio、rewind 数与请求一致、主体为 user/assistant 消息', () => {
    const events = generateSyntheticEvents({ events: 1000, seed: 7, toolRatio: 0.2, rewinds: 10 });
    const byType = new Map<string, number>();
    for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
    const toolEvents = (byType.get('tool/call') ?? 0) + (byType.get('tool/result') ?? 0);
    expect(toolEvents / events.length).toBeGreaterThan(0.15);
    expect(toolEvents / events.length).toBeLessThan(0.25);
    expect(byType.get('rewind/marker')).toBe(10);
    expect(byType.get('user/message')).toBeGreaterThan(0);
    expect(byType.get('assistant/message')).toBeGreaterThan(0);
    // rewind 遮蔽窗口合法（rewindToSeq 指向已存在事件），投影可计算且存在影子事件
    const p = computeProjection({
      dir: 'bench',
      header: null,
      events: events.map((event) => ({ event, active: true })),
      warnings: [],
    });
    expect(p.shadowedCount).toBeGreaterThan(0);
    expect(p.rewindCount).toBe(10);
  });

  it('writeSyntheticSession：落盘为会话库布局，loadSession 可读且搜索词必然存在', () => {
    const root = tmpDir();
    const { dir, logBytes } = writeSyntheticSession(root, { events: 200, seed: 1 });
    const loaded = readFileSync(join(dir, SESSION_LOG_FILE), 'utf8');
    expect(logBytes).toBe(Buffer.byteLength(loaded, 'utf8'));
    const text = loaded.toLowerCase();
    expect(text).toContain(BENCH_SEARCH_WORD);
  });
});

describe('importReplay 解压体积上限（P2-5 消化）', () => {
  it('正常包：默认上限内通过（导入缺省参数即默认上限）', () => {
    const root = tmpDir();
    const { dir } = writeSyntheticSession(root, { events: 100, seed: 3 });
    const zip = exportSession(dir, join(root, 'ok.zip'));
    const report = importReplay(zip.outFile);
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]!.badLines).toBe(0);
  });

  it('超限包（小上限注入）：前置拒绝，报错含上限值与建议', () => {
    const root = tmpDir();
    const { dir } = writeSyntheticSession(root, { events: 8000, seed: 3 });
    const zip = exportSession(dir, join(root, 'over.zip'));
    let caught: unknown;
    try {
      importReplay(zip.outFile, { maxDecompressedBytes: 1024 * 1024 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReplayTooLargeError);
    const msg = (caught as Error).message;
    expect(msg).toContain('超限');
    expect(msg).toContain('1.0 MiB'); // 上限值出现
    expect(msg).toContain('maxDecompressedBytes'); // 建议可操作
    // 默认上限常量口径（256 MiB）
    expect(DEFAULT_MAX_REPLAY_BYTES).toBe(256 * 1024 * 1024);
  });
});

describe('runSessionBench 基线管线（小样本自检）', () => {
  it('六项操作全部产出测量记录（大样本跑 scripts/bench-session.mjs，不在每测运行）', () => {
    const r = runSessionBench({ events: 400, seed: 20260907 });
    expect(r.events).toBe(400);
    expect(r.logBytes).toBeGreaterThan(0);
    const ops = r.ops.map((o) => o.op);
    expect(ops).toEqual([
      'loadSession',
      'computeProjection',
      'manager.list（全库）',
      'manager.search（全库）',
      'exportSession',
      'importReplay',
    ]);
    for (const op of r.ops) {
      expect(op.ms).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(op.ms)).toBe(true);
    }
    expect(r.env.node).toMatch(/^v\d+\./);
    // 表格渲染含全部操作名与头部
    const table = formatBenchTable(r);
    expect(table).toContain('loadSession');
    expect(table).toContain('importReplay');
  });
});
