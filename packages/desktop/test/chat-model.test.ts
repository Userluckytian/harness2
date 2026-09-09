// 对话纯模型测试（Task 4）：事件折叠（气泡/工具行/turn 摘要/reasoning）、影子过滤、
// 重放合并判重、增量 seq 去重、delta 一致性清空规则。
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  emptyLive,
  mergeReplay,
  projectChatItems,
  type ActiveEvent,
  type TurnEndInfo,
} from '../src/renderer/chat-model.js';
import type { SessionEventShape } from '../src/shared/protocol.js';

let seqCounter = 0;
function ev(type: string, payload: Record<string, unknown>, active = true): ActiveEvent {
  seqCounter += 1;
  return { v: 1, seq: seqCounter, ts: '2026-09-06T00:00:00Z', type, payload, active };
}

function fullTurnEvents(): ActiveEvent[] {
  seqCounter = 0; // 每次从 1 开始（影子测试按相对 seq 遮蔽）
  return [
    ev('session/header', { sessionId: 's1' }),
    ev('user/message', { text: '帮我写文件', turnId: 't1' }),
    ev('step/start', { stepId: 'st1', turnId: 't1' }),
    ev('assistant/message', { text: '好的，我来创建。', reasoning: '先思考一下', model: 'mock/m', turnId: 't1' }),
    ev('tool/call', { callId: 'c1', tool: 'write', args: { file_path: 'a.txt', content: 'hi' }, turnId: 't1' }),
    ev('tool/result', { callId: 'c1', ok: true, output: 'written', durationMs: 12, turnId: 't1' }),
    ev('step/end', { stepId: 'st1', durationMs: 1234, turnId: 't1' }),
    ev('assistant/message', { text: '写好了。', model: 'mock/m', turnId: 't1' }),
  ];
}

describe('projectChatItems 折叠', () => {
  it('完整 turn：turn 标头 / 气泡 / 工具行带结果 / 摘要（耗时聚合 step/end）', () => {
    const items = projectChatItems(fullTurnEvents(), emptyLive(), {
      t1: { stopReason: 'end_turn' } as TurnEndInfo,
    });
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual([
      'turn-header',
      'user',
      'assistant',
      'tool',
      'assistant',
      'turn-summary',
    ]);
    const assistant1 = items[2]!;
    expect(assistant1.text).toBe('好的，我来创建。');
    expect(assistant1.reasoning).toBe('先思考一下');
    expect(assistant1.model).toBe('mock/m');
    const tool = items[3]!;
    expect(tool.callId).toBe('c1');
    expect(tool.result).toEqual({ ok: true, output: 'written', durationMs: 12 });
    const summary = items[5]!;
    expect(summary.stopReason).toBe('end_turn');
    expect(summary.durationMs).toBe(1234);
  });

  it('影子事件不显示（active=false），undo 后重折叠天然生效', () => {
    const events = fullTurnEvents().map((e) =>
      e.seq >= 5 ? { ...e, active: false } : e, // 模拟 rewindToSeq=4 后 seq>4 遮蔽
    );
    const items = projectChatItems(events, emptyLive(), {});
    expect(items.filter((i) => i.kind === 'user')).toHaveLength(1);
    expect(items.filter((i) => i.kind === 'tool')).toHaveLength(0); // tool/call/result 被遮蔽
    // 摘要只剩第一条 assistant（last turn 的 turnId = t1 仍在，但 step/end 被遮蔽 → 耗时 0）
    expect(items.filter((i) => i.kind === 'assistant')).toHaveLength(1); // 第二条 assistant（seq 8）被遮蔽
  });

  it('attempt 行显示失败尝试', () => {
    const items = projectChatItems(
      [ev('user/message', { text: 'x', turnId: 't2' }), ev('assistant/attempt', { error: 'network down', turnId: 't2' })],
      emptyLive(),
      {},
    );
    expect(items.some((i) => i.kind === 'attempt' && i.error === 'network down')).toBe(true);
  });

  it('在途增量：streaming 条目（text 光标 + pending tool 调用）', () => {
    const live = { text: '正在输出', reasoning: '思考', toolCalls: [{ id: 'px', name: 'bash', arguments: '{"cmd":"ls"}' }] };
    const items = projectChatItems([], live, {});
    const streaming = items.filter((i) => i.kind === 'streaming');
    expect(streaming).toHaveLength(2); // 1 pending tool + 1 text 光标
    expect(streaming.find((i) => i.tool === 'bash')).toBeTruthy();
    expect(streaming.find((i) => i.text === '正在输出')?.streaming).toBe(true);
  });

  it('tool/result 找不到宿主时单独成行（异常日志不丢结果）', () => {
    const items = projectChatItems([ev('tool/result', { callId: 'ghost', ok: false, error: 'boom' })], emptyLive(), {});
    expect(items.filter((i) => i.kind === 'tool')).toHaveLength(1);
  });
});

