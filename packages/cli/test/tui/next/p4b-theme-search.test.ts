// P4-2 主题系统 + /theme + /search + busy 状态行 spinner 单测（headless）。
// 覆盖：
// - 主题注册表（dark/light；getTheme 大小写不敏感、未知名 undefined）
// - dark = 现状默认色逐值对齐（FG/SELECTION_FG/DEFAULT_CURSOR_FG/DEFAULT_ACTIVE_FG）→ 切换回 dark 视觉零变化
// - light = 深字浅底变体（自定合理值，全部有值槽位与 dark 不同）
// - projection / drawScrollback / chat-screen（composer 光标、active 候选）的 theme 注入与缺省 dark 零变化
// - /theme 三分支（无参列出 / 切换重投影生效 / 未知名报错）
// - /search 命中定位 / 大小写不敏感 / 中文子串 / 循环 / clear / 未命中 / 用法提示 / 高亮保留
// - busy 状态行 spinner（busy 且无运行中子代理时 ⏺ → 帧动画 150ms；子代理运行中行级接管；空闲停表）
// 红绿流程：先于 theme.ts / next-shell 接线落盘（红），实现后转绿（日志存 Temp/p4b-evidence）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnResult } from '@harness2/core';
import type { ChatRuntime } from '../../../src/chat-setup.js';
import { DEFAULT_ACTIVE_FG, DEFAULT_CURSOR_FG } from '../../../src/tui/next/composer.js';
import {
  DARK_THEME,
  DEFAULT_THEME_NAME,
  LIGHT_THEME,
  THEMES,
  getTheme,
  themeNames,
} from '../../../src/tui/next/theme.js';
import { FG, projectTranscript } from '../../../src/tui/next/projection.js';
import { SELECTION_FG, Scrollback, drawScrollback } from '../../../src/tui/next/scrollback.js';
import { layoutChat, renderChat, statusLineFor } from '../../../src/tui/next/chat-screen.js';
import type { ChatScreenState } from '../../../src/tui/next/chat-screen.js';
import {
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  createApprovalGate,
  createNextChatHarness,
  type ApprovalGate,
  type NextChatHarness,
} from '../../../src/tui/next/next-shell.js';
import { CellBuffer } from '../../../src/tui/renderer/cell-buffer.js';
import { Screen } from '../../../src/tui/renderer/screen.js';
import {
  emptyTranscript,
  transcriptReducer,
  type TranscriptEvent,
  type TranscriptItem,
} from '../../../src/tui/transcript.js';

// —— 纯数据/纯函数测试辅助 ——

function build(...events: TranscriptEvent[]): TranscriptItem[] {
  let s = emptyTranscript();
  for (const e of events) s = transcriptReducer(s, e);
  return s.items;
}

class MemOut {
  private chunks: string[] = [];
  columns: number;
  rows: number;
  constructor(cols = 100, rows = 30) {
    this.columns = cols;
    this.rows = rows;
  }
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  clear(): void {
    this.chunks = [];
  }
}

let turnSeq = 0;

function result(finalText: string, overrides: Partial<TurnResult> = {}): TurnResult {
  turnSeq += 1;
  return {
    stopReason: 'end_turn',
    steps: 1,
    toolCalls: 0,
    durationMs: 1,
    turnId: `t${turnSeq}`, // 唯一 turnId：reducer 按 id put，撞 id 会原地合并转录行
    textOutcome: 'final',
    finalText,
    ...overrides,
  };
}

