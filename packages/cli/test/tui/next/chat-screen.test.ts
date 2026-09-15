// T2-7 chat-screen 整帧装配单测（headless，Screen + 内存流 + 字符网格快照）：
// - layoutChat：columnLayout 分层（scrollback flex / composer 自适应 / statusline 可选 / shortcuts 固定）
//   composer 高度 = measureComposer + candidateRows + 1 提示行（指示器行，无指示器时留空）
// - renderChat：一次 screen.render 回调内画完全部层（scrollback 含滚动条 / 候选 / 草稿 / 光标 /
//   指示行 / statusline / shortcuts / 多浮层栈），返回差量字节数
// - resizeChat：screen 尺寸 + sb.cols 契约同步（内容区宽 = cols - 滚动条列）
// - 差量性：同状态重复渲染 0 字节；draft 追加 1 字符帧 ≪ 全帧
// - 字符网格快照 6 场景：默认帧 / 候选列表 / 单浮层 / 滚动脱离 follow / CJK 断行 / 极端小屏
import { describe, expect, it } from 'vitest';
import { DEFAULT_ACTIVE_FG, DEFAULT_CURSOR_FG } from '../../../src/tui/next/composer.js';
import {
  layoutChat,
  renderChat,
  resizeChat,
  shortcutsText,
  type ChatScreenState,
} from '../../../src/tui/next/chat-screen.js';
import { Scrollback } from '../../../src/tui/next/scrollback.js';
import { Screen } from '../../../src/tui/renderer/screen.js';

class MemOut {
  private chunks: string[] = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  get bytes(): number {
    return Buffer.byteLength(this.chunks.join(''));
  }
  clear(): void {
    this.chunks = [];
  }
}

function makeScreen(cols = 80, rows = 24): { screen: Screen; out: MemOut } {
  const out = new MemOut();
  const screen = new Screen(out, cols, rows);
  screen.start({ mouse: false });
  out.clear();
  return { screen, out };
}

function makeState(overrides: Partial<ChatScreenState> & { draft?: string; cursor?: number }): ChatScreenState {
  const draft = overrides.draft ?? '';
  return {
    scrollback: new Scrollback(),
    draft,
    cursor: overrides.cursor ?? draft.length,
    candidates: null,
    overlays: [],
    shortcuts: [],
    ...overrides,
  };
}

/** 整屏字符网格：buf.rowText 按行拼接（续列跳过，长度 = cols） */
function gridOf(screen: Screen): string[] {
  const buf = screen.buffer;
  const rows: string[] = [];
  for (let y = 0; y < screen.rows; y += 1) rows.push(buf.rowText(y));
  return rows;
}

