// P11-T4/T5/T6 回归断言（headless）：
//  - T4 用量三件套：消息右对齐时间戳（真实 ts → formatClock）、每轮耗时（TurnResult.durationMs
//    并入 end_turn 行）、token 用量（provider usage 转发 → ctx used/total，无数据如实降级）；
//  - T5 工具行人类化：动词注册表主行、JSON 参数进展开态、未知工具/缺参回退现状；
//  - T6 忙碌态：状态行真实已用时长 + 提示行取消键，空闲帧不含忙碌字段。
//
// 断言原则：版面类断言按**显示列**（CellBuffer.chars 下标）校验，不做 `.length` 当宽度；
// 数据类断言验证「无数据 = 降级/省略」，绝不接受伪造值。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SteerResult, TurnResult } from '@harness2/core';
import type { ChatRuntime } from '../../../src/chat-setup.js';
import { formatTurnDuration, turnSummaryLine } from '../../../src/render.js';
import { CellBuffer } from '../../../src/tui/renderer/cell-buffer.js';
import { formatElapsed, formatTokenCount, statusLineFor } from '../../../src/tui/next/chat-screen.js';
import { FG, formatClock, projectTranscript } from '../../../src/tui/next/projection.js';
import { drawScrollback, Scrollback } from '../../../src/tui/next/scrollback.js';
import { emptyTranscript, transcriptReducer } from '../../../src/tui/transcript.js';
import {
  createApprovalGate,
  createNextChatHarness,
  type ApprovalGate,
  type NextChatHarness,
} from '../../../src/tui/next/next-shell.js';

// —— 最小 harness（与 next-shell.test.ts 同形；本文件自含，便于独立复跑）——
class FakeOut {
  buffer = '';
  columns = 100;
  rows = 30;
  write(s: string): unknown {
    this.buffer += s;
    return s.length;
  }
}

function result(finalText: string, overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    stopReason: 'end_turn',
    steps: 1,
    toolCalls: 0,
    durationMs: 1,
    turnId: 't1',
    textOutcome: 'final',
    finalText,
    ...overrides,
  };
}

function makeRuntime(overrides: Partial<ChatRuntime> = {}): ChatRuntime {
  const runtime: ChatRuntime = {
    provider: { name: 'mock' } as ChatRuntime['provider'],
    approval: undefined,
    tools: {} as ChatRuntime['tools'],
    skillsStore: {} as ChatRuntime['skillsStore'],
    sessionManager: { list: () => [], locate: () => undefined } as unknown as ChatRuntime['sessionManager'],
    root: '/tmp/harness2-p11-test',
    getCurrent: () => null,
    switchSession: () => undefined,
    fork: () => undefined,
    runUserTurn: async (text: string) => result(`收到：${text}`),
    abortTurn: () => undefined,
    closeCurrent: () => undefined,
    clearAlwaysAllowed: () => undefined,
    mode: () => 'default',
    setMode: (m) => m,
    reasoning: () => false,
    setReasoning: (on) => on,
    noteCrash: () => undefined,
    submitSteer: () => ({ state: 'unknown', reason: '测试 stub', draftKept: true, message: 'stub' }),
    currentTurnId: () => undefined,
    observeSteer: () => () => undefined,
    finish: async () => undefined,
    ...overrides,
  };
  return runtime;
}

interface Fixture {
  h: NextChatHarness;
  out: FakeOut;
  runtime: ChatRuntime;
  gate: ApprovalGate;
}

function makeHarness(runtime: ChatRuntime = makeRuntime(), clock12h = false): Fixture {
  const out = new FakeOut();
  const gate = createApprovalGate();
  const h = createNextChatHarness(runtime, {
    out,
    bootLines: [],
    env: {},
    gate,
    clock12h,
    exit: () => undefined,
  });
  return { h, out, runtime, gate };
}

async function settle(h: NextChatHarness, ms = 80): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  h.flushUi();
}