/** 内存 mock runtime（finalText 固定，避免污染搜索词） */
function makeRuntime(overrides: Partial<ChatRuntime> = {}, finalText = '好的'): ChatRuntime {
  const runtime: ChatRuntime = {
    provider: { name: 'mock' } as ChatRuntime['provider'],
    approval: undefined,
    tools: {} as ChatRuntime['tools'],
    skillsStore: {} as ChatRuntime['skillsStore'],
    sessionManager: {
      list: () => [],
      search: () => [],
      locate: () => undefined,
    } as unknown as ChatRuntime['sessionManager'],
    root: '/tmp/harness2-p4b-test',
    getCurrent: () => null,
    switchSession: () => undefined,
    fork: () => undefined,
    runUserTurn: async () => result(finalText),
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
  out: MemOut;
  gate: ApprovalGate;
  runtime: ChatRuntime;
}

function makeHarness(runtime: ChatRuntime = makeRuntime(), opts: { cwd?: string; home?: string } = {}): Fixture {
  const out = new MemOut();
  const gate = createApprovalGate();
  const h = createNextChatHarness(runtime, {
    out,
    bootLines: [],
    env: {},
    gate,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    exit: () => undefined,
  });
  return { h, out, gate, runtime };
}

function linesOf(h: NextChatHarness): string[] {
  return h.logicalLines();
}

/** 逻辑行 fg 断言缝（P4-2 harness 新增 logicalLineFg） */
function fgOf(h: NextChatHarness, index: number): number | undefined {
  return h.logicalLineFg(index);
}

async function settle(h: NextChatHarness, ms = 80): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  h.flushUi();
}

