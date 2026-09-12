// T2-3 scrollback 滚动模型单测（headless，纯逻辑）：
// - 宽字符感知断行（移植 spike wrapLine + renderer charWidth，不切半边）
// - follow（贴底）/ anchor（!follow，scrollTop 物理行锚定）滚动模型与边界钳制
// - 增量 append（follow 贴底 / anchor 不动）、前缀和惰性构建
// - 滚动条几何（thumb 位置/长度纯计算）
import { describe, expect, it } from 'vitest';
import { Scrollback, scrollbarInfo, wrapLine } from '../../../src/tui/next/scrollback.js';
import { displayWidth } from '../../../src/tui/renderer/cell-buffer.js';

describe('wrapLine 宽字符断行', () => {
  it('纯 ASCII 短行不断行', () => {
    expect(wrapLine('hello world', 80)).toEqual(['hello world']);
  });

  it('空行返回单个空物理行', () => {
    expect(wrapLine('', 80)).toEqual(['']);
  });

  it('ASCII 长行按 cols 断行，每段宽度不超 cols', () => {
    const rows = wrapLine('a'.repeat(250), 80);
    expect(rows.length).toBe(4); // 250/80 → 80,80,80,10
    for (const r of rows) expect(displayWidth(r)).toBeLessThanOrEqual(80);
  });

  it('CJK 宽字符行断行不切半边（宽字符整体移到下一行）', () => {
    const rows = wrapLine('渲染层选型需要实测数据支撑'.repeat(6), 20);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) {
      expect(displayWidth(r)).toBeLessThanOrEqual(20);
      expect(displayWidth(r) % 2).toBe(0); // 纯 CJK 行宽度必为偶数（无半个宽字符）
    }
  });

  it('ASCII+CJK 混合：宽字符在行尾放不下时提前断行', () => {
    // cols=10：abcde(5)+中文(4)+X(1) = 10 恰好满，'!' 放不下 → 断行
    expect(wrapLine('abcde中文X!', 10)).toEqual(['abcde中文X', '!']);
    // cols=9：'X' 放不下（9+1>9）→ 断行
    expect(wrapLine('abcde中文X', 9)).toEqual(['abcde中文', 'X']);
    // cols=8：'文'(8+2>8) 整体移下一行 → 'X' 跟随
    expect(wrapLine('abcde中文X', 8)).toEqual(['abcde中', '文X']);
  });

  it('宽字符恰好在边界：cols=8 放两个 CJK（宽 8）不误断', () => {
    expect(wrapLine('中文字符', 8)).toEqual(['中文字符']);
  });

  it('零宽字符（组合符/VS16/ZWJ）不占列，跟随当前行', () => {
    const text = 'e\u0301\uFE0F'; // e + 组合符 + VS16 = 1 列
    expect(displayWidth(text)).toBe(1);
    expect(wrapLine(text, 1)).toEqual([text]);
  });

  it('emoji 按 2 列近似断行，不切半边', () => {
    const rows = wrapLine('🚀🚀🚀🚀🚀', 5);
    for (const r of rows) expect(displayWidth(r)).toBeLessThanOrEqual(5);
    expect(rows.join('')).toBe('🚀🚀🚀🚀🚀'); // 不丢字符
  });

  it('cols=1 时逐字符断行（CJK 独占一行，不产生空前导行）', () => {
    expect(wrapLine('ab', 1)).toEqual(['a', 'b']);
    expect(wrapLine('中文', 1)).toEqual(['中', '文']);
  });

  it('cols ≤ 0 时按 1 列兜底', () => {
    expect(wrapLine('ab', 0)).toEqual(['a', 'b']);
    expect(wrapLine('ab', -3)).toEqual(['a', 'b']);
  });
});