function lineTexts(h: NextChatHarness): string[] {
  return h.logicalLines();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────── T4：时间戳 ───────────────────────────

describe('P11-T4 时间戳（真实 ts → 右对齐副文本）', () => {
  it('formatClock：24h/12h 格式与非法值降级（12/24 制跟随系统，测试显式注入）', () => {
    expect(formatClock('2026-09-15T14:05:00', false)).toBe('14:05');
    expect(formatClock('2026-09-15T09:07:00', false)).toBe('09:07');
    expect(formatClock('2026-09-15T14:05:00', true)).toBe('2:05 PM');
    expect(formatClock('2026-09-15T00:30:00', true)).toBe('12:30 AM');
    expect(formatClock(undefined, false)).toBeUndefined();
    expect(formatClock('not-a-date', false)).toBeUndefined();
  });

  it('user/assistant 首行带 right 时间戳；正文 text 不含时间戳；续行不带', () => {
    let s = emptyTranscript();
    s = transcriptReducer(s, {
      type: 'user/message',
      id: 'u1',
      seq: 1,
      text: '第一行\n第二行',
      ts: '2026-09-15T14:05:00',
    });
    s = transcriptReducer(s, {
      type: 'assistant/message',
      id: 'a1',
      seq: 2,
      text: '答一\n答二',
      ts: '2026-09-15T14:06:00',
    });
    const lines = projectTranscript(s.items, { hour12: false });
    expect(lines[0]?.text).toBe('❯ 第一行');
    expect(lines[0]?.right).toBe('14:05');
    expect(lines[0]?.rightFg).toBe(FG.gray);
    expect(lines[0]?.text).not.toContain('14:05'); // 时间戳不进正文（复制/搜索不受污染）
    expect(lines[1]?.right).toBeUndefined(); // 续行不重复时间戳
    expect(lines[2]?.right).toBe('14:06');
    expect(lines[3]?.right).toBeUndefined();
  });

  it('无 ts / 非法 ts：不产出 right（如实不做，绝不拿当前时间顶替）', () => {
    const s = transcriptReducer(emptyTranscript(), {
      type: 'assistant/message',
      id: 'a1',
      seq: 1,
      text: '无时间戳',
    });
    expect(projectTranscript(s.items).at(0)?.right).toBeUndefined();
    let bad = emptyTranscript();
    bad = transcriptReducer(bad, { type: 'user/message', id: 'u1', seq: 1, text: 'x', ts: 'bad-ts' });
    expect(projectTranscript(bad.items, { hour12: false }).at(0)?.right).toBeUndefined();
  });

  it('版面级：时间戳结束列 = contentCols-1（右对齐），正文不动', () => {
    const sb = new Scrollback([{ text: '❯ hi', right: '14:05', rightFg: FG.gray }], 40);
    const buf = new CellBuffer(41, 3); // cols 41 = 内容区 40 + 滚动条 1 列
    drawScrollback(buf, sb, { top: 0, height: 3, width: 41, scrollbar: true });
    // contentCols=40，时间戳宽 5 → 起始列 35，末列 39
    expect(buf.chars[0 * 41 + 35]).toBe('1');
    expect(buf.chars[0 * 41 + 39]).toBe('5');
    expect(buf.rowText(0).slice(35, 40)).toBe('14:05');
    expect(buf.rowText(0).slice(0, 4)).toBe('❯ hi'); // 正文左对齐不受影响
  });

  it('版面级：正文过长无空位时丢弃时间戳（不与正文重叠）', () => {
    const sb = new Scrollback([{ text: 'x'.repeat(38), right: '14:05' }], 40);
    const buf = new CellBuffer(41, 3);
    drawScrollback(buf, sb, { top: 0, height: 3, width: 41, scrollbar: true });
    expect(buf.rowText(0)).not.toContain('14:05'); // 放不下就不画（诚实降级）
    expect(buf.rowText(0).slice(0, 38)).toBe('x'.repeat(38));
  });

  it('live 回合：user 行带真实时钟（HH:MM，clock12h=false），状态行并入真实耗时', async () => {
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({ type: 'text-delta', text: '答', turnId: 't1' });
          return result('答', { durationMs: 12340 });
        },
      }),
    );
    h.submit('hi');
    await settle(h);
    const first = h.state.scrollback.lineAt(0);
    expect(first?.text).toContain(' hi');
    expect(first?.right).toMatch(/^\d{2}:\d{2}$/); // 真实落地时钟，非伪造常量
    expect(first?.text).not.toContain(first?.right ?? '');
    expect(lineTexts(h).join('\n')).toContain('[end_turn · 12.3s · steps 1');
    h.dispose();
  });
});

// ─────────────────────────── T4：耗时 + token ───────────────────────────