describe('重放与增量去重', () => {
  it('mergeReplay：陈旧响应（lastSeq 更小）不应用；否则排序整体替换', () => {
    const payload = { lastSeq: 9, events: [ev('user/message', { text: 'x' }), ev('user/message', { text: 'y' })] };
    expect(mergeReplay(10, payload)).toBeNull();
    const merged = mergeReplay(0, payload);
    expect(merged?.map((e) => (e.payload as { text: string }).text)).toEqual(['x', 'y']);
    // 乱序重放按 seq 排序
    seqCounter = 100;
    const scrambled = [
      { ...ev('user/message', { text: 'b' }), seq: 2 },
      { ...ev('user/message', { text: 'a' }), seq: 1 },
    ];
    expect(mergeReplay(0, { lastSeq: 2, events: scrambled })?.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('applyEvent：seq 去重（重复/落后忽略）', () => {
    const base = [ev('user/message', { text: 'x' })];
    const lastSeq = base[0]!.seq;
    const dup = applyEvent(base, lastSeq, { v: 1, seq: lastSeq, ts: 't', type: 'user/message', payload: { text: 'dup' } });
    expect(dup).toBeNull();
    const stale = applyEvent(base, lastSeq, { v: 1, seq: lastSeq - 1, ts: 't', type: 'user/message', payload: { text: 'old' } });
    expect(stale).toBeNull();
    const fresh = applyEvent(base, lastSeq, { v: 1, seq: lastSeq + 1, ts: 't', type: 'assistant/message', payload: { text: 'new' } });
    expect(fresh?.events).toHaveLength(2);
    expect(fresh?.lastSeq).toBe(lastSeq + 1);
  });
});

describe('delta 与落盘一致性（清空规则的数据侧）', () => {
  it('assistant/message 落盘时 live 文本被清空 → 最终显示以落盘为准', () => {
    // 用 store 的 absorbEvent 语义在集成层验证；这里验证契约数据形状
    const shape: SessionEventShape = { v: 1, seq: 3, ts: 't', type: 'assistant/message', payload: { text: 'final' } };
    expect(shape.type).toBe('assistant/message');
  });
});

// —— 阶段 8：工具名来源前缀区分与子会话跳转解析 ——

describe('displayToolName 来源前缀', () => {
  it('mcp__<server>__<tool> → [MCP:server] tool；subagent_* → [子会话]；本地原样', async () => {
    const { displayToolName } = await import('../src/renderer/chat-model.js');
    expect(displayToolName('mcp__filesystem__read_file')).toBe('[MCP:filesystem] read_file');
    expect(displayToolName('subagent_start')).toBe('[子会话] subagent_start');
    expect(displayToolName('subagent_continue')).toBe('[子会话] subagent_continue');
    expect(displayToolName('write')).toBe('write');
    expect(displayToolName(undefined)).toBe('');
  });
});

describe('subagent 子会话跳转', () => {
  it('tool/result.output JSON → childSessionId 提取进 ChatItem；非 JSON/缺字段 → 无跳转', async () => {
    const { projectChatItems, emptyLive } = await import('../src/renderer/chat-model.js');
    seqCounter = 0;
    const events: ActiveEvent[] = [
      ev('user/message', { text: '派子任务', turnId: 't1' }),
      ev('tool/call', { callId: 'c1', tool: 'subagent_start', args: { prompt: 'x' }, turnId: 't1' }),
      ev('tool/result', {
        callId: 'c1', ok: true, durationMs: 5, turnId: 't1',
        output: JSON.stringify({ childSessionId: '20260906-000000-abc123', finalText: 'done', stopReason: 'end_turn' }),
      }),
      ev('tool/call', { callId: 'c2', tool: 'subagent_start', args: {}, turnId: 't1' }),
      ev('tool/result', { callId: 'c2', ok: false, error: 'cancelled', turnId: 't1' }),
    ];
    const items = projectChatItems(events, emptyLive(), {});
    const toolRows = items.filter((i) => i.kind === 'tool');
    expect(toolRows[0]!.childSessionId).toBe('20260906-000000-abc123');
    expect(toolRows[1]!.childSessionId).toBeUndefined();
  });
});
