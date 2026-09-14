// H-12 压缩分层测试：常量与既有单层对齐 / turn→session→trajectory 三层产物 /
// 阈值触发与尾部保护 / 确定性 / append-only（只追加不改写）/ 注入式精炼与降级。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMPACTION_MAX_SUMMARY_CHARS,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_TAIL_KEEP,
  COMPACTION_TRIGGER_RATIO,
} from '../src/agent/compaction.js';
import { buildChatMessages } from '../src/agent/loop.js';
import { loadSession } from '../src/session/reader.js';
import { SessionWriter } from '../src/session/writer.js';
import { SESSION_LOG_FILE } from '../src/session/types.js';
import {
  COMPACTION_LAYERS_FILE,
  CompactionLayerStore,
  LAYER_SESSION_SUMMARY_MAX_CHARS,
  LAYER_SESSION_TRIGGER_RATIO,
  LAYER_TAIL_KEEP,
  LAYER_TURN_TRIGGER_RATIO,
  applyLayeredCompaction,
  buildSessionDigest,
  buildTurnSummaries,
  compressTrajectory,
  planLayeredCompaction,
} from '../src/session/layeredCompaction.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-layers-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Built {
  dir: string;
  writer: SessionWriter;
}

/** 造一个多 turn 会话（每轮：user → tool/call → tool/result → assistant） */
function buildMultiTurnSession(turns = 4, opts: { toolOutput?: string; withTurnId?: boolean } = {}): Built {
  const dir = join(tmpDir(), 'session');
  const writer = SessionWriter.create(dir, { sessionId: '20260914-111111-ff0001', cwd: '/proj' }, { fsync: false });
  const withTurnId = opts.withTurnId ?? true;
  for (let i = 1; i <= turns; i++) {
    const turnId = withTurnId ? { turnId: `t${i}` } : {};
    writer.append('user/message', { text: `第 ${i} 轮：请分析模块 ${i} 的实现路径与风险`, ...turnId });
    writer.append('tool/call', { callId: `c${i}`, tool: 'read', args: { file: `/proj/${i}.ts` }, ...turnId });
    writer.append('tool/result', {
      callId: `c${i}`,
      tool: 'read',
      ok: true,
      output: opts.toolOutput ?? `file ${i} content`,
      ...turnId,
    });
    writer.append('assistant/message', { text: `第 ${i} 轮结论：模块 ${i} 已分析完成。`, model: 'mock', ...turnId });
  }
  return { dir, writer };
}

describe('H-12 分层常量与既有单层压缩对齐（单一阈值口径）', () => {
  it('session 层阈值/尾部保护/摘要上限与 agent/compaction 完全一致', () => {
    expect(LAYER_SESSION_TRIGGER_RATIO).toBe(COMPACTION_TRIGGER_RATIO);
    expect(LAYER_TAIL_KEEP).toBe(COMPACTION_TAIL_KEEP);
    expect(LAYER_SESSION_SUMMARY_MAX_CHARS).toBe(COMPACTION_MAX_SUMMARY_CHARS);
  });

  it('turn 层阈值低于 session 层（分层递进，0.5 < 0.75）', () => {
    expect(LAYER_TURN_TRIGGER_RATIO).toBeLessThan(LAYER_SESSION_TRIGGER_RATIO);
  });
});

describe('H-12 第 1 层 turn 摘要（确定性、有界）', () => {
  it('按 turnId 分组，统计工具调用与结果，摘要单行且确定', () => {
    const { dir, writer } = buildMultiTurnSession(3);
    writer.close();
    const session = loadSession(dir);
    const turns = buildTurnSummaries(session);
    expect(turns.map((t) => t.turnId)).toEqual(['t1', 't2', 't3']);
    expect(turns[0]!.toolCalls).toBe(1);
    expect(turns[0]!.toolOk).toBe(1);
    expect(turns[0]!.toolFail).toBe(0);
    expect(turns[0]!.digest).toContain('USER: 第 1 轮');
    expect(turns[0]!.digest).toContain('ASSISTANT: 第 1 轮结论');
    expect(turns[0]!.digest).not.toContain('\n');
    // 确定性：同日志两次折叠完全一致
    expect(buildTurnSummaries(loadSession(dir))).toEqual(turns);
  });

  it('无 turnId 的旧日志按 user 消息边界切 turn（不漏事件）', () => {
    const { dir, writer } = buildMultiTurnSession(2, { withTurnId: false });
    writer.close();
    const turns = buildTurnSummaries(loadSession(dir));
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.turnId)).toEqual(['turn-2', 'turn-6']);
    expect(turns[0]!.toolCalls).toBe(1);
    expect(turns[1]!.toolCalls).toBe(1);
  });

  it('tailSeq 边界：只折叠覆盖区内的 turn', () => {
    const { dir, writer } = buildMultiTurnSession(3);
    writer.close();
    const turns = buildTurnSummaries(loadSession(dir), { tailSeq: 5 });
    expect(turns.map((t) => t.turnId)).toEqual(['t1']);
  });
});