describe('P11-T4 每轮耗时与 token 用量', () => {
  it('turnSummaryLine：并入 TurnResult.durationMs（真实计时）', () => {
    expect(turnSummaryLine({ stopReason: 'end_turn', steps: 3, toolCalls: 2, durationMs: 12340 } as TurnResult)).toBe(
      '[end_turn · 12.3s · steps 3 · toolCalls 2]',
    );
    expect(formatTurnDuration(95000)).toBe('1m35s');
    expect(formatTurnDuration(0)).toBe('0.0s');
    expect(formatTurnDuration(Number.NaN)).toBe(''); // 非法值不产出（不补 0 秒假数据）
  });

  it('statusLineFor：有真实 usage → ctx 15.3k/128k；无则退回比例/—（不伪造）', () => {
    expect(formatTokenCount(15700)).toBe('15.3k');
    expect(formatTokenCount(131072)).toBe('128k');
    expect(statusLineFor({ cwd: '/w', home: '/home/me', model: 'm', tokenUsage: { used: 15700, total: 131072 } })).toBe(
      '/w · m · ctx 15.3k/128k',
    );
    expect(statusLineFor({ cwd: '/w', home: '/home/me', model: 'm' })).toBe('/w · m · ctx —');
    expect(statusLineFor({ cwd: '/w', home: '/home/me', model: 'm', usage: 0.5 })).toBe('/w · m · ctx 50%');
  });

  it('chat-setup 口径的 usage 转发：状态行显示 used/total', async () => {
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({ type: 'usage', usage: { inputTokens: 15000, outputTokens: 700 }, turnId: 't1' });
          return result('答');
        },
      }),
    );
    h.submit('hi');
    await settle(h);
    expect(h.state.statusline).toContain('ctx 15.3k/128k');
    h.dispose();
  });

  it('无 usage 事件：状态行保持 ctx —（mock 默认无 usage，不编数字）', async () => {
    const { h } = makeHarness(makeRuntime());
    h.submit('hi');
    await settle(h);
    expect(h.state.statusline).toContain('ctx —');
    expect(h.state.statusline).not.toMatch(/ctx \d/);
    h.dispose();
  });
});

// ─────────────────────────── T5：工具行人类化 ───────────────────────────