describe('layoutChat 分层布局', () => {
  it('基本矩形：单行草稿无候选无状态行 → composer 2 行（草稿+提示行），其余给 scrollback', () => {
    const L = layoutChat(24, 80, makeState({ draft: 'hi' }));
    expect(L.draftRows).toBe(1);
    expect(L.candidateRows).toBe(0);
    expect(L.scrollback).toEqual({ top: 0, height: 21 });
    expect(L.composer).toEqual({ top: 21, height: 2 });
    expect(L.statusline).toEqual({ top: 23, height: 0 });
    expect(L.shortcuts).toEqual({ top: 23, height: 1 });
  });

  it('有 statusline：插在 composer 与 shortcuts 之间各占 1 行，scrollback 相应减少', () => {
    const L = layoutChat(24, 80, makeState({ draft: 'hi', statusline: 'plan · 42%' }));
    expect(L.scrollback).toEqual({ top: 0, height: 20 });
    expect(L.composer).toEqual({ top: 20, height: 2 });
    expect(L.statusline).toEqual({ top: 22, height: 1 });
    expect(L.shortcuts).toEqual({ top: 23, height: 1 });
  });

  it('候选列表抬高 composer 高度：3 items → candidateRows 3，composer 高 = 1+3+1', () => {
    const L = layoutChat(24, 80, makeState({ draft: '>', candidates: { items: ['a', 'b', 'c'], activeIndex: 0 } }));
    expect(L.candidateRows).toBe(3);
    expect(L.composer).toEqual({ top: 18, height: 5 });
    expect(L.scrollback).toEqual({ top: 0, height: 18 });
  });

  it('候选超过 6 项封顶：10 items → candidateRows 6', () => {
    const L = layoutChat(
      24,
      80,
      makeState({ draft: '>', candidates: { items: Array.from({ length: 10 }, (_, i) => `i${i}`), activeIndex: 0 } }),
    );
    expect(L.candidateRows).toBe(6);
    expect(L.composer.height).toBe(8);
  });

  it('CJK 超宽草稿软折行抬高 composer：100 个汉字 80 列 → draftRows 3', () => {
    const L = layoutChat(24, 80, makeState({ draft: '中'.repeat(100) }));
    expect(L.draftRows).toBe(3);
    expect(L.composer.height).toBe(4);
  });

  it('极端小屏 rows=6：各层退化但 shortcuts/statusline 优先保住', () => {
    const L = layoutChat(6, 40, makeState({ draft: 'x', statusline: 'S', shortcuts: ['q'] }));
    expect(L.scrollback).toEqual({ top: 0, height: 2 });
    expect(L.composer).toEqual({ top: 2, height: 2 });
    expect(L.statusline).toEqual({ top: 4, height: 1 });
    expect(L.shortcuts).toEqual({ top: 5, height: 1 });
  });

  it('更极端 rows=2、3 行草稿：G-04 收敛退化序——prompt 降 minHeight(1)、scrollback 保 1 行，statusline/shortcuts 归零', () => {
    const L = layoutChat(2, 80, makeState({ draft: 'a\nb\nc', statusline: 'S', shortcuts: ['q'] }));
    // 区域模型（P2-C 收敛，登记差异）：scrollback 最低保 1 行（转录可见优先），
    // prompt 先降 minHeight 再归零——与旧 columnLayout「composer 先截断、scrollback 可 0」不同
    expect(L.scrollback).toEqual({ top: 0, height: 1 });
    expect(L.composer).toEqual({ top: 1, height: 1 });
    expect(L.statusline.height).toBe(0);
    expect(L.shortcuts.height).toBe(0);
  });

  it('shortcutsText：数组以 " · " 连接，字符串原样', () => {
    expect(shortcutsText(['a', 'b', 'c'])).toBe('a · b · c');
    expect(shortcutsText('solo')).toBe('solo');
  });
});

