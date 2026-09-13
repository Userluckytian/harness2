// P3-C 斜杠命令全集 + 模糊补全 单测（headless）。
// 覆盖：命令注册表完整性（对照 ink COMMAND_REGISTRY 全集）、前缀优先+子序列模糊过滤排序、
// 逐字过滤实时更新、Tab/Enter 接受写回 '/cmd '、悬停 move 改选、滚轮在候选上改选、
// 接真实行为的命令（mock runtime 调用断言）、未知命令不静默（共享 '未知命令' 文案）。
// 红绿流程：先于 next-shell.ts / composer.ts 实现落盘（红），实现后转绿（日志存
// Temp/p3c-evidence）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnResult } from '@harness2/core';
import { COMMAND_REGISTRY } from '../../../src/command-registry.js';
import type { ChatRuntime } from '../../../src/chat-setup.js';
import { candidateItemAt } from '../../../src/tui/next/composer.js';
import { layoutChat } from '../../../src/tui/next/chat-screen.js';
import {
  createApprovalGate,
  createNextChatHarness,
  filterCommands,
  NEXT_COMMANDS,
  type ApprovalGate,
  type NextChatHarness,
} from '../../../src/tui/next/next-shell.js';

const ENTER = '\r';
const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const TAB = '\t';
/** SGR 鼠标 move（cb=35 = 32 motion + 3 无按钮）；x/y 为 1 基 */
const moveAt = (row1: number, col1 = 3): string => `\x1b[<35;${col1};${row1}M`;
/** SGR 滚轮上（cb=64, button 0）/ 下（cb=65, button 1） */
const wheelUpAt = (row1: number, col1 = 3): string => `\x1b[<64;${col1};${row1}M`;
const wheelDownAt = (row1: number, col1 = 3): string => `\x1b[<65;${col1};${row1}M`;

class FakeOut {
  buffer = '';
  columns = 100;
  rows = 30;
  write(s: string): unknown {
    this.buffer += s;
    return s.length;
  }
}

function result(finalText: string): TurnResult {
  return {
    stopReason: 'end_turn',
    steps: 1,
    toolCalls: 0,
    durationMs: 1,
    turnId: 't1',
    textOutcome: 'final',
    finalText,
  };
}

/** 内存 mock runtime（只实现 P3-C 消费的面；调用记录挂 __calls 供断言） */
function makeRuntime(overrides: Partial<ChatRuntime> = {}): ChatRuntime {
  const calls = { switchSession: [] as unknown[], fork: [] as unknown[], setReasoning: [] as boolean[] };
  const runtime: ChatRuntime = {
    provider: { name: 'mock' } as ChatRuntime['provider'],
    approval: undefined,
    tools: {} as ChatRuntime['tools'],
    skillsStore: {} as ChatRuntime['skillsStore'],
    sessionManager: {
      list: () => [
        { id: 's1', mtimeMs: 1700000000000, messageCount: 3, firstUserText: '你好' },
        { id: 's2', mtimeMs: 1700000100000, messageCount: 1, firstUserText: '第二会话' },
      ],
      search: () => [],
      locate: () => undefined,
    } as unknown as ChatRuntime['sessionManager'],
    root: '/tmp/harness2-p3c-test',
    getCurrent: () => null,
    switchSession: (id) => {
      calls.switchSession.push(id);
    },
    fork: (at) => {
      calls.fork.push(at);
    },
    runUserTurn: async (text: string) => result(`收到：${text}`),
    abortTurn: () => undefined,
    closeCurrent: () => undefined,
    clearAlwaysAllowed: () => undefined,
    mode: () => 'default',
    setMode: (m) => m,
    reasoning: () => calls.setReasoning[calls.setReasoning.length - 1] ?? false,
    setReasoning: (on) => {
      calls.setReasoning.push(on);
      return on;
    },
    noteCrash: () => undefined,
    submitSteer: () => ({ state: 'unknown', reason: '测试 stub', draftKept: true, message: 'stub' }),
    currentTurnId: () => undefined,
    observeSteer: () => () => undefined,
    finish: async () => undefined,
    ...overrides,
  };
  (runtime as unknown as { __calls: typeof calls }).__calls = calls;
  return runtime;
}

interface Fixture {
  h: NextChatHarness;
  out: FakeOut;
  exitCodes: number[];
  gate: ApprovalGate;
  runtime: ChatRuntime;
}