describe('P11-T5 工具行动词注册表', () => {
  function toolLines(tool: string, args: string, collapsed?: boolean): string[] {
    let s = emptyTranscript();
    s = transcriptReducer(s, { type: 'tool/call', seq: 1, callId: 'c1', tool, args });
    return projectTranscript(s.items, ...(collapsed === true ? [{ collapsed: new Set([0]) }] : [])).map((l) => l.text);
  }

  it('内置工具逐条：主行人类动词短语且不含 JSON 片段', () => {
    const cases: Array<[string, string, string]> = [
      ['write', JSON.stringify({ file_path: 'harness2-demo.txt', content: 'x' }), '⏺ 写入 harness2-demo.txt'],
      ['read', JSON.stringify({ file_path: 'a.ts' }), '⏺ 读取 a.ts'],
      ['edit', JSON.stringify({ file_path: 'a.ts', old_text: 'a', new_text: 'b' }), '⏺ 编辑 a.ts'],
      ['bash', JSON.stringify({ command: 'ls -la' }), '⏺ 运行命令 ls -la'],
      ['glob', JSON.stringify({ pattern: '**/*.ts' }), '⏺ 查找文件 **/*.ts'],
      ['grep', JSON.stringify({ pattern: 'TODO' }), '⏺ 搜索 TODO'],
      ['browser_navigate', JSON.stringify({ url: 'https://example.com' }), '⏺ 打开网页 https://example.com'],
      ['browser_click', JSON.stringify({ ref: 's1e3' }), '⏺ 点击页面元素 s1e3'],
      ['browser_type', JSON.stringify({ ref: 's1e3', text: 'hello' }), '⏺ 页面输入 hello'],
      ['browser_snapshot', '{}', '⏺ 读取页面快照'],
      ['browser_screenshot', '{}', '⏺ 页面截图'],
      ['browser_close', '{}', '⏺ 关闭浏览器'],
      ['memory', JSON.stringify({ operation: 'add', target: 'memory' }), '⏺ 记忆操作 add（memory）'],
      ['skill', JSON.stringify({ name: 'deploy' }), '⏺ 调用技能 deploy'],
      ['skill_author', JSON.stringify({ name: 'my-skill', description: 'd', body: 'b' }), '⏺ 编写技能 my-skill'],
      ['subagent_fanout', '{}', '⏺ 派发并行子任务'],
    ];
    for (const [tool, args, expected] of cases) {
      const lines = toolLines(tool, args);
      expect(lines[0], `${tool} 主行`).toBe(expected);
      expect(lines[0], `${tool} 主行不得含 JSON`).not.toContain('{"');
    }
  });

  it('未知工具回退现状：`工具名(摘要)`（不硬编码失败、不编造能力）', () => {
    const lines = toolLines('mystery_tool', JSON.stringify({ foo: 'bar' }));
    expect(lines[0]?.startsWith('⏺ mystery_tool(')).toBe(true);
    expect(lines[0]).toContain('bar');
  });

  it('已知工具但必需参数缺失/args 非 JSON：回退现状（不显示 `写入 undefined`）', () => {
    expect(toolLines('write', '{}')[0]).toBe('⏺ write({})');
    expect(toolLines('read', 'not-json', true)[0]).toBe('⏺ read(not-json)');
    // 有 summary 兜底时显示摘要（reducer 已用 summarizeArgs 兜底）
    let s = emptyTranscript();
    s = transcriptReducer(s, { type: 'tool/call', seq: 1, callId: 'c1', tool: 'read', summary: 'a.ts' });
    expect(projectTranscript(s.items).at(0)?.text).toBe('⏺ read(a.ts)');
  });

  it('折叠态不暴露工具名/JSON；展开态可见工具名 + 原始参数 JSON', () => {
    const args = JSON.stringify({ file_path: 'a.ts', old_text: 'foo', new_text: 'bar' });
    const folded = toolLines('edit', args);
    expect(folded[0]).toBe('⏺ 编辑 a.ts');
    expect(folded.some((l) => l.includes('edit('))).toBe(false);
    const expanded = toolLines('edit', args, true);
    expect(expanded.some((l) => l.includes('edit(') && l.includes('"file_path":"a.ts"'))).toBe(true);
  });

  it('原始视图（r / rawMarkdown）：保留工具名 + args 原文（轨迹不回退）', () => {
    let s = emptyTranscript();
    s = transcriptReducer(s, {
      type: 'tool/call',
      seq: 1,
      callId: 'c1',
      tool: 'write',
      args: JSON.stringify({ file_path: 'a.txt', content: 'one\ntwo' }),
    });
    const lines = projectTranscript(s.items, { rawMarkdown: true });
    expect(lines[0]?.text).toBe(`⏺ write(${JSON.stringify({ file_path: 'a.txt', content: 'one\ntwo' })})`);
  });

  it('失败态可读性不回归：`  └ ✗ 原因首行` 仍可见', () => {
    let s = emptyTranscript();
    s = transcriptReducer(s, { type: 'tool/call', seq: 1, callId: 'c1', tool: 'bash', args: '{"command":"nope"}' });
    s = transcriptReducer(s, { type: 'tool/result', callId: 'c1', tool: 'bash', ok: false, error: '命令不存在\n详情' });
    const lines = projectTranscript(s.items);
    expect(lines[0]?.text).toBe('⏺ 运行命令 nope');
    expect(lines[1]?.text).toBe('  └ ✗ 命令不存在');
    expect(lines[1]?.fg).toBe(FG.red);
  });
});

// ─────────────────────────── T6：忙碌态反馈 ───────────────────────────

describe('P11-T6 忙碌态反馈', () => {
  it('statusLineFor：busy 带真实已用时长与 ↓token；缺失则省略（不猜）', () => {
    expect(
      statusLineFor({ cwd: '/w', home: '/home/me', model: 'm', busy: true, busyElapsedMs: 12300, busyDownTokens: 3277 }),
    ).toBe('/w · m · ctx — · ⏺ 运行中… 已用 12s ↓3.2k');
    expect(statusLineFor({ cwd: '/w', home: '/home/me', model: 'm', busy: true })).toBe('/w · m · ctx — · ⏺ 运行中…');
    expect(formatElapsed(95000)).toBe('1m35s');
  });

  it('忙碌帧含真实耗时与取消提示；空闲帧不含忙碌字段', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async () => {
          await blocker;
          return result('done');
        },
      }),
    );
    h.submit('hi');
    await vi.advanceTimersByTimeAsync(1200);
    expect(h.state.statusline).toContain('运行中');
    expect(h.state.statusline).toMatch(/已用 \d+s/); // 真实计时（turnStartedAt）
    expect(h.state.shortcuts).toContain('Ctrl+C 取消');
    expect(h.state.shortcuts).toContain('Ctrl+Enter 立即发送');
    release();
    await settle(h);
    expect(h.state.statusline).not.toContain('已用');
    expect(h.state.statusline).not.toContain('运行中');
    expect(h.state.shortcuts).toEqual(['/ 命令', 'Tab 焦点', 'Ctrl+C 退出']);
    h.dispose();
  });
});