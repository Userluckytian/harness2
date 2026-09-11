// T3 transcript 纯 reducer 测试：稳定 id / tool call↔result 合并 / final|partial|empty 映射 /
// 影子事件排除 / 顺序。无 ink/react，无 I/O（projectSession 读临时会话目录）。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  emptyTranscript,
  projectSession,
  transcriptReducer,
  type TranscriptItem,
  type TranscriptState,
} from '../../src/tui/transcript.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // 清理失败不影响测试结论
    }
  }
});

function ev(seq: number, type: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { v: 1, seq, ts: new Date(seq * 1000).toISOString(), type, payload };
}

/** 写一个临时会话目录（session.v1.jsonl），返回目录路径 */
function writeSession(events: Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'h2-t3-sess-'));
  tmpDirs.push(dir);
  writeFileSync(join(dir, 'session.v1.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  return dir;
}

function ids(state: TranscriptState): string[] {
  return state.items.map((i) => i.id);
}

describe('transcriptReducer：稳定 id 与顺序', () => {
  it('projectSession 同一会话两次投影 id 完全一致（幂等）', () => {
    const dir = writeSession([
      ev(1, 'session/header', { sessionId: 's1' }),
      ev(2, 'user/message', { text: '你好' }),
      ev(3, 'tool/call', { callId: 'c1', tool: 'read', args: { file_path: 'a.txt' } }),
      ev(4, 'tool/result', { callId: 'c1', tool: 'read', ok: true, output: '内容' }),
      ev(5, 'assistant/message', { text: '完成' }),
    ]);
    const a = projectSession(dir);
    const b = projectSession(dir);
    expect(ids(a)).toEqual(['user:2', 'tool:c1', 'assistant:5']);
    expect(ids(b)).toEqual(ids(a));
    expect(b.items).toEqual(a.items);
  });

  it('item 顺序与 seq 顺序一致（tool 结果原地更新位置不变）', () => {
    let s = emptyTranscript();
    s = transcriptReducer(s, { type: 'user/message', seq: 2, text: 'q' });
    s = transcriptReducer(s, { type: 'tool/call', seq: 3, callId: 'c1', tool: 'read', args: '{}', summary: 'a.txt' });
    s = transcriptReducer(s, { type: 'assistant/message', seq: 4, text: 'a' });
    s = transcriptReducer(s, { type: 'tool/result', callId: 'c1', ok: true, output: 'out' });
    expect(s.items.map((i) => i.kind)).toEqual(['user', 'tool', 'assistant']);
    expect(ids(s)).toEqual(['user:2', 'tool:c1', 'assistant:4']);
  });

  it('system/status：显式 id 幂等 upsert，不重复追加', () => {
    let s = emptyTranscript();
    s = transcriptReducer(s, { type: 'system', id: 'boot:0', text: '第一行' });
    s = transcriptReducer(s, { type: 'system', id: 'boot:0', text: '第一行（更新）' });
    s = transcriptReducer(s, { type: 'status', id: 'st:1', text: '[end_turn · steps 1]' });
    expect(s.items).toHaveLength(2);
    expect((s.items[0] as Extract<TranscriptItem, { kind: 'system' }>).text).toBe('第一行（更新）');
  });
});

describe('transcriptReducer：tool call↔result 合并', () => {
  it('同 callId 结果原地更新为 ok/failed 并写入 output/error', () => {
    let s = emptyTranscript();
    s = transcriptReducer(s, {
      type: 'tool/call',
      seq: 3,
      callId: 'c1',
      tool: 'edit',
      args: '{"a":1}',
      summary: 'a.ts',
    });
    expect(s.items).toHaveLength(1);
    const pending = s.items[0] as Extract<TranscriptItem, { kind: 'tool' }>;
    expect(pending.status).toBe('pending');
    const beforeIndex = s.byId.get('tool:c1');

    s = transcriptReducer(s, { type: 'tool/result', seq: 4, callId: 'c1', ok: true, output: '已写入' });
    expect(s.items).toHaveLength(1);
    const ok = s.items[0] as Extract<TranscriptItem, { kind: 'tool' }>;
    expect(ok.status).toBe('ok');
    expect(ok.output).toBe('已写入');
    expect(s.byId.get('tool:c1')).toBe(beforeIndex);

    s = transcriptReducer(s, { type: 'tool/result', seq: 5, callId: 'c1', ok: false, error: '权限拒绝' });
    const failed = s.items[0] as Extract<TranscriptItem, { kind: 'tool' }>;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('权限拒绝');
  });

  it('仅有 tool/result（无对应 call）也能生成卡片，不丢信息', () => {
    let s = emptyTranscript();
    s = transcriptReducer(s, {
      type: 'tool/result',
      seq: 4,
      callId: 'ghost',
      tool: 'bash',
      ok: false,
      error: 'not found',
    });
    expect(s.items).toHaveLength(1);
    const t = s.items[0] as Extract<TranscriptItem, { kind: 'tool' }>;
    expect(t.id).toBe('tool:ghost');
    expect(t.status).toBe('failed');
    expect(t.tool).toBe('bash');
  });
});

describe('transcriptReducer：final/partial/empty 冻结语义映射', () => {
  it('assistant/message → assistant(outcome:final)，携带 reasoning', () => {
    const s = transcriptReducer(emptyTranscript(), {
      type: 'assistant/message',
      seq: 5,
      text: '完整正文',
      reasoning: '思考过程',
    });
    const item = s.items[0] as Extract<TranscriptItem, { kind: 'assistant' }>;
    expect(item.kind).toBe('assistant');
    expect(item.outcome).toBe('final');
    expect(item.text).toBe('完整正文');
    expect(item.reasoning).toBe('思考过程');
  });

  it('assistant/attempt 有 text → partial（error 必填）', () => {
    const s = transcriptReducer(emptyTranscript(), {
      type: 'assistant/attempt',
      seq: 6,
      text: '半截文本',
      error: 'network error',
    });
    const item = s.items[0] as Extract<TranscriptItem, { kind: 'partial' }>;
    expect(item.kind).toBe('partial');
    expect(item.text).toBe('半截文本');
    expect(item.error).toBe('network error');
  });

  it('assistant/attempt 无 text（空串/缺省）→ empty', () => {
    const a = transcriptReducer(emptyTranscript(), {
      type: 'assistant/attempt',
      seq: 6,
      text: '',
      error: '首个 token 前失败',
    });
    expect(a.items[0]?.kind).toBe('empty');
    const b = transcriptReducer(emptyTranscript(), { type: 'assistant/attempt', seq: 7, error: 'no body' });
    expect(b.items[0]?.kind).toBe('empty');
  });

  it('turn-final/turn-partial/turn-empty 终态事件映射到对应 kind', () => {
    let s = emptyTranscript();
    s = transcriptReducer(s, { type: 'turn-final', turnId: 't1', text: '最终' });
    s = transcriptReducer(s, {
      type: 'turn-partial',
      turnId: 't2',
      text: '半截',
      error: 'cancelled',
      stopReason: 'cancelled',
    });
    s = transcriptReducer(s, { type: 'turn-empty', turnId: 't3', error: 'network error', stopReason: 'error' });
    expect(s.items.map((i) => i.kind)).toEqual(['assistant', 'partial', 'empty']);
  });

  it('turn-partial 文本为空时降级为 empty（禁止空 partial 气泡）', () => {
    const s = transcriptReducer(emptyTranscript(), {
      type: 'turn-partial',
      turnId: 't2',
      text: '  ',
      error: 'e',
      stopReason: 'error',
    });
    expect(s.items[0]?.kind).toBe('empty');
  });
});

describe('projectSession：影子事件排除', () => {
  it('rewind 遮蔽的事件不进入投影，标记之后的新事件保留', () => {
    const dir = writeSession([
      ev(1, 'session/header', { sessionId: 's1' }),
      ev(2, 'user/message', { text: '旧问题' }),
      ev(3, 'assistant/message', { text: '旧回答' }),
      ev(4, 'rewind/marker', { rewindToSeq: 2, reason: 'undo' }),
      ev(5, 'user/message', { text: '新问题' }),
    ]);
    const s = projectSession(dir);
    expect(ids(s)).toEqual(['user:2', 'user:5']);
    expect(s.items.some((i) => i.kind === 'assistant')).toBe(false);
  });

  it('非消息类结构事件（step/memory/compaction/header）不产生 item', () => {
    const dir = writeSession([
      ev(1, 'session/header', { sessionId: 's1' }),
      ev(2, 'memory/snapshot', { content: '记忆体' }),
      ev(3, 'user/message', { text: 'q' }),
      ev(4, 'step/start', { stepId: 'st1' }),
      ev(5, 'step/end', { stepId: 'st1' }),
      ev(6, 'compaction/applied', { summary: '摘要', coveredUpToSeq: 3 }),
      ev(7, 'assistant/message', { text: 'a' }),
    ]);
    expect(ids(projectSession(dir))).toEqual(['user:3', 'assistant:7']);
  });
});

describe('projectSession：会话重投影可整体替换', () => {
  it('B 会话投影不含 A 会话任何 item（重投影是替换而非追加）', () => {
    const a = writeSession([ev(1, 'session/header', { sessionId: 'a' }), ev(2, 'user/message', { text: 'A' })]);
    const b = writeSession([ev(1, 'session/header', { sessionId: 'b' }), ev(2, 'user/message', { text: 'B' })]);
    const sa = projectSession(a);
    const sb = projectSession(b);
    expect(ids(sa)).toEqual(['user:2']);
    expect(ids(sb)).toEqual(['user:2']);
    expect((sb.items[0] as Extract<TranscriptItem, { kind: 'user' }>).text).toBe('B');
    expect(sb.items.some((i) => (i.kind === 'user' ? i.text === 'A' : false))).toBe(false);
  });
});