describe('Scrollback 滚动模型：follow 贴底', () => {
  const LINES = Array.from({ length: 100 }, (_, i) => `line-${i}`);

  function make(): Scrollback {
    return new Scrollback(LINES, 80);
  }

  it('初始 follow，内容超一屏时可见窗口为最后 viewportRows 行', () => {
    const sb = make();
    const win = sb.visibleWindow(10);
    expect(sb.follow).toBe(true);
    expect(win.scrollTop).toBe(90);
    expect(win.rows.map((r) => r.text)).toEqual([
      'line-90',
      'line-91',
      'line-92',
      'line-93',
      'line-94',
      'line-95',
      'line-96',
      'line-97',
      'line-98',
      'line-99',
    ]);
  });

  it('follow 时 append 自动贴底（新行进入视口）', () => {
    const sb = make();
    sb.visibleWindow(10); // 先固定 viewport=10
    sb.append('line-100');
    const win = sb.visibleWindow(10);
    expect(sb.follow).toBe(true);
    expect(win.rows.at(-1)?.text).toBe('line-100');
    expect(win.scrollTop).toBe(91);
  });

  it('appendLines 批量追加 follow 贴底', () => {
    const sb = make();
    sb.visibleWindow(10);
    sb.appendLines(['a', 'b', 'c'].map((s, i) => `batch-${i}-${s}`));
    const win = sb.visibleWindow(10);
    expect(win.rows.at(-1)?.text).toBe('batch-2-c');
  });

  it('内容不足一屏：恒 follow、scrollTop=0、空行填充；pageUp 不脱开', () => {
    const sb = new Scrollback(['a', 'b'], 80);
    const win = sb.visibleWindow(10);
    expect(sb.follow).toBe(true);
    expect(win.scrollTop).toBe(0);
    expect(win.rows.map((r) => r.text)).toEqual(['a', 'b', '', '', '', '', '', '', '', '']);
    sb.pageUp();
    expect(sb.visibleWindow(10).scrollTop).toBe(0);
    expect(sb.follow).toBe(true);
  });

  it('空转录：visibleWindow 返回全空行且不抛错', () => {
    const sb = new Scrollback([], 80);
    const win = sb.visibleWindow(5);
    expect(win.rows).toHaveLength(5);
    expect(win.rows.every((r) => r.text === '' && r.lineIndex === -1)).toBe(true);
    expect(sb.totalRows).toBe(0);
  });
});