/** 提交一条斜杠命令并等待落定 */
async function run(h: NextChatHarness, text: string): Promise<void> {
  h.submit(text);
  await settle(h);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// —— 主题注册表 ——
describe('P4-2 theme 注册表', () => {
  it('内置 dark/light 两套；getTheme 大小写不敏感；未知名/空名返回 undefined', () => {
    expect(Object.keys(THEMES).sort()).toEqual(['dark', 'light']);
    expect(getTheme('dark')).toBe(DARK_THEME);
    expect(getTheme('LIGHT')).toBe(LIGHT_THEME);
    expect(getTheme('neon')).toBeUndefined();
    expect(getTheme('')).toBeUndefined();
  });

  it('dark 色板逐值对齐现状常量（切换回 dark 视觉零变化的契约）', () => {
    const d = DARK_THEME;
    expect(d.name).toBe('dark');
    expect(d.dark).toBe(true);
    expect(d.fg.user).toBeUndefined(); // 用户消息 = 终端默认色（现状）
    expect(d.fg.assistant).toBeUndefined();
    expect(d.fg.toolPending).toBe(FG.yellow);
    expect(d.fg.toolOk).toBe(FG.green);
    expect(d.fg.toolFailed).toBe(FG.red);
    expect(d.fg.toolResultOk).toBe(FG.green);
    expect(d.fg.toolResultFailed).toBe(FG.red);
    expect(d.fg.toolResultDetail).toBe(FG.gray);
    expect(d.fg.reasoning).toBe(FG.gray);
    expect(d.fg.subagentDetail).toBe(FG.gray);
    expect(d.fg.system).toBe(FG.gray);
    expect(d.fg.systemWarn).toBe(FG.yellow);
    expect(d.fg.systemError).toBe(FG.red);
    expect(d.fg.diffAdd).toBe(FG.green);
    expect(d.fg.diffDel).toBe(FG.red);
    expect(d.fg.diffHunk).toBe(FG.gray);
    expect(d.fg.selection).toBe(SELECTION_FG);
    expect(d.fg.cursor).toBe(DEFAULT_CURSOR_FG);
    expect(d.fg.active).toBe(DEFAULT_ACTIVE_FG);
    // 字面锚（审查 P2-1）：FG/SELECTION_FG 已由 DARK_THEME 派生，别名断言抗不住
    // 「整套色板协同替换」的漂移——钉 3 个代表字面量锁定零变化契约
    expect(d.fg.toolOk).toBe(0x3fb950);
    expect(d.fg.toolFailed).toBe(0xf85149);
    expect(d.fg.selection).toBe(0x22d3ee);
    expect(d.fg.searchHit).toBeDefined(); // 新增槽（新能力，无现状对齐对象）
  });

  it('light 色板：全部有值槽位与 dark 不同（深字浅底适配），user/assistant 保持默认色', () => {
    const d = DARK_THEME.fg;
    const l = LIGHT_THEME.fg;
    expect(LIGHT_THEME.name).toBe('light');
    expect(LIGHT_THEME.dark).toBe(false);
    expect(l.user).toBeUndefined();
    expect(l.assistant).toBeUndefined();
    const slots = [
      'toolPending',
      'toolOk',
      'toolFailed',
      'toolResultOk',
      'toolResultFailed',
      'toolResultDetail',
      'reasoning',
      'subagentDetail',
      'system',
      'systemWarn',
      'systemError',
      'diffAdd',
      'diffDel',
      'diffHunk',
      'selection',
      'cursor',
      'active',
      'searchHit',
    ] as const;
    for (const k of slots) {
      expect(l[k], `light.${k}`).not.toBe(d[k]);
      expect(l[k], `light.${k} 应有定义`).toBeDefined();
    }
  });

  it('DEFAULT_THEME_NAME = dark；themeNames 列出全部', () => {
    expect(DEFAULT_THEME_NAME).toBe('dark');
    expect(themeNames()).toEqual(['dark', 'light']);
  });
});

// —— projection theme 接线 ——
describe('P4-2 projectTranscript theme 注入', () => {
  it('缺省 = dark（零变化）：reasoning/tool 三态/diff fg 与现状一致', () => {
    const items = build(
      { type: 'assistant/message', seq: 2, text: '答案', reasoning: 'step one two' },
      {
        type: 'tool/call',
        seq: 3,
        callId: 'r1',
        tool: 'read',
        args: '{"file_path":"a.txt"}',
        summary: 'a.txt',
      },
      { type: 'tool/result', seq: 4, callId: 'r1', ok: true },
    );
    const lines = projectTranscript(items, { cols: 80 });
    expect(lines[1]?.fg).toBe(FG.gray); // reasoning 折叠行
    expect(lines[2]?.fg).toBe(FG.green); // ok 工具行
    const itemsFail = build(
      {
        type: 'tool/call',
        seq: 3,
        callId: 'r2',
        tool: 'read',
        args: '{"file_path":"a.txt"}',
        summary: 'a.txt',
      },
      { type: 'tool/result', seq: 4, callId: 'r2', ok: false, error: '炸了' },
    );
    const failLines = projectTranscript(itemsFail, { cols: 80 });
    expect(failLines[0]?.fg).toBe(FG.red);
    expect(failLines[1]?.fg).toBe(FG.red); // └ ✗
  });

  it('显式 theme=dark 与缺省输出完全一致（逐行 fg）', () => {
    const items = build({ type: 'assistant/message', seq: 2, text: '答案', reasoning: 'step' });
    const a = projectTranscript(items, { cols: 80 });
    const b = projectTranscript(items, { cols: 80, theme: getTheme('dark') });
    expect(b).toEqual(a);
  });

  it('light：reasoning fg 换 light 值', () => {
    const items = build({ type: 'assistant/message', seq: 2, text: '答案', reasoning: 'step' });
    const lines = projectTranscript(items, { cols: 80, theme: getTheme('light') });
    expect(lines[1]?.fg).toBe(LIGHT_THEME.fg.reasoning);
    expect(lines[1]?.fg).not.toBe(FG.gray);
  });

  it('light：tool 三态（pending/ok/failed）换 light 值', () => {
    const items = build(
      {
        type: 'tool/call',
        seq: 3,
        callId: 'r1',
        tool: 'read',
        args: '{"file_path":"a.txt"}',
        summary: 'a.txt',
      },
      { type: 'tool/result', seq: 4, callId: 'r1', ok: true },
      {
        type: 'tool/call',
        seq: 5,
        callId: 'r2',
        tool: 'read',
        args: '{"file_path":"b.txt"}',
        summary: 'b.txt',
      },
      { type: 'tool/result', seq: 6, callId: 'r2', ok: false, error: '炸了' },
    );
    const lines = projectTranscript(items, { cols: 80, theme: getTheme('light') });
    expect(lines[0]?.fg).toBe(LIGHT_THEME.fg.toolOk);
    expect(lines[2]?.fg).toBe(LIGHT_THEME.fg.toolFailed);
    expect(lines[3]?.fg).toBe(LIGHT_THEME.fg.toolResultFailed);
  });

  it('light：diff add/del/hunk 与 partial 提示换 light 值', () => {
    const items = build({
      type: 'tool/call',
      seq: 3,
      callId: 'w1',
      tool: 'write',
      args: JSON.stringify({ file_path: 'n.txt', content: 'a\nb' }),
      summary: 'n.txt',
    });
    const lines = projectTranscript(items, { cols: 80, theme: getTheme('light'), collapsed: new Set([0]) });
    const add = lines.find((l) => l.text.startsWith('+ '));
    const hunk = lines.find((l) => l.text.startsWith('── '));
    expect(add?.fg).toBe(LIGHT_THEME.fg.diffAdd);
    expect(hunk?.fg).toBe(LIGHT_THEME.fg.diffHunk);
    const partial = projectTranscript(
      build({ type: 'turn-partial', seq: 7, turnId: 't9', text: '中断', stopReason: 'cancelled' }),
      { cols: 80, theme: getTheme('light') },
    );
    expect(partial[1]?.fg).toBe(LIGHT_THEME.fg.systemWarn);
  });
});

// —— drawScrollback / chat-screen theme 接线 ——
describe('P4-2 绘制层 theme 接线', () => {
  const COLS = 21;

  it('drawScrollback 缺省选中 fg = SELECTION_FG（零变化）；显式 dark 同值', () => {
    const make = () => {
      const sb = new Scrollback(['hello world'], COLS - 1);
      sb.beginSelection({ row: 0, col: 0 });
      sb.extendSelection({ row: 0, col: 5 });
      return sb;
    };
    const buf1 = new CellBuffer(COLS, 1);
    drawScrollback(buf1, make(), {});
    expect(buf1.fg[0]).toBe(SELECTION_FG);
    const buf2 = new CellBuffer(COLS, 1);
    drawScrollback(buf2, make(), { theme: getTheme('dark') });
    expect(buf2.fg[0]).toBe(SELECTION_FG);
  });

  it('drawScrollback theme=light：选中格 fg = light selection', () => {
    const sb = new Scrollback(['hello world'], COLS - 1);
    sb.beginSelection({ row: 0, col: 0 });
    sb.extendSelection({ row: 0, col: 5 });
    const buf = new CellBuffer(COLS, 1);
    drawScrollback(buf, sb, { theme: getTheme('light') });
    expect(buf.fg[0]).toBe(LIGHT_THEME.fg.selection);
    expect(buf.fg[0]).not.toBe(SELECTION_FG);
  });

  it('renderChat 缺省（无 theme）：光标格 fg = DEFAULT_CURSOR_FG（零变化）', () => {
    const out = new MemOut(80, 24);
    const screen = new Screen(out, 80, 24);
    screen.start({ mouse: false });
    const state: ChatScreenState = {
      scrollback: new Scrollback(),
      draft: 'hi',
      cursor: 0,
      candidates: null,
      overlays: [],
      shortcuts: [],
    };
    renderChat(screen, state);
    const layout = layoutChat(24, 80, state);
    expect(screen.buffer.fg[layout.composer.top * 80 + 0]).toBe(DEFAULT_CURSOR_FG);
    screen.stop();
  });

  it('renderChat state.theme=light：光标格 fg = light cursor', () => {
    const out = new MemOut(80, 24);
    const screen = new Screen(out, 80, 24);
    screen.start({ mouse: false });
    const state: ChatScreenState = {
      scrollback: new Scrollback(),
      draft: 'hi',
      cursor: 0,
      candidates: null,
      overlays: [],
      shortcuts: [],
      theme: getTheme('light'),
    };
    renderChat(screen, state);
    const layout = layoutChat(24, 80, state);
    expect(screen.buffer.fg[layout.composer.top * 80 + 0]).toBe(LIGHT_THEME.fg.cursor);
    expect(screen.buffer.fg[layout.composer.top * 80 + 0]).not.toBe(DEFAULT_CURSOR_FG);
    screen.stop();
  });

  it('renderChat state.theme=light：active 候选高亮 fg = light active', () => {
    const out = new MemOut(80, 24);
    const screen = new Screen(out, 80, 24);
    screen.start({ mouse: false });
    const state: ChatScreenState = {
      scrollback: new Scrollback(),
      draft: '/t',
      cursor: 2,
      candidates: { items: ['/theme'], activeIndex: 0 },
      overlays: [],
      shortcuts: [],
      theme: getTheme('light'),
    };
    renderChat(screen, state);
    const layout = layoutChat(24, 80, state);
    // 候选画在草稿区上方：draftTop - candidateRows = composer.top（唯一候选行）
    expect(layout.candidateRows).toBe(1);
    expect(screen.buffer.fg[layout.composer.top * 80 + 0]).toBe(LIGHT_THEME.fg.active);
    screen.stop();
  });
});

// —— /theme 命令（harness 集成）——
describe('P4-2 /theme 命令', () => {
  /** 含失败工具行的 runtime（`└ ✗` 行为 FG.red 现状色），用于断言切换主题后的重投影生效 */
  function failedToolRuntime(): ChatRuntime {
    return makeRuntime({
      runUserTurn: async (_text, onStream) => {
        onStream({
          type: 'tool-call',
          turnId: 't1',
          call: { id: 'r1', name: 'read', arguments: '{"file_path":"a.txt"}' },
        });
        onStream({ type: 'tool-result', callId: 'r1', ok: false, error: '炸了', turnId: 't1' });
        return result('done', { toolCalls: 1 });
      },
    });
  }

  it('无参：列出可用主题并提示当前（dark）', async () => {
    const { h } = makeHarness();
    await run(h, '/theme');
    const joined = linesOf(h).join('\n');
    expect(joined).toContain('dark（当前）');
    expect(joined).toContain('light');
    expect(joined).toContain('/theme');
    h.dispose();
  });

  it('/theme light：确认行 + 转录立即重投影（失败工具行 fg → light 值）', async () => {
    const { h } = makeHarness(failedToolRuntime());
    await run(h, '读文件');
    const errIdx = linesOf(h).findIndex((l) => l.includes('└ ✗'));
    expect(errIdx).toBeGreaterThanOrEqual(0);
    expect(fgOf(h, errIdx)).toBe(FG.red);
    await run(h, '/theme light');
    expect(linesOf(h).join('\n')).toContain('已切换主题: light');
    expect(fgOf(h, errIdx)).toBe(LIGHT_THEME.fg.toolResultFailed);
    h.dispose();
  });

  it('未知名：error 行提示可用值，主题保持不变', async () => {
    const { h } = makeHarness(failedToolRuntime());
    await run(h, '读文件');
    const errIdx = linesOf(h).findIndex((l) => l.includes('└ ✗'));
    await run(h, '/theme neon');
    expect(linesOf(h).join('\n')).toContain('未知主题');
    expect(fgOf(h, errIdx)).toBe(FG.red); // 仍为 dark 现状值
    h.dispose();
  });

  it('/theme light → /theme dark 切回：fg 恢复现状值（零变化回环），逻辑行文本不变', async () => {
    const { h } = makeHarness(failedToolRuntime());
    await run(h, '读文件');
    const errIdx = linesOf(h).findIndex((l) => l.includes('└ ✗'));
    const textBefore = linesOf(h).join('\n');
    await run(h, '/theme light');
    expect(fgOf(h, errIdx)).toBe(LIGHT_THEME.fg.toolResultFailed);
    await run(h, '/theme dark');
    expect(fgOf(h, errIdx)).toBe(FG.red);
    expect(linesOf(h).join('\n')).toContain(textBefore.split('\n')[errIdx] ?? '');
    h.dispose();
  });
});

// —— /search 命令（harness 集成）——
describe('P4-2 /search 命令', () => {
  const HIT_DARK = DARK_THEME.fg.searchHit;

  /** 小屏 harness + 种子转录（6 条用户消息；finalText 固定 '好的' 不污染搜索词） */
  async function seed(): Promise<Fixture> {
    const out = new MemOut(60, 12); // 视口 ~8 行，6 条消息（每条约 3 行）必溢出
    const gate = createApprovalGate();
    const h = createNextChatHarness(makeRuntime(undefined, '好的'), {
      out,
      bootLines: [],
      env: {},
      gate,
      exit: () => undefined,
    });
    for (const text of [
      'alpha needle one',
      'beta filler',
      'gamma second NEEDLE',
      'delta 中文目标',
      'epsilon filler',
      'zeta filler',
    ]) {
      h.submit(text);
      await settle(h);
    }
    return { h, out, gate, runtime: undefined as unknown as ChatRuntime };
  }

  function indexOfLine(h: NextChatHarness, frag: string): number {
    const idx = linesOf(h).findIndex((l) => l.includes(frag));
    expect(idx, `应存在包含 ${frag} 的行`).toBeGreaterThanOrEqual(0);
    return idx;
  }

  it('命中：system 行「N 处命中（第 1 处）」，计数排除命令回显与搜索状态行', async () => {
    const { h } = await seed();
    await run(h, '/search needle');
    expect(linesOf(h).join('\n')).toContain('搜索 "needle"：2 处命中（第 1 处）');
    h.dispose();
  });

  it('定位：上滚脱离跟随态后搜索视口下方的命中行 → anchor 到命中行（scrollTopRow = 其起始物理行）', async () => {
    const { h } = await seed();
    h.state.scrollback.scrollBy(-999); // 滚到顶（脱离 follow）
    await run(h, '/search 中文'); // delta 行在视口底之后
    const hit = indexOfLine(h, 'delta 中文目标');
    const sb = h.state.scrollback;
    expect(sb.follow).toBe(false);
    expect(sb.scrollTopRow).toBe(sb.lineStart(hit));
    h.dispose();
  });

  it('命中行高亮：fg = 主题 searchHit 色；非命中行不变', async () => {
    const { h } = await seed();
    const hit = indexOfLine(h, 'alpha needle one');
    expect(fgOf(h, hit)).toBeUndefined(); // 搜索前 user 行为默认色
    await run(h, '/search needle');
    expect(fgOf(h, hit)).toBe(HIT_DARK);
    const other = indexOfLine(h, 'beta filler');
    expect(fgOf(h, other)).toBeUndefined();
    h.dispose();
  });

  it('大小写不敏感：needle 命中 NEEDLE 行', async () => {
    const { h } = await seed();
    await run(h, '/search needle');
    const hit2 = indexOfLine(h, 'gamma second NEEDLE');
    expect(fgOf(h, hit2)).toBe(HIT_DARK);
    h.dispose();
  });

  it('中文按子串匹配', async () => {
    const { h } = await seed();
    await run(h, '/search 目标');
    expect(linesOf(h).join('\n')).toContain('搜索 "目标"：1 处命中（第 1 处）');
    h.dispose();
  });

  it('再次 /search 同文本 → 跳下一处（第 2 处）', async () => {
    const { h } = await seed();
    await run(h, '/search needle');
    await run(h, '/search needle');
    expect(linesOf(h).join('\n')).toContain('（第 2 处）');
    const hit2 = indexOfLine(h, 'gamma second NEEDLE');
    const sb = h.state.scrollback;
    expect(sb.scrollTopRow).toBe(sb.lineStart(hit2));
    h.dispose();
  });

  it('/search 无参 = 重复上次查询（跳下一处）', async () => {
    const { h } = await seed();
    await run(h, '/search needle');
    await run(h, '/search');
    expect(linesOf(h).join('\n')).toContain('搜索 "needle"：2 处命中（第 2 处）');
    h.dispose();
  });

  it('循环：跳到末尾后再搜回第 1 处', async () => {
    const { h } = await seed();
    await run(h, '/search needle'); // 第 1 处
    await run(h, '/search needle'); // 第 2 处
    await run(h, '/search needle'); // 循环回第 1 处
    expect(linesOf(h).join('\n')).toContain('（第 1 处）');
    const hit1 = indexOfLine(h, 'alpha needle one');
    const sb = h.state.scrollback;
    expect(sb.scrollTopRow).toBe(sb.lineStart(hit1));
    h.dispose();
  });

  it('未命中：如实「未找到」，高亮按「下次搜索」语义清空', async () => {
    const { h } = await seed();
    await run(h, '/search needle');
    const hit = indexOfLine(h, 'alpha needle one');
    expect(fgOf(h, hit)).toBe(HIT_DARK);
    await run(h, '/search zzz不存在');
    expect(linesOf(h).join('\n')).toContain('搜索 "zzz不存在"：未找到');
    expect(fgOf(h, hit)).toBeUndefined(); // 未命中的搜索替换上一轮高亮（规格：保留到下次搜索或 clear）
    h.dispose();
  });

  it('/search clear：高亮清除（fg 回默认色）+ 确认行', async () => {
    const { h } = await seed();
    await run(h, '/search needle');
    const hit = indexOfLine(h, 'alpha needle one');
    expect(fgOf(h, hit)).toBe(HIT_DARK);
    await run(h, '/search clear');
    expect(linesOf(h).join('\n')).toContain('搜索高亮已清除');
    expect(fgOf(h, hit)).toBeUndefined();
    h.dispose();
  });

  it('/search 无参且无历史：用法提示', async () => {
    const { h } = await seed();
    await run(h, '/search');
    expect(linesOf(h).join('\n')).toContain('用法');
    expect(linesOf(h).join('\n')).toContain('/search');
    h.dispose();
  });

  it('高亮保留：搜索后新内容重投影/追加不清除命中行高亮；echo 与状态行不入计数', async () => {
    const { h } = await seed();
    await run(h, '/search needle');
    const hit = indexOfLine(h, 'alpha needle one');
    h.submit('epsilon new content'); // 追加新行（不含查询词）
    await settle(h);
    expect(fgOf(h, hit)).toBe(HIT_DARK); // 追加后高亮保留
    await run(h, '/search needle');
    // 命中计数保持 2（echo '> /search needle' 与 '搜索 "needle"…' 状态行均排除）
    expect(linesOf(h).join('\n')).toContain('搜索 "needle"：2 处命中');
    h.dispose();
  });
});

// —— busy 状态行 spinner ——
describe('P4-2 busy 状态行 spinner', () => {
  it('busy 且无运行中子代理：状态行 ⏺ → 帧动画（150ms 推进 SPINNER_FRAMES）', async () => {
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
      { cwd: 'C:\\Users\\me\\proj', home: 'C:\\Users\\me' },
    );
    h.submit('跑');
    expect(h.state.statusline).toContain(`${SPINNER_FRAMES[0]} 运行中…`);
    await vi.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS);
    expect(h.state.statusline).toContain(`${SPINNER_FRAMES[1]} 运行中…`);
    await vi.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 2);
    expect(h.state.statusline).toContain(`${SPINNER_FRAMES[3]} 运行中…`);
    release();
    await settle(h);
    expect(h.state.statusline).not.toContain('运行中');
    h.dispose();
  });

  it('状态行动画期间 scrollback 行不变（行级 spinner 不介入）', async () => {
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
    h.submit('跑');
    await vi.advanceTimersByTimeAsync(0);
    const before = linesOf(h).join('\n');
    await vi.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 3);
    expect(linesOf(h).join('\n')).toBe(before);
    release();
    await settle(h);
    h.dispose();
  });

  it('busy 且子代理运行中：状态行保持 ⏺ 静止（行级 spinner 接管，P3-D 语义不回退）', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    const { h } = makeHarness(
      makeRuntime({
        runUserTurn: async (_text, onStream) => {
          onStream({
            type: 'tool-call',
            turnId: 't1',
            call: { id: 'sa1', name: 'subagent_start', arguments: '{"description":"任务"}' },
          });
          await blocker;
          onStream({ type: 'tool-result', callId: 'sa1', ok: true, turnId: 't1' });
          return result('done', { toolCalls: 1 });
        },
      }),
    );
    h.submit('跑子任务');
    await settle(h);
    expect(h.state.statusline).toContain('⏺ 运行中…');
    expect(h.state.statusline).not.toContain(`${SPINNER_FRAMES[0]} 运行中…`);
    const before = h.state.statusline;
    await vi.advanceTimersByTimeAsync(SPINNER_INTERVAL_MS * 2);
    expect(h.state.statusline).toBe(before); // 状态行静止
    release();
    await settle(h);
    h.dispose();
  });

  it('statusLineFor 纯函数：无 spinnerFrame 时保持 ⏺（既有调用零变化）', () => {
    const s = statusLineFor({ cwd: '/w', home: '/', model: 'm', busy: true });
    expect(s.endsWith('⏺ 运行中…')).toBe(true);
    const s2 = statusLineFor({ cwd: '/w', home: '/', model: 'm', busy: true, spinnerFrame: '⠙' });
    expect(s2.endsWith('⠙ 运行中…')).toBe(true);
  });
});