describe('renderChat 整帧装配', () => {
  it('未 start 的 screen：返回 0 字节', () => {
    const out = new MemOut();
    const screen = new Screen(out, 80, 24);
    expect(renderChat(screen, makeState({ draft: 'hi' }))).toBe(0);
    expect(out.bytes).toBe(0);
  });

  it('各层内容落位：草稿 / 指示行右对齐 / shortcuts 左对齐最后一行', () => {
    const { screen } = makeScreen();
    const state = makeState({
      draft: 'hi',
      indicators: ['plan', '40%'],
      shortcuts: ['a', 'b'],
    });
    expect(renderChat(screen, state)).toBeGreaterThan(0);
    const g = gridOf(screen);
    expect(g[21]).toBe('❯ hi' + ' '.repeat(76)); // 草稿行（composer 顶层；P11-T2 锚点）
    expect(g[22]).toBe(' '.repeat(70) + 'plan · 40%'); // 提示行：指示器右对齐
    expect(g[23]).toBe('a · b' + ' '.repeat(75)); // 快捷键条：左对齐（设计决定，快照钉死）
  });

  it('statusline 左对齐画在自己那一行', () => {
    const { screen } = makeScreen();
    const state = makeState({ draft: 'hi', statusline: 'st', shortcuts: [] });
    renderChat(screen, state);
    const g = gridOf(screen);
    expect(g[22]).toBe('st' + ' '.repeat(78));
    expect(g[23]).toBe(' '.repeat(80)); // 无 shortcuts 文本时留空
  });

  it('光标高亮：行中光标格 fg = DEFAULT_CURSOR_FG，字符保持不变', () => {
    const { screen } = makeScreen();
    const state = makeState({ draft: 'hello', cursor: 2 });
    renderChat(screen, state);
    const buf = screen.buffer;
    const idx = 21 * 80 + 4; // composer top=21；P11-T2 锚点 '❯ ' 占 2 列 → 逻辑列 2 = x4
    expect(buf.chars[idx]).toBe('l');
    expect(buf.fg[idx]).toBe(DEFAULT_CURSOR_FG);
    expect(buf.fg[21 * 80 + 6]).toBe(0); // 其余字符不受影响（x6 = 'o'）
  });

  it('光标高亮：行尾光标（col=行宽）高亮行尾后的空白格（与 renderComposer 同语义）', () => {
    const { screen } = makeScreen();
    const state = makeState({ draft: 'hello' });
    renderChat(screen, state);
    const buf = screen.buffer;
    expect(buf.chars[21 * 80 + 7]).toBe(' '); // 2（锚点）+ 5（文本末）
    expect(buf.fg[21 * 80 + 7]).toBe(DEFAULT_CURSOR_FG);
  });

  it('光标高亮：行首光标格 x=锚点宽（草稿仍在锚点右侧）', () => {
    const { screen } = makeScreen();
    const state = makeState({ draft: 'hello', cursor: 0 });
    renderChat(screen, state);
    const buf = screen.buffer;
    expect(buf.fg[21 * 80 + 2]).toBe(DEFAULT_CURSOR_FG);
    expect(buf.chars[21 * 80 + 2]).toBe('h');
  });

  it('候选列表：画在草稿区上方，active 行 fg 高亮，其余默认色', () => {
    const { screen } = makeScreen();
    const state = makeState({
      draft: '>',
      candidates: { items: ['plan', 'auto', 'read-only'], activeIndex: 1 },
    });
    renderChat(screen, state);
    const buf = screen.buffer;
    const g = gridOf(screen);
    // composer h=5 → top=18：候选 18..20，草稿 21，提示行 22，shortcuts 23
    expect(g[18]).toBe('plan' + ' '.repeat(76));
    expect(g[19]).toBe('auto' + ' '.repeat(76));
    expect(g[20]).toBe('read-only' + ' '.repeat(71));
    expect(g[21]).toBe('❯ >' + ' '.repeat(77));
    expect(buf.fg[18 * 80 + 0]).toBe(0);
    expect(buf.fg[19 * 80 + 0]).toBe(DEFAULT_ACTIVE_FG);
    expect(buf.fg[20 * 80 + 0]).toBe(0);
  });

  it('单浮层：锚定 composerTop 之上，标题 + 分隔线 + 条目（active 前缀 ❯）', () => {
    const { screen } = makeScreen();
    const state = makeState({
      draft: 'hello',
      overlays: [{ title: 'Select Model', items: ['grok-4', 'claude-x', 'gpt-5'], activeIndex: 0 }],
    });
    renderChat(screen, state);
    const g = gridOf(screen);
    // composerTop=21，浮层 h=2+3=5 → 16..20（第 16 行仍在 scrollback 区，行尾残留滚动条轨道）
    expect(g[16]?.startsWith(' Select Model ')).toBe(true);
    expect(g[17]).toBe('─'.repeat(80)); // 分隔线铺满全宽（覆盖轨道列）
    expect(g[18]?.startsWith('❯ grok-4')).toBe(true);
    expect(g[19]?.startsWith('  claude-x')).toBe(true);
    expect(g[20]?.startsWith('  gpt-5')).toBe(true);
    expect(g[21]).toBe('❯ hello' + ' '.repeat(73)); // 浮层不侵占 composer
  });

  it('多浮层栈：自下而上，第 2 层贴第 1 层上方', () => {
    const { screen } = makeScreen();
    const state = makeState({
      draft: 'hi',
      overlays: [{ items: ['a1', 'a2'] }, { title: 'T', items: ['b1'] }],
    });
    renderChat(screen, state);
    const g = gridOf(screen);
    // composerTop=21；栈底 h=1 分隔线+2 条目=3 → 18..20；栈上 h=1 标题+分隔线+1 条目=3 → 15..17
    expect(g[18]).toBe('─'.repeat(80)); // 无标题浮层也恒有分隔线行（overlayChromeRows）
    expect(g[19]?.startsWith('  a1')).toBe(true);
    expect(g[20]?.startsWith('  a2')).toBe(true); // 栈底浮层底部贴 composerTop-1
    expect(g[15]?.startsWith(' T ')).toBe(true);
    expect(g[16]).toBe('─'.repeat(80));
    expect(g[17]?.startsWith('  b1')).toBe(true);
  });

  it('浮层空间不足钳到屏幕顶并截断高度（小屏 rows=6）', () => {
    const { screen } = makeScreen(40, 6);
    const state = makeState({
      draft: 'x',
      shortcuts: 'q',
      overlays: [{ title: 'T', items: ['i1', 'i2', 'i3', 'i4'] }],
    });
    renderChat(screen, state);
    const g = gridOf(screen);
    // composerTop=3（scrollback 0..2 / composer 3..4 / shortcuts 5），浮层需求 6 → 截到 3 行
    expect(g[0]?.startsWith(' T ')).toBe(true);
    expect(g[1]).toBe('─'.repeat(40));
    expect(g[2]?.startsWith('  i1')).toBe(true);
    expect(g[3]).toBe('❯ x' + ' '.repeat(37));
    expect(g[4]).toBe(' '.repeat(40)); // 提示行（无指示器留空）
    expect(g[5]).toBe('q' + ' '.repeat(39));
  });

  it('滚动条：贴底时 thumb 在轨道尾部，正文不越进滚动条列', () => {
    const { screen } = makeScreen();
    const lines = Array.from({ length: 60 }, (_, i) => `msg-${i}`);
    const state = makeState({ draft: 'x', scrollback: new Scrollback(lines) });
    renderChat(screen, state);
    const buf = screen.buffer;
    // scrollback 高 21（0..20），total=60 vp=21 → thumbH=7，贴底 → 14..20
    for (let y = 14; y < 21; y += 1) expect(buf.chars[y * 80 + 79]).toBe('█');
    for (let y = 0; y < 14; y += 1) expect(buf.chars[y * 80 + 79]).toBe('│');
    const g = gridOf(screen);
    expect(g[20]?.startsWith('msg-59')).toBe(true);
    expect(g[20]?.endsWith('█')).toBe(true);
  });

  it('scrollback cols 契约：renderChat 自动同步 sb.cols = cols - 1（滚动条列）', () => {
    const { screen } = makeScreen();
    const sb = new Scrollback(['x'], 40); // 故意错误的初始 cols
    renderChat(screen, makeState({ draft: '', scrollback: sb }));
    expect(sb.cols).toBe(79);
  });

  it('CJK 宽字符行不切半边、不越进滚动条列（续列宽度记 0）', () => {
    const { screen } = makeScreen();
    const state = makeState({ draft: '', scrollback: new Scrollback(['中'.repeat(50)]) });
    renderChat(screen, state);
    const g = gridOf(screen);
    // 内容区 79 列 → 每物理行 39 个汉字（78 列），第 40 个放不下整体移行
    // rowText：39 汉字（续列跳过）+ col78 空白 + col79 轨道字符
    expect(g[0]).toBe('中'.repeat(39) + ' ' + '│');
    expect(g[1]?.startsWith('中'.repeat(11))).toBe(true);
    const buf = screen.buffer;
    expect(buf.widths[0 * 80 + 1]).toBe(0); // 首个汉字的续列
  });

  it('resizeChat：同步 screen 尺寸与 sb.cols 契约，下一帧按新尺寸绘制', () => {
    const { screen } = makeScreen();
    const sb = new Scrollback(['hello world']);
    const state = makeState({ draft: 'hi', scrollback: sb, shortcuts: ['q'] });
    renderChat(screen, state);
    resizeChat(screen, state, 60, 20);
    expect(screen.cols).toBe(60);
    expect(screen.rows).toBe(20);
    expect(sb.cols).toBe(59);
    renderChat(screen, state);
    const g = gridOf(screen);
    expect(g).toHaveLength(20);
    for (const row of g) expect(row).toHaveLength(60);
    expect(g[19]).toBe('q' + ' '.repeat(59));
    expect(g[17]).toBe('❯ hi' + ' '.repeat(56)); // composer top=17（scrollback 0..16）
  });

  it('差量性：同状态连续两次 renderChat，第二次 0 字节', () => {
    const { screen, out } = makeScreen();
    const state = makeState({
      draft: 'hello',
      statusline: 'plan',
      shortcuts: ['a', 'b'],
      scrollback: new Scrollback(['line-1', 'line-2']),
    });
    expect(renderChat(screen, state)).toBeGreaterThan(0);
    out.clear();
    expect(renderChat(screen, state)).toBe(0);
    expect(out.bytes).toBe(0);
  });

  it('差量性：draft 追加 1 字符的帧字节量 ≪ 全帧', () => {
    const { screen, out } = makeScreen();
    const state = makeState({
      draft: 'hello',
      statusline: 'plan',
      shortcuts: ['a', 'b'],
      scrollback: new Scrollback(Array.from({ length: 40 }, (_, i) => `line-${i}`)),
    });
    renderChat(screen, state);
    const fullFrame = out.bytes;
    out.clear();
    renderChat(screen, { ...state, draft: 'hello!' });
    const delta = out.bytes;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(fullFrame);
  });
});