describe('Scrollback 滚动模型：anchor（脱开 follow）', () => {
  const LINES = Array.from({ length: 100 }, (_, i) => `line-${i}`);

  /** viewport 固定 10 行、贴底（scrollTop=90）的滚动区 */
  function make(): Scrollback {
    const sb = new Scrollback(LINES, 80);
    sb.visibleWindow(10);
    return sb;
  }

  it('pageUp 脱开 follow，scrollTop 上移一屏', () => {
    const sb = make();
    sb.pageUp();
    expect(sb.follow).toBe(false);
    expect(sb.visibleWindow(10).scrollTop).toBe(80);
  });

  it('anchor 下 append：scrollTop 不变，视口内容不动（新内容不推走视口）', () => {
    const sb = make();
    sb.pageUp();
    const before = sb.visibleWindow(10).rows.map((r) => r.text);
    sb.append('new-tail-line');
    const after = sb.visibleWindow(10).rows.map((r) => r.text);
    expect(sb.follow).toBe(false);
    expect(sb.scrollTopRow).toBe(80);
    expect(after).toEqual(before);
    expect(after).not.toContain('new-tail-line');
  });

  it('anchor 稳定性：批量 append 100 行 scrollTop 不动', () => {
    const sb = make();
    sb.pageUp();
    const scrollTopBefore = sb.scrollTopRow;
    sb.appendLines(Array.from({ length: 100 }, (_, i) => `flood-${i}`));
    expect(sb.follow).toBe(false);
    expect(sb.scrollTopRow).toBe(scrollTopBefore);
    expect(sb.visibleWindow(10).rows[0]?.text).toBe('line-80');
  });

  it('goToBottom 回贴 follow 且看到最新行', () => {
    const sb = make();
    sb.pageUp();
    sb.append('tail-after-anchor');
    sb.goToBottom();
    expect(sb.follow).toBe(true);
    expect(sb.visibleWindow(10).rows.at(-1)?.text).toBe('tail-after-anchor');
  });

  it('pageDown 到底恢复 follow', () => {
    const sb = make();
    sb.pageUp();
    sb.pageDown();
    expect(sb.follow).toBe(true);
    expect(sb.scrollTopRow).toBe(sb.maxScrollRow);
  });

  it('scrollBy(+n) 到底恢复 follow；未到底保持 anchor', () => {
    const sb = make();
    sb.pageUp(); // scrollTop 80，max 90
    sb.scrollBy(5);
    expect(sb.follow).toBe(false);
    expect(sb.scrollTopRow).toBe(85);
    sb.scrollBy(100); // 越过底部 → 钳制并恢复 follow
    expect(sb.follow).toBe(true);
    expect(sb.scrollTopRow).toBe(90);
  });

  it('单行滚动 scrollBy(±1) 与边界钳制', () => {
    const sb = make();
    sb.pageUp();
    sb.scrollBy(1);
    expect(sb.scrollTopRow).toBe(81);
    sb.scrollBy(-1);
    sb.scrollBy(-1);
    expect(sb.scrollTopRow).toBe(79);
    sb.scrollBy(-1000); // 顶部钳制到 0
    expect(sb.scrollTopRow).toBe(0);
    expect(sb.follow).toBe(false);
  });

  it('半页滚动 halfPageUp / halfPageDown（半页 = floor(viewport/2)）', () => {
    const sb = make();
    sb.halfPageUp();
    expect(sb.visibleWindow(10).scrollTop).toBe(85);
    sb.halfPageDown(); // 85+5=90 = max → 恢复 follow
    expect(sb.follow).toBe(true);
    sb.pageUp();
    sb.halfPageDown();
    expect(sb.follow).toBe(false);
    expect(sb.scrollTopRow).toBe(85);
  });

  it('wheelUp / wheelDown 每次 3 行', () => {
    const sb = make();
    sb.wheelUp();
    expect(sb.follow).toBe(false);
    expect(sb.scrollTopRow).toBe(87);
    sb.wheelDown();
    sb.wheelDown();
    sb.wheelDown(); // 87+9=96 > 90 → 到底恢复 follow
    expect(sb.follow).toBe(true);
    expect(sb.scrollTopRow).toBe(90);
  });

  it('goToTop 钳到 0 且不恢复 follow', () => {
    const sb = make();
    sb.goToTop();
    expect(sb.follow).toBe(false);
    expect(sb.scrollTopRow).toBe(0);
    expect(sb.visibleWindow(10).rows[0]?.text).toBe('line-0');
  });

  it('visibleWindow 携带 lineIndex/segIndex（跨逻辑行的物理行映射）', () => {
    const sb = new Scrollback(['short', 'x'.repeat(200), 'tail'], 80); // 行1 断成 3 段
    expect(sb.totalRows).toBe(5);
    sb.goToTop();
    const win = sb.visibleWindow(5);
    expect(win.rows.map((r) => [r.lineIndex, r.segIndex, r.text])).toEqual([
      [0, 0, 'short'],
      [1, 0, expect.stringMatching(/^x{80}$/)],
      [1, 1, expect.stringMatching(/^x{80}$/)],
      [1, 2, expect.stringMatching(/^x{40}$/)],
      [2, 0, 'tail'],
    ]);
  });
});

describe('Scrollback 前缀和与 cols 变化', () => {
  it('rowOf / lineStart 惰性构建前缀和', () => {
    const sb = new Scrollback(['a', 'b'.repeat(100), 'c'], 80);
    expect(sb.rowOf(1)).toHaveLength(2);
    expect(sb.lineStart(2)).toBe(3);
    expect(sb.totalRows).toBe(4);
  });

  it('setCols 使 wrap 缓存与前缀和失效并重算', () => {
    const sb = new Scrollback(['a'.repeat(200)], 80);
    expect(sb.totalRows).toBe(3);
    sb.setCols(200);
    expect(sb.totalRows).toBe(1);
    sb.setCols(1);
    expect(sb.totalRows).toBe(200);
  });

  it('setCols 后 scrollTop 按新 maxScroll 钳制（超出时收紧）', () => {
    const sb = new Scrollback(
      Array.from({ length: 50 }, () => 'x'.repeat(100)),
      200,
    );
    sb.visibleWindow(10);
    sb.goToBottom();
    expect(sb.scrollTopRow).toBe(40); // 50 行 × 1 物理行
    sb.setCols(30); // 每行断成 4 物理行 → total 200
    expect(sb.totalRows).toBe(200);
    sb.goToBottom();
    expect(sb.scrollTopRow).toBe(190);
    sb.setCols(200); // 回到 1 物理行/行 → total 50，旧 scrollTop 190 超界
    expect(sb.visibleWindow(10).scrollTop).toBe(40);
  });

  it('append 保持已构建前缀有效（旧行不重复 wrap）', () => {
    const sb = new Scrollback(['a', 'b'], 80);
    expect(sb.totalRows).toBe(2);
    sb.append('c');
    sb.append('d');
    expect(sb.totalRows).toBe(4);
    expect(sb.lineStart(3)).toBe(3);
  });
});