describe('H-12 第 2 层会话摘要（尾部优先、有界）', () => {
  it('上限内拼接全部 turn，并给出覆盖 seq 与 turn 数', () => {
    const { dir, writer } = buildMultiTurnSession(3);
    writer.close();
    const turns = buildTurnSummaries(loadSession(dir));
    const digest = buildSessionDigest(turns);
    expect(digest.turnCount).toBe(3);
    expect(digest.coveredUpToSeq).toBe(turns.at(-1)!.endSeq);
    expect(digest.text).toContain('3 个 turn');
    expect(digest.text.length).toBeLessThanOrEqual(LAYER_SESSION_SUMMARY_MAX_CHARS);
  });

  it('超限时从最旧端截断并登记省略数量（近端优先）', () => {
    const { dir, writer } = buildMultiTurnSession(6);
    writer.close();
    const turns = buildTurnSummaries(loadSession(dir));
    const digest = buildSessionDigest(turns, { maxChars: 200 });
    expect(digest.text.length).toBeLessThanOrEqual(200);
    expect(digest.text).toContain('已省略');
    expect(digest.text).toContain(turns.at(-1)!.digest.slice(0, 10)); // 最新 turn 保留
    expect(digest.text).not.toContain(turns[0]!.digest.slice(0, 10)); // 最旧 turn 被截断
  });

  it('无 turn 时返回空摘要（调用方据此跳过）', () => {
    expect(buildSessionDigest([])).toEqual({ text: '', turnCount: 0, coveredUpToSeq: 0 });
  });
});

describe('H-12 第 3 层轨迹压缩器（独立于上下文压缩）', () => {
  it('工具输出按上限折叠并量化省略字符数', () => {
    const { dir, writer } = buildMultiTurnSession(2, { toolOutput: 'x'.repeat(1000) });
    writer.close();
    const compression = compressTrajectory(loadSession(dir), { toolOutputMaxChars: 50 });
    expect(compression.elidedChars).toBeGreaterThan(0);
    expect(compression.records.some((r) => r.kind === 'tool' && r.text.includes('…'))).toBe(true);
    expect(compression.eventCount).toBeGreaterThan(0);
  });

  it('按上限从尾部保留（最旧端截断）且确定', () => {
    const { dir, writer } = buildMultiTurnSession(6);
    writer.close();
    const session = loadSession(dir);
    const full = compressTrajectory(session);
    const clipped = compressTrajectory(session, { maxChars: 300 });
    expect(clipped.text.length).toBeLessThanOrEqual(300);
    expect(clipped.records.length).toBeLessThan(full.records.length);
    expect(clipped.records.at(-1)!.seq).toBe(full.records.at(-1)!.seq); // 尾部保住
    expect(compressTrajectory(loadSession(dir), { maxChars: 300 })).toEqual(clipped);
  });

  it('rewind 遮蔽的事件不进轨迹（与投影同口径）', () => {
    const { dir, writer } = buildMultiTurnSession(2);
    writer.append('rewind/marker', { rewindToSeq: 2, reason: 'undo' });
    writer.close();
    const compression = compressTrajectory(loadSession(dir));
    const shadowed = compression.records.filter((r) => r.seq > 2 && r.seq < 10);
    expect(shadowed).toHaveLength(0);
  });
});