describe('字符网格快照（固定 rows/cols 整屏 rowText）', () => {
  it('快照①：默认帧（3 行草稿 + 光标 + 状态行 + 快捷键条）', () => {
    const { screen } = makeScreen(80, 24);
    const state = makeState({
      scrollback: new Scrollback(['Welcome to harness2', '', 'User: 你好', 'Assistant: 你好！有什么可以帮你？']),
      draft: 'first line\nsecond line\nthird line',
      statusline: 'plan · model-x · ctx 42%',
      shortcuts: ['Enter Send', 'Shift+Tab Mode', 'Ctrl+C Quit'],
    });
    renderChat(screen, state);
    expect(gridOf(screen)).toMatchSnapshot();
  });

  it('快照②：候选列表（active 高亮行）', () => {
    const { screen } = makeScreen(80, 24);
    const state = makeState({
      scrollback: new Scrollback(['User: /mode', '']),
      draft: '> deploy',
      candidates: { items: ['plan', 'auto-edit', 'read-only', 'full-access'], activeIndex: 2 },
      shortcuts: ['Enter Send', 'Tab Next'],
    });
    renderChat(screen, state);
    expect(gridOf(screen)).toMatchSnapshot();
  });

  it('快照③：单浮层（标题 + 分隔线 + 条目）锚定输入框上方', () => {
    const { screen } = makeScreen(80, 24);
    const state = makeState({
      scrollback: new Scrollback(['User: /model', '']),
      draft: 'hello',
      overlays: [{ title: 'Select Model', items: ['grok-4-fast', 'claude-x', 'gpt-5-mini'], activeIndex: 1 }],
      shortcuts: ['Esc Close'],
    });
    renderChat(screen, state);
    expect(gridOf(screen)).toMatchSnapshot();
  });

  it('快照④：滚动脱离 follow（scrollTop 中部，thumb 非底部）', () => {
    const { screen } = makeScreen(80, 24);
    const lines = Array.from({ length: 60 }, (_, i) => `msg-${i}`);
    const sb = new Scrollback(lines);
    const state = makeState({ scrollback: sb, draft: '', shortcuts: ['Ctrl+C Quit'] });
    renderChat(screen, state); // 首帧贴底（同时确定 viewportRows）
    sb.scrollBy(-10); // 上滚 10 物理行 → 脱离 follow
    renderChat(screen, state);
    expect(sb.follow).toBe(false);
    expect(sb.scrollTopRow).toBe(29); // vp=21 → maxScroll=39，39-10=29
    expect(gridOf(screen)).toMatchSnapshot();
  });

  it('快照⑤：CJK 长行断行 + 宽字符混排', () => {
    const { screen } = makeScreen(80, 24);
    const state = makeState({
      scrollback: new Scrollback([
        '中文输出是终端渲染的常见场景，宽字符占两列，断行时绝不能切半边，这一行足够长以便触发软折行行为。',
        'mixed 中英混排 line with emoji 🚀 and CJK 字符。',
        '短行',
      ]),
      draft:
        '输入一段中文草稿，长度超过八十列时会软折行，光标应落在正确的物理行上。再补一段确保超过四十个汉字触发输入框内的软折行。',
      shortcuts: ['Enter Send'],
    });
    renderChat(screen, state);
    expect(gridOf(screen)).toMatchSnapshot();
  });

  it('快照⑥：极端小屏（rows=6）', () => {
    const { screen } = makeScreen(40, 6);
    const state = makeState({
      scrollback: new Scrollback(['hello world', 'second line']),
      draft: 'ab\ncd',
      statusline: 'PLAN',
      shortcuts: ['Ctrl+C Quit'],
    });
    renderChat(screen, state);
    expect(gridOf(screen)).toMatchSnapshot();
  });
});