describe('Scrollback 行级前景色（P3-A 配色落地）', () => {
  it('构造函数接受行对象：visibleWindow 物理行携带 fg；字符串行 fg 缺省', () => {
    const sb = new Scrollback([{ text: 'green-line', fg: 0x3fb950 }, 'plain'], 80);
    const win = sb.visibleWindow(10);
    expect(win.rows[0]?.text).toBe('green-line');
    expect(win.rows[0]?.fg).toBe(0x3fb950);
    expect(win.rows[1]?.text).toBe('plain');
    expect(win.rows[1]?.fg).toBeUndefined();
  });

  it('append 行对象/字符串：fg 随行存储，字符串行保持缺省', () => {
    const sb = new Scrollback([], 80);
    sb.append({ text: 'red', fg: 0xf85149 });
    sb.append('default');
    const win = sb.visibleWindow(10);
    expect(win.rows[0]?.fg).toBe(0xf85149);
    expect(win.rows[1]?.fg).toBeUndefined();
  });

  it('appendLines 行对象批量：逐行 fg 保留（字符串行缺省）', () => {
    const sb = new Scrollback([], 80);
    sb.appendLines([{ text: 'a', fg: 0x8b949e }, 'b', { text: 'c', fg: 0xd29922 }]);
    const win = sb.visibleWindow(10);
    expect(win.rows.slice(0, 3).map((r) => r.fg)).toEqual([0x8b949e, undefined, 0xd29922]);
  });

  it('物理断行分段继承逻辑行 fg（wrap 多段同色）', () => {
    const sb = new Scrollback([{ text: 'x'.repeat(200), fg: 0xd29922 }], 80);
    const win = sb.visibleWindow(10);
    const segs = win.rows.slice(0, 3);
    expect(segs).toHaveLength(3);
    for (const r of segs) {
      expect(r.text?.length).toBeGreaterThan(0);
      expect(r.fg).toBe(0xd29922);
    }
  });
});

describe('scrollbarInfo 滚动条几何', () => {
  it('内容不足一屏：不可见（visible=false）', () => {
    const info = scrollbarInfo(10, 24, 0);
    expect(info.visible).toBe(false);
  });

  it('thumb 长度 = viewport²/total（≥1），随比例变化', () => {
    const info = scrollbarInfo(1000, 100, 0);
    expect(info.visible).toBe(true);
    expect(info.thumbHeight).toBe(10); // floor(100*100/1000)
    expect(scrollbarInfo(400, 100, 0).thumbHeight).toBe(25);
  });

  it('thumb 至少 1 行（内容远超一屏）', () => {
    expect(scrollbarInfo(1_000_000, 5, 0).thumbHeight).toBe(1);
  });

  it('thumbTop 随 scrollTop 单调，底部时 thumbTop+thumbHeight = track', () => {
    const total = 1000;
    const vp = 20;
    const top = scrollbarInfo(total, vp, 0);
    const mid = scrollbarInfo(total, vp, 490);
    const bottom = scrollbarInfo(total, vp, 980);
    expect(top.thumbTop).toBe(0);
    expect(mid.thumbTop).toBeGreaterThan(top.thumbTop);
    expect(mid.thumbTop).toBeLessThan(bottom.thumbTop);
    expect(bottom.thumbTop + bottom.thumbHeight).toBe(vp);
  });

  it('ratio ∈ [0,1]，贴底（scrollTop=maxScroll）时为 1', () => {
    expect(scrollbarInfo(100, 10, 90).ratio).toBe(1);
    expect(scrollbarInfo(100, 10, 45).ratio).toBeCloseTo(0.5);
    expect(scrollbarInfo(0, 10, 0).ratio).toBe(1); // 空内容按贴底
  });
});