describe('H-12 阈值触发与分层决策', () => {
  it('未给占用比例且未强制层 → 不压缩（null）', () => {
    const { dir, writer } = buildMultiTurnSession(4);
    writer.close();
    expect(planLayeredCompaction(loadSession(dir), {})).toBeNull();
  });

  it('低于 turn 阈值 → null；≥0.5 走 turn 层；≥0.75 叠加 session 层', () => {
    const { dir, writer } = buildMultiTurnSession(4);
    writer.close();
    const session = loadSession(dir);
    expect(planLayeredCompaction(session, { usageRatio: 0.49 })).toBeNull();
    const turnPlan = planLayeredCompaction(session, { usageRatio: 0.5 });
    expect(turnPlan?.layer).toBe('turn');
    expect(turnPlan!.summary).toContain('USER:');
    const sessionPlan = planLayeredCompaction(session, { usageRatio: 0.76 });
    expect(sessionPlan?.layer).toBe('session');
    expect(sessionPlan!.summary).toContain('个 turn');
  });

  it('尾部保护：覆盖区之后恰好保留 6 条消息（不参与摘要）', () => {
    const { dir, writer } = buildMultiTurnSession(4); // 8 条 user/assistant
    writer.close();
    const session = loadSession(dir);
    const plan = planLayeredCompaction(session, { usageRatio: 0.9 });
    const messages = session.events.filter(
      ({ event }) => event.type === 'user/message' || event.type === 'assistant/message',
    );
    const tail = messages.filter((_m, i) => i >= messages.length - LAYER_TAIL_KEEP);
    expect(tail.every((m) => m.event.seq > plan!.coveredUpToSeq)).toBe(true);
    expect(plan!.coveredUpToSeq).toBe(messages[messages.length - LAYER_TAIL_KEEP - 1]!.event.seq);
  });

  it('消息不足以安全折叠时返回 null（尾部保护优先）', () => {
    const { dir, writer } = buildMultiTurnSession(2); // 4 条消息 ≤ 6
    writer.close();
    expect(planLayeredCompaction(loadSession(dir), { usageRatio: 0.99 })).toBeNull();
  });

  it('强制层（/compact-layers session）跳过阈值判断', () => {
    const { dir, writer } = buildMultiTurnSession(4);
    writer.close();
    const plan = planLayeredCompaction(loadSession(dir), { layer: 'session' });
    expect(plan?.layer).toBe('session');
  });
});

describe('H-12 落地：追加 compaction/applied + turn 明细落辅助文件（append-only 零改写）', () => {
  it('事件形状与单层一致，且日志只在尾部增长（前缀字节不变）', async () => {
    const { dir, writer } = buildMultiTurnSession(4);
    const logPath = join(dir, SESSION_LOG_FILE);
    const before = readFileSync(logPath);
    const result = await applyLayeredCompaction(writer, loadSession(dir), { usageRatio: 0.9 });
    expect(result).not.toBeNull();
    expect(result!.layer).toBe('session');
    writer.close();
    const after = readFileSync(logPath);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.subarray(0, before.length).equals(before)).toBe(true); // 只追加，不改写历史
    // 事件形状与既有单层一致（loop.buildChatMessages 可直接消费）
    const session = loadSession(dir);
    const last = session.events.at(-1)!.event;
    expect(last.type).toBe('compaction/applied');
    if (last.type === 'compaction/applied') {
      expect(last.payload.summary).toBe(result!.summary);
      expect(last.payload.coveredUpToSeq).toBe(result!.coveredUpToSeq);
    }
  });

  it('turn 明细与会话记录落辅助文件；再次压缩只增量追加新 turn', async () => {
    const { dir, writer } = buildMultiTurnSession(4);
    const first = await applyLayeredCompaction(writer, loadSession(dir), { usageRatio: 0.9 });
    expect(first!.turnRecords).toBeGreaterThan(0);
    const store = new CompactionLayerStore(dir);
    const records = store.records();
    expect(records.filter((r) => r.layer === 'turn').length).toBe(first!.turnRecords);
    expect(records.filter((r) => r.layer === 'session')).toHaveLength(1);
    // 追加新内容后再次压缩：只补新 turn 明细（不重复落旧 turn）
    writer.append('user/message', { text: '第五轮：继续分析', turnId: 't5' });
    writer.append('assistant/message', { text: '第五轮结论', turnId: 't5' });
    writer.append('assistant/message', { text: '补充', turnId: 't5' });
    const second = await applyLayeredCompaction(writer, loadSession(dir), { usageRatio: 0.9 });
    expect(second!.turnRecords).toBe(2); // 覆盖区推进后新纳入 t2/t3（t1 已落过，不重复）
    expect(store.records().filter((r) => r.layer === 'turn').length).toBe(first!.turnRecords + 2);
    writer.close();
  });

  it('未达阈值时不写任何产物（事件与辅助文件都不动）', async () => {
    const { dir, writer } = buildMultiTurnSession(4);
    const before = readFileSync(join(dir, SESSION_LOG_FILE));
    const result = await applyLayeredCompaction(writer, loadSession(dir), { usageRatio: 0.2 });
    expect(result).toBeNull();
    writer.close();
    expect(readFileSync(join(dir, SESSION_LOG_FILE)).equals(before)).toBe(true);
    expect(new CompactionLayerStore(dir).records()).toEqual([]);
  });

  it('辅助文件坏行容错（跳过并继续，不影响后续记录读取）', async () => {
    const { dir, writer } = buildMultiTurnSession(4);
    await applyLayeredCompaction(writer, loadSession(dir), { usageRatio: 0.9 });
    writer.close();
    const file = join(dir, COMPACTION_LAYERS_FILE);
    const store = new CompactionLayerStore(dir);
    const count = store.records().length;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, `{broken\n${readFileSync(file, 'utf8')}`, 'utf8');
    expect(store.records()).toHaveLength(count);
  });
});