function makeHarness(runtime: ChatRuntime = makeRuntime(), opts: { bootLines?: string[] } = {}): Fixture {
  const out = new FakeOut();
  const exitCodes: number[] = [];
  const gate = createApprovalGate();
  const h = createNextChatHarness(runtime, {
    out,
    bootLines: opts.bootLines ?? [],
    env: {},
    gate,
    exit: (code) => exitCodes.push(code),
  });
  return { h, out, exitCodes, gate, runtime };
}

function linesOf(h: NextChatHarness): string[] {
  return h.logicalLines();
}

/** 转录是否出现包含给定片段的行 */
function hasLine(h: NextChatHarness, frag: string): boolean {
  return linesOf(h).some((l) => l.includes(frag));
}

/** 输入一个字符（可打印，经 parser 全链进草稿） */
function typeText(h: NextChatHarness, text: string): void {
  h.feed(text);
  h.flushUi();
}

/** 候选区几何：返回候选区顶行（0 基）与可见行数（由 layoutChat 推算，避免硬编码坐标） */
function candidateGeometry(h: NextChatHarness): { top: number; rows: number } {
  const layout = layoutChat(30, 100, h.state);
  return { top: layout.composer.top, rows: layout.candidateRows };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// —— 命令注册表完整性（对照 ink COMMAND_REGISTRY 全集）——
describe('P3-C 命令注册表完整性', () => {
  it('ink COMMAND_REGISTRY 全集逐条都在 next 命令表中（或显式登记差异）', () => {
    const nextNames = NEXT_COMMANDS.map((c) => c.name);
    for (const c of COMMAND_REGISTRY) {
      expect(nextNames).toContain(c.name);
    }
  });

  it('next 扩展命令（/plan /auto /always-approve）在表中且登记 wiring', () => {
    const names = NEXT_COMMANDS.map((c) => c.name);
    expect(names).toContain('plan');
    expect(names).toContain('auto');
    expect(names).toContain('always-approve');
    for (const c of NEXT_COMMANDS) {
      expect(['local', 'shared']).toContain(c.wiring);
    }
  });

  it('过滤结果带 / 前缀（候选渲染格式与 ink matchCommands 一致）', () => {
    for (const item of filterCommands('/u')) {
      expect(item.startsWith('/')).toBe(true);
    }
  });
});

// —— 模糊过滤：前缀优先 + 子序列，各自字典序 ——
describe('模糊过滤 filterCommands', () => {
  it('空输入返回全部命令（字典序）', () => {
    const all = filterCommands('/');
    expect(all.length).toBe(NEXT_COMMANDS.length);
    const sorted = [...all].sort();
    expect(all).toEqual(sorted);
  });

  it('前缀命中优先于子序列命中，各自按字典序（/u → /undo 在前）', () => {
    expect(filterCommands('/u')).toEqual(['/undo', '/auto', '/resume']);
  });

  it('前缀命中（/re → reasoning redo resume + 子序列 always-approve）', () => {
    // 字典序：reasoning < redo（e-a < e-d）；'re' 也是 always-approve 的子序列（…p-p-r-o-v-e）
    expect(filterCommands('/re')).toEqual(['/reasoning', '/redo', '/resume', '/always-approve']);
  });

  it('纯子序列命中（/he → /help）', () => {
    expect(filterCommands('/he')).toEqual(['/help']);
  });

  it('大小写不敏感（/UN → /undo）', () => {
    expect(filterCommands('/UN')).toEqual(['/undo']);
  });

  it('无命中返回空数组（/zz）', () => {
    expect(filterCommands('/zz')).toEqual([]);
  });
});

// —— 逐字过滤实时更新（draft 以 / 开头时）——
describe('逐字过滤与候选状态', () => {
  it('输入 / 显示全部候选', () => {
    const { h } = makeHarness();
    typeText(h, '/');
    expect(h.state.candidates).not.toBeNull();
    expect(h.state.candidates?.items.length).toBe(NEXT_COMMANDS.length);
  });

  it('逐字输入实时缩小候选（/ → /r → /re）', () => {
    const { h } = makeHarness();
    typeText(h, '/');
    typeText(h, 'r');
    expect(h.state.candidates?.items).toEqual(filterCommands('/r'));
    typeText(h, 'e');
    expect(h.state.candidates?.items).toEqual(['/reasoning', '/redo', '/resume', '/always-approve']);
  });

  it('普通文本草稿无候选（不以 / 开头）', () => {
    const { h } = makeHarness();
    typeText(h, 'hello');
    expect(h.state.candidates).toBeNull();
  });

  it('含空格退出命令名阶段（ink commandNameActive 语义）', () => {
    const { h } = makeHarness();
    typeText(h, '/');
    expect(h.state.candidates).not.toBeNull();
    typeText(h, 'help me');
    expect(h.state.candidates).toBeNull();
  });

  it('过滤无命中时候选清除（/zz）', () => {
    const { h } = makeHarness();
    typeText(h, '/zz');
    expect(h.state.candidates).toBeNull();
  });

  it('过滤缩小后 activeIndex 钳制到新范围内', () => {
    const { h } = makeHarness();
    typeText(h, '/');
    h.feed(ARROW_DOWN);
    h.feed(ARROW_DOWN);
    h.feed(ARROW_DOWN);
    h.flushUi();
    expect(h.state.candidates?.activeIndex).toBe(3);
    typeText(h, 'c'); // '/c' → 候选缩到 2 条
    expect(h.state.candidates?.items).toEqual(['/compact', '/context']);
    expect(h.state.candidates?.activeIndex).toBe(1);
  });

  it('候选可见时 ↑↓ 循环改选（内置行为与重算共存）', () => {
    const { h } = makeHarness();
    typeText(h, '/');
    h.feed(ARROW_DOWN);
    h.flushUi();
    expect(h.state.candidates?.activeIndex).toBe(1);
    h.feed(ARROW_UP);
    h.feed(ARROW_UP);
    h.flushUi();
    const n = h.state.candidates?.items.length ?? 0;
    expect(h.state.candidates?.activeIndex).toBe(n - 1);
  });
});

// —— Tab / Enter 接受补全（写回 '/cmd '，含尾随空格退出候选态）——
describe('Tab/Enter 接受候选', () => {
  it('Tab 接受高亮候选：草稿写回 "/undo "（含尾随空格），光标在末尾', () => {
    const { h } = makeHarness();
    typeText(h, '/u');
    h.feed(TAB);
    h.flushUi();
    expect(h.state.draft).toBe('/undo ');
    expect(h.state.cursor).toBe('/undo '.length);
  });

  it('Tab 接受后候选清除（尾随空格退出命令名阶段）', () => {
    const { h } = makeHarness();
    typeText(h, '/u');
    h.feed(TAB);
    h.flushUi();
    expect(h.state.candidates).toBeNull();
  });

  it('Enter 接受候选写回 "/he"→"/help "，不立即提交（runUserTurn 未被调用）', () => {
    const { h, runtime } = makeHarness();
    const spy = vi.spyOn(runtime, 'runUserTurn');
    typeText(h, '/he');
    h.feed(ENTER);
    h.flushUi();
    expect(h.state.draft).toBe('/help ');
    expect(spy).not.toHaveBeenCalled();
  });

  it('接受后再次 Enter 提交命令（转录出现 /help 的命令列表）', () => {
    const { h } = makeHarness();
    typeText(h, '/he');
    h.feed(ENTER);
    h.feed(ENTER);
    h.flushUi();
    expect(hasLine(h, '命令：')).toBe(true);
  });

  it('↑↓ 改选后 Tab 接受的是高亮项', () => {
    const { h } = makeHarness();
    typeText(h, '/s'); // ['/sessions','/always-approve','/resume','/tasks']
    h.feed(ARROW_DOWN);
    h.feed(TAB);
    h.flushUi();
    expect(h.state.draft).toBe(`${filterCommands('/s')[1]} `);
  });
});

// —— 接真实行为的命令（mock runtime 断言；委托共享 handleCommand）——
describe('命令真实行为（共享/本地接线）', () => {
  it('/new → runtime.switchSession(null) 被调用', () => {
    const { h, runtime } = makeHarness();
    const calls = (runtime as unknown as { __calls: { switchSession: unknown[] } }).__calls;
    h.submit('/new');
    h.flushUi();
    expect(calls.switchSession).toEqual([null]);
  });

  it('/undo（无活动会话）→ 共享实现输出 error 行（不再「暂不支持」）', () => {
    const { h } = makeHarness();
    h.submit('/undo');
    h.flushUi();
    expect(hasLine(h, 'error: 无活动会话')).toBe(true);
    expect(hasLine(h, '暂不支持')).toBe(false);
  });

  it('/fork 5 → runtime.fork(5) 被调用', () => {
    const { h, runtime } = makeHarness();
    const calls = (runtime as unknown as { __calls: { fork: unknown[] } }).__calls;
    h.submit('/fork 5');
    h.flushUi();
    expect(calls.fork).toEqual([5]);
  });

  it('/resume 无参 → 用法提示；/resume s1 → switchSession("s1")', () => {
    const { h, runtime } = makeHarness();
    h.submit('/resume');
    h.flushUi();
    expect(hasLine(h, '用法 /resume <id>')).toBe(true);
    const calls = (runtime as unknown as { __calls: { switchSession: unknown[] } }).__calls;
    h.submit('/resume s1');
    h.flushUi();
    expect(calls.switchSession).toContain('s1');
  });

  it('/sessions → 转录文本列出会话（mock sessionManager.list；浮层化登记暂缺）', () => {
    const { h } = makeHarness();
    h.submit('/sessions');
    h.flushUi();
    expect(hasLine(h, 's1')).toBe(true);
    expect(hasLine(h, '3 条')).toBe(true);
  });

  it('/context（无活动会话）→ 占位文案（与 ink 同源）', () => {
    const { h } = makeHarness();
    h.submit('/context');
    h.flushUi();
    expect(hasLine(h, '上下文占用: —（无活动会话）')).toBe(true);
  });

  it('/compact → 自动压缩提示（与 ink 同文案，不静默）', () => {
    const { h } = makeHarness();
    h.submit('/compact');
    h.flushUi();
    expect(hasLine(h, '压缩将在下一次 turn 开始时自动检查并执行')).toBe(true);
  });

  it('/reasoning on → runtime.setReasoning(true) + 确认行；无参显示当前状态', () => {
    const { h, runtime } = makeHarness();
    const calls = (runtime as unknown as { __calls: { setReasoning: boolean[] } }).__calls;
    h.submit('/reasoning on');
    h.flushUi();
    expect(calls.setReasoning).toContain(true);
    expect(hasLine(h, '推理展示已开启')).toBe(true);
    h.submit('/reasoning');
    h.flushUi();
    expect(hasLine(h, '推理展示: 开启')).toBe(true);
  });

  it('/tasks → cron 只读提示（与 ink 同文案）', () => {
    const { h } = makeHarness();
    h.submit('/tasks');
    h.flushUi();
    expect(hasLine(h, 'harness2 cron list')).toBe(true);
  });

  it('/mode 无参 = UI 模式循环一次（等价 Shift+Tab）；带参直接设置四态名', () => {
    const { h } = makeHarness();
    h.submit('/mode');
    h.flushUi();
    expect(h.state.indicators).toContain('plan');
    h.submit('/mode auto');
    h.flushUi();
    expect(h.state.indicators).toContain('auto');
    h.submit('/mode normal');
    h.flushUi();
    expect(h.state.indicators).not.toContain('auto');
  });

  it('/mode 未知参数 → error 行（不静默）', () => {
    const { h } = makeHarness();
    h.submit('/mode xxx');
    h.flushUi();
    expect(hasLine(h, 'error: 未知模式')).toBe(true);
  });

  it('/help → HELP_TEXT（命令： 列表）', () => {
    const { h } = makeHarness();
    h.submit('/help');
    h.flushUi();
    expect(hasLine(h, '命令：')).toBe(true);
  });

  it('/plan /auto /always-approve 保留（P3-B 回归）', () => {
    const { h } = makeHarness();
    h.submit('/always-approve');
    h.flushUi();
    expect(h.state.indicators).toContain('always-approve');
  });

  it('未知命令 /foo → 共享「未知命令」文案（不再出现 next 层「暂不支持」）', () => {
    const { h } = makeHarness();
    h.submit('/foo');
    h.flushUi();
    expect(hasLine(h, '未知命令 /foo')).toBe(true);
    expect(hasLine(h, '暂不支持')).toBe(false);
  });

  it('/exit → 幂等退出路径（exit code 0）', async () => {
    const { h, exitCodes } = makeHarness();
    h.submit('/exit');
    await h.awaitDone();
    expect(exitCodes).toContain(0);
  });

  it('带参命令直接提交不受候选干扰（/undo 2 空格参数阶段无候选）', () => {
    const { h } = makeHarness();
    typeText(h, '/undo 2');
    h.flushUi();
    expect(h.state.candidates).toBeNull();
    h.feed(ENTER);
    h.flushUi();
    expect(hasLine(h, 'error: 无活动会话')).toBe(true);
  });
});

// —— 悬停 / 滚轮改选（grok panes.rs:958 对齐；候选画在 composer 层顶部）——
describe('候选悬停与滚轮改选', () => {
  it('candidateItemAt：候选区相对行 → item 下标（窗口滚动语义）', () => {
    // 16 项、active 0、窗口 6 → 相对行 0..5 映射 0..5
    expect(candidateItemAt(16, 0, 0)).toBe(0);
    expect(candidateItemAt(16, 0, 5)).toBe(5);
    expect(candidateItemAt(16, 0, 6)).toBeNull();
    // active 10：窗口起点 = 10 - 5 = 5 → 相对行 0 映射 item 5
    expect(candidateItemAt(16, 10, 0)).toBe(5);
    // 越界/空
    expect(candidateItemAt(16, 0, -1)).toBeNull();
    expect(candidateItemAt(0, 0, 0)).toBeNull();
  });

  it('悬停 move 在候选行上 → activeIndex 改为命中项', () => {
    const { h } = makeHarness();
    typeText(h, '/');
    const geo = candidateGeometry(h);
    expect(geo.rows).toBeGreaterThan(0);
    h.feed(moveAt(geo.top + 2 + 1)); // 1 基
    h.flushUi();
    expect(h.state.candidates?.activeIndex).toBe(2);
  });

  it('悬停到 active 之外的项后 Tab 接受该项', () => {
    const { h } = makeHarness();
    typeText(h, '/');
    const geo = candidateGeometry(h);
    h.feed(moveAt(geo.top + 2 + 1));
    h.flushUi();
    h.feed(TAB);
    h.flushUi();
    const expected = h.state.candidates === null ? '/compact ' : h.state.draft;
    expect(h.state.draft).toBe(expected);
    expect(h.state.draft).toBe('/compact ');
  });

  it('悬停在候选区外（scrollback 行）→ 不改选', () => {
    const { h } = makeHarness();
    typeText(h, '/');
    const before = h.state.candidates?.activeIndex;
    h.feed(moveAt(3)); // 候选区顶部远上方
    h.flushUi();
    expect(h.state.candidates?.activeIndex).toBe(before);
  });

  it('滚轮在候选区上 → activeIndex -1/+1 循环（wheel up/down）', () => {
    const { h } = makeHarness();
    typeText(h, '/');
    const geo = candidateGeometry(h);
    const n = h.state.candidates?.items.length ?? 0;
    h.feed(wheelUpAt(geo.top + 1)); // 1 基：候选区首行
    h.flushUi();
    expect(h.state.candidates?.activeIndex).toBe(n - 1); // 0 - 1 wrap
    h.feed(wheelDownAt(geo.top + 1));
    h.flushUi();
    expect(h.state.candidates?.activeIndex).toBe(0);
    h.feed(wheelDownAt(geo.top + 1));
    h.flushUi();
    expect(h.state.candidates?.activeIndex).toBe(1);
  });

  it('滚轮在候选区外（scrollback）→ 滚动转录而非改选', () => {
    const bootLines = Array.from({ length: 40 }, (_, i) => `boot line ${i}`);
    const { h } = makeHarness(makeRuntime(), { bootLines });
    typeText(h, '/');
    const before = h.state.candidates?.activeIndex;
    h.feed(wheelDownAt(5)); // scrollback 区域
    h.flushUi();
    expect(h.state.candidates?.activeIndex).toBe(before);
    expect(h.state.scrollback.scrollTopRow).toBeGreaterThan(0);
  });

  it('候选不可见时 move 不产生副作用', () => {
    const { h } = makeHarness();
    typeText(h, 'hello');
    expect(h.state.candidates).toBeNull();
    h.feed(moveAt(5));
    h.flushUi();
    expect(h.state.candidates).toBeNull();
    expect(h.state.draft).toBe('hello');
  });
});