describe('截断渲染路径钉死（审查 P2-1）', () => {
  it('rows=8 + 超长草稿：G-04 收敛退化序——statusline/shortcuts 归零、prompt 降 1 行（光标行贴底兜底可见末行草稿）', () => {
    const { screen } = makeScreen(80, 8);
    const state = makeState({
      draft: 'l1\nl2\nl3\nl4\nl5\nl6\nl7',
      statusline: 'status',
      shortcuts: ['q quit'],
    });
    state.scrollback.append('hello world');
    const L = layoutChat(8, 80, state);
    // 区域模型（P2-C 收敛，登记差异）：scrollback 最低保 1 行、prompt 降到 minHeight=1
    // （drawComposer 光标行贴底滚动兜底 → 末行草稿 l7 仍可见）；statusline/shortcuts 砍单归零
    expect(L.scrollback).toEqual({ top: 0, height: 7 });
    expect(L.composer).toEqual({ top: 7, height: 1 });
    expect(L.statusline.height).toBe(0);
    expect(L.shortcuts.height).toBe(0);
    renderChat(screen, state);
    const text = gridOf(screen).join('\n');
    expect(text).toContain('l7'); // 光标行贴底兜底：末行草稿可见
    expect(text).not.toContain('status'); // 固定层被砍单
    expect(text).not.toContain('q quit');
  });

  it('rows=2 + 候选：退化屏不崩；drawComposer(top=0+候选 3 行)≥buf.rows 整体早退不画（候选优先于草稿的取舍，钉死）', () => {
    const { screen } = makeScreen(80, 2);
    const state = makeState({
      draft: 'x',
      candidates: { items: ['a', 'b', 'c'], activeIndex: 0 },
      shortcuts: ['q quit'],
    });
    expect(() => renderChat(screen, state)).not.toThrow();
    const text = gridOf(screen).join('\n');
    expect(text).not.toContain('x');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// P11-T2 输入区可见性（整帧）
// ═══════════════════════════════════════════════════════════════════════
describe('P11-T2 输入区可见性（整帧）', () => {
  it('空态帧：锚点 + 弱化占位；占位不进草稿', () => {
    const { screen } = makeScreen();
    const state = makeState({ draft: '', cursor: 0 });
    renderChat(screen, state);
    const g = gridOf(screen);
    expect(g[21]?.startsWith('❯ 输入消息，/ 查看命令')).toBe(true);
    // 占位弱化色 = theme.fg.system（dark 0x8b949e）；x2/x3 被光标格覆盖，取 x4
    expect(screen.buffer.fg[21 * 80 + 4]).toBe(0x8b949e);
    expect(state.draft).toBe(''); // 占位是纯呈现，绝不进入提交内容
  });

  it('有草稿帧：锚点 + 草稿原文；光标在草稿处', () => {
    const { screen } = makeScreen();
    const state = makeState({ draft: 'hello', cursor: 2 });
    renderChat(screen, state);
    const g = gridOf(screen);
    expect(g[21]?.startsWith('❯ hello')).toBe(true);
    expect(screen.buffer.chars[21 * 80 + 4]).toBe('l'); // 光标逻辑列 2 = 锚点 2 + 2
    expect(screen.buffer.fg[21 * 80 + 4]).toBe(DEFAULT_CURSOR_FG);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// P11-T3 候选两列化（整帧）
// ═══════════════════════════════════════════════════════════════════════
describe('P11-T3 候选两列化（整帧）', () => {
  it('宽画布：命令行同列含灰说明；选中高亮保持', () => {
    const { screen } = makeScreen(80, 24);
    const state = makeState({
      draft: '/',
      candidates: {
        items: ['/help', '/new'],
        summaries: ['显示本帮助', '新建会话'],
        activeIndex: 0,
      },
    });
    renderChat(screen, state);
    const g = gridOf(screen);
    const helpRow = g.findIndex((r) => r.startsWith('/help'));
    expect(helpRow).toBeGreaterThanOrEqual(0);
    expect(g[helpRow]?.startsWith('/help  显示本帮助')).toBe(true);
    expect(screen.buffer.fg[helpRow * 80 + 0]).toBe(DEFAULT_ACTIVE_FG); // 选中行
    expect(screen.buffer.fg[helpRow * 80 + 7]).toBe(0x8b949e); // 说明灰（theme.fg.system）
  });
});

// ═══════════════════════════════════════════════════════════════════════
// P11-T7 冷启动引导卡（整帧）
// ══════════════════════════════════════════════════════════════════════
describe('P11-T7 冷启动引导卡（整帧）', () => {
  const CARD = {
    title: 'harness2 1.0.0 · 欢迎（按任意键收起）',
    lines: ['/help 查看全部命令', 'Enter 发送 · Shift+Enter 换行', 'Ctrl+C 退出'],
  };

  it('有引导卡：标题 + 行画在 composer 上方（不侵占输入区）', () => {
    const { screen } = makeScreen();
    const state = makeState({ draft: 'hi', welcome: CARD });
    renderChat(screen, state);
    const g = gridOf(screen);
    const joined = g.join('\n');
    expect(joined).toContain('欢迎（按任意键收起）');
    expect(joined).toContain('/help 查看全部命令');
    expect(g[21]).toBe('❯ hi' + ' '.repeat(76)); // composer 仍在自己的行
  });

  it('无引导卡：帧内不含欢迎文案', () => {
    const { screen } = makeScreen();
    renderChat(screen, makeState({ draft: 'hi', welcome: null }));
    expect(gridOf(screen).join('\n')).not.toContain('欢迎');
  });
});