describe('H-12 与既有单层消费端互操作（/compact 行为对齐的核心半边）', () => {
  it('分层摘要写入后，既有 buildChatMessages 照常把覆盖区替换为摘要消息（零改动消费）', async () => {
    const { dir, writer } = buildMultiTurnSession(6);
    const before = buildChatMessages(loadSession(dir));
    const result = await applyLayeredCompaction(writer, loadSession(dir), { usageRatio: 0.9 });
    writer.close();
    const after = buildChatMessages(loadSession(dir));
    const summaryMsg = after.find((m) => m.content.includes(COMPACTION_SUMMARY_PREFIX));
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.content).toContain(result!.summary);
    // 尾部保护生效：替换后消息数少于压缩前，且尾部 6 条原文仍在
    expect(after.length).toBeLessThan(before.length);
    for (const text of before.slice(-LAYER_TAIL_KEEP).map((m) => m.content)) {
      expect(after.some((m) => m.content === text)).toBe(true);
    }
  });
});

describe('H-12 注入式精炼（core 内无模型调用硬编）', () => {
  it('注入成功 → 摘要替换为精炼文本并标记 refined', async () => {
    const { dir, writer } = buildMultiTurnSession(4);
    const result = await applyLayeredCompaction(writer, loadSession(dir), {
      usageRatio: 0.9,
      refine: async ({ summary }) => `精炼摘要（${summary.length} 字）`,
    });
    expect(result).toMatchObject({ refined: true });
    expect(result!.summary).toContain('精炼摘要');
    writer.close();
  });

  it('注入抛错/返回空 → 确定性摘要兜底并登记原因（不阻塞压缩）', async () => {
    const { dir, writer } = buildMultiTurnSession(4);
    const failed = await applyLayeredCompaction(writer, loadSession(dir), {
      usageRatio: 0.9,
      refine: async () => {
        throw new Error('small provider 不可用');
      },
    });
    expect(failed).toMatchObject({ refined: false });
    expect(failed!.refineFallbackReason).toContain('small provider 不可用');
    expect(failed!.summary).toContain('个 turn');
    const empty = await applyLayeredCompaction(writer, loadSession(dir), {
      usageRatio: 0.9,
      refine: async () => '   ',
    });
    expect(empty!.refineFallbackReason).toContain('空摘要');
    writer.close();
  });

  it('精炼结果超长时按 session 摘要上限截断', async () => {
    const { dir, writer } = buildMultiTurnSession(4);
    const result = await applyLayeredCompaction(writer, loadSession(dir), {
      usageRatio: 0.9,
      refine: async () => 'y'.repeat(LAYER_SESSION_SUMMARY_MAX_CHARS + 500),
    });
    expect(result!.summary.length).toBe(LAYER_SESSION_SUMMARY_MAX_CHARS + 1); // 含省略号
    writer.close();
  });
});
