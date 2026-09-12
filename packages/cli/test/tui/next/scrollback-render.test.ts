// T2-3 scrollback 组合渲染单测（headless，Screen + 内存流）：
// - renderScrollback 把 visibleWindow 写入 cell buffer（右侧滚动条轨道列）
// - 宽字符行不越界进入滚动条列（整字丢弃语义）；空行填充；局部渲染（top/height/width）
// - 差量帧字节量：追加未满屏/锚定追加 ≪ 全帧、anchor 追加 0 字节、无变化帧 0 字节；
//   任意内容整屏平移 ≈ 全帧（行级 diff 的已知边界，如实钉死记录）
// - 性能冒烟（宽松阈值防 flaky）：10k 行 wrap、100 行批量 append、单帧渲染
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { renderScrollback, Scrollback } from '../../../src/tui/next/scrollback.js';
import { FG } from '../../../src/tui/next/projection.js';
import { Screen } from '../../../src/tui/renderer/screen.js';
import { generateLines } from './helpers/generate-transcript.js';

class MemOut {
  private chunks: string[] = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  get text(): string {
    return this.chunks.join('');
  }
  get bytes(): number {
    return Buffer.byteLength(this.chunks.join(''));
  }
  clear(): void {
    this.chunks = [];
  }
}

describe('renderScrollback 组合渲染', () => {
  function makeScreen(): { screen: Screen; out: MemOut } {
    const out = new MemOut();
    const screen = new Screen(out, 80, 24);
    screen.start();
    out.clear();
    return { screen, out };
  }

  it('首帧把可见窗口写入 buffer（贴底 + 滚动条轨道）', () => {
    const { screen, out } = makeScreen();
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
    const sb = new Scrollback(lines, 79); // 79 = 80 - 1 滚动条列
    const bytes = renderScrollback(screen, sb);
    expect(bytes).toBeGreaterThan(0);
    expect(out.text).toContain('line-99');
    expect(out.text).not.toContain('line-75'); // viewport 24 行：76..99 + 空行
    const buf = screen.buffer;
    expect(buf.chars[0 * 80 + 79]).toBe('│'); // 每行最右列为轨道字符
  });

  it('滚动条 thumb 画在正确行（贴底时 thumb 在轨道尾部）', () => {
    const { screen } = makeScreen();
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
    const sb = new Scrollback(lines, 79);
    renderScrollback(screen, sb);
    const buf = screen.buffer;
    // total=100, vp=24 → thumb=floor(24*24/100)=5，贴底 → thumbTop=19..23
    for (let y = 19; y < 24; y += 1) expect(buf.chars[y * 80 + 79]).toBe('█');
    for (let y = 0; y < 19; y += 1) expect(buf.chars[y * 80 + 79]).toBe('│');
  });

  it('宽字符行不越界进入滚动条列（整字丢弃语义，sb.cols=80 > 内容区 79）', () => {
    const { screen } = makeScreen();
    const sb = new Scrollback(['中'.repeat(40)], 80); // 单物理行宽 80 > 内容区 79
    renderScrollback(screen, sb);
    const buf = screen.buffer;
    // 第 40 个 CJK 起点 x=78，78+2>79 → 整字丢弃；滚动条列仍是轨道
    expect(buf.chars[0]).toBe('中');
    expect(buf.chars[76]).toBe('中');
    expect(buf.widths[78]).toBe(0);
    expect(buf.chars[78]).toBe(' ');
    expect(buf.chars[79]).toBe('│');
  });

  it('wrap 后物理行宽度不超 sb.cols（79 列），右列不写续列', () => {
    const { screen } = makeScreen();
    const sb = new Scrollback(['中'.repeat(60)], 79); // 60 个 CJK = 120 列 → 39+21 两行
    renderScrollback(screen, sb);
    const buf = screen.buffer;
    expect(buf.chars[0]).toBe('中');
    expect(buf.chars[76]).toBe('中'); // 首行 39 个 CJK 占 x 0..77
    expect(buf.widths[78]).toBe(0);
    expect(buf.chars[78]).toBe(' ');
    expect(buf.chars[79]).toBe('│');
  });

  it('内容不足一屏：空行填充，滚动条不可见时画满轨道', () => {
    const { screen } = makeScreen();
    const sb = new Scrollback(['hello', 'world'], 79);
    renderScrollback(screen, sb);
    const buf = screen.buffer;
    expect(buf.chars[0]).toBe('h');
    for (let y = 5; y < 24; y += 1) expect(buf.chars[y * 80 + 79]).toBe('│');
  });

  it('opts.top/height/width 局部渲染', () => {
    const { screen } = makeScreen();
    const sb = new Scrollback(
      Array.from({ length: 50 }, (_, i) => `L${i}`),
      59,
    );
    renderScrollback(screen, sb, { top: 4, height: 10, width: 60 });
    const buf = screen.buffer;
    expect(buf.chars[0]).toBe(' '); // top 之上未写
    expect(buf.chars[4 * 80]).toBe('L'); // 首个可见行从 top=4 开始
    expect(buf.chars[4 * 80 + 59]).toBe('│'); // width=60 → 滚动条列 x=59
    expect(buf.chars[4 * 80 + 79]).toBe(' '); // width 之外未写
  });

  it('scrollbar:false 不画滚动条列', () => {
    const { screen } = makeScreen();
    const sb = new Scrollback(
      Array.from({ length: 50 }, (_, i) => `L${i}`),
      80,
    );
    renderScrollback(screen, sb, { scrollbar: false });
    const buf = screen.buffer;
    expect(buf.chars[79]).toBe(' ');
    expect(buf.rowText(0)).toContain('L');
  });

  it('自定义轨道/thumb 字符', () => {
    const { screen } = makeScreen();
    const sb = new Scrollback(
      Array.from({ length: 100 }, (_, i) => `L${i}`),
      79,
    );
    renderScrollback(screen, sb, { trackChar: '-', thumbChar: '#' });
    const buf = screen.buffer;
    expect(buf.chars[79]).toBe('-');
    expect(buf.chars[23 * 80 + 79]).toBe('#');
  });

  it('无变化帧 0 字节（幂等差量）', () => {
    const { screen, out } = makeScreen();
    const sb = new Scrollback(
      Array.from({ length: 100 }, (_, i) => `L${i}`),
      79,
    );
    renderScrollback(screen, sb);
    out.clear();
    const bytes = renderScrollback(screen, sb);
    expect(bytes).toBe(0);
    expect(out.text).toBe('');
  });

  it('anchor 模式追加：内容与滚动条不变 → 0 字节', () => {
    const { screen, out } = makeScreen();
    const sb = new Scrollback(
      Array.from({ length: 100 }, (_, i) => `L${i}`),
      79,
    );
    renderScrollback(screen, sb);
    sb.pageUp();
    renderScrollback(screen, sb); // 建立 anchor 态基线
    out.clear();
    sb.append('appended-while-anchored');
    const bytes = renderScrollback(screen, sb);
    expect(bytes).toBe(0);
    expect(out.text).toBe('');
  });

  it('追加未满屏：仅新增行变化 → 帧字节远小于全帧', () => {
    const { screen, out } = makeScreen();
    const sb = new Scrollback(
      Array.from({ length: 20 }, (_, i) => `line-${i}`),
      79,
    );
    const fullFrame = renderScrollback(screen, sb);
    expect(fullFrame).toBeGreaterThan(500);
    out.clear();
    sb.append('line-20-new');
    const incFrame = renderScrollback(screen, sb);
    expect(incFrame).toBeGreaterThan(0);
    expect(incFrame).toBeLessThan(fullFrame / 10); // 只写新增行所在格
  });

  it('单行上滚帧（行尾数字变化的行）小于全帧：单元格级差量生效', () => {
    const { screen, out } = makeScreen();
    const sb = new Scrollback(
      Array.from({ length: 1000 }, (_, i) => `line-${i}`),
      79,
    );
    const fullFrame = renderScrollback(screen, sb);
    out.clear();
    sb.append('line-1000');
    const scrollFrame = renderScrollback(screen, sb);
    expect(scrollFrame).toBeGreaterThan(0);
    // 每行只有行尾 1~2 个数字格变化 + CUP 定位开销 → 约为全帧一半以下
    expect(scrollFrame).toBeLessThan(fullFrame / 2);
  });

  it('任意内容整屏平移：行级 diff 下 ≈ 全帧（已知边界，如实钉死；CSI 滚动区优化列为遗留）', () => {
    const { screen, out } = makeScreen();
    const sb = new Scrollback(generateLines(200, 3), 79); // 每行内容互不相同
    const fullFrame = renderScrollback(screen, sb);
    out.clear();
    sb.wheelUp();
    const scrollFrame = renderScrollback(screen, sb);
    expect(scrollFrame).toBeGreaterThan(0);
    // 整屏上滚 3 行 → 24 行内容全部错位 → 差量帧与全帧同量级
    // （每行碎段各带一次 CUP，可略超全帧；CSI 滚动区/相对定位优化列为遗留项）
    expect(scrollFrame).toBeGreaterThan(fullFrame / 2);
  });

  it('输出接内存流：序列含 CUP 定位且可完整回放', () => {
    const { screen, out } = makeScreen();
    const sb = new Scrollback(['alpha', 'beta'], 79);
    renderScrollback(screen, sb);
    expect(out.text).toContain('\x1b[1;1H'); // CUP 0,0
    expect(out.text).toContain('alpha');
    expect(out.text).toContain('beta');
  });
});

describe('drawScrollback 逐行前景色（P3-A 配色落地）', () => {
  function makeScreen(): { screen: Screen; out: MemOut } {
    const out = new MemOut();
    const screen = new Screen(out, 80, 24);
    screen.start();
    out.clear();
    return { screen, out };
  }

  it('行 fg 渲染进 cell buffer：绿色行各字符格 fg = FG.green', () => {
    const { screen } = makeScreen();
    const sb = new Scrollback([{ text: 'green text', fg: FG.green }], 79);
    renderScrollback(screen, sb);
    const buf = screen.buffer;
    expect(buf.chars[0]).toBe('g');
    expect(buf.fg[0]).toBe(FG.green);
    expect(buf.fg[5]).toBe(FG.green); // 行中字符格
  });

  it('无 fg 行回退 opts.fg（缺省 0 = 终端默认色）', () => {
    const { screen } = makeScreen();
    const sb = new Scrollback(['plain'], 79);
    renderScrollback(screen, sb);
    expect(screen.buffer.fg[0]).toBe(0);
    const sb2 = new Scrollback(['plain'], 79);
    renderScrollback(screen, sb2, { fg: FG.gray });
    expect(screen.buffer.fg[0]).toBe(FG.gray);
  });

  it('混排：相邻行各自生效（红行 fg 与缺省行 fg 互不串色）', () => {
    const { screen } = makeScreen();
    const sb = new Scrollback([{ text: 'bad', fg: FG.red }, 'ok-default'], 79);
    renderScrollback(screen, sb);
    const buf = screen.buffer;
    expect(buf.chars[0]).toBe('b');
    expect(buf.fg[0]).toBe(FG.red);
    expect(buf.fg[2]).toBe(FG.red);
    expect(buf.chars[80]).toBe('o'); // 第二行
    expect(buf.fg[80]).toBe(0);
  });

  it('CJK 宽字符行：续列格 fg 同为行 fg（不出现半截变色）', () => {
    const { screen } = makeScreen();
    const sb = new Scrollback([{ text: '中文', fg: FG.yellow }], 79);
    renderScrollback(screen, sb);
    const buf = screen.buffer;
    expect(buf.chars[0]).toBe('中');
    expect(buf.fg[0]).toBe(FG.yellow);
    expect(buf.fg[1]).toBe(FG.yellow); // 续列格
    expect(buf.fg[2]).toBe(FG.yellow); // 第二个宽字符
  });
});

describe('scrollback 性能冒烟（宽松阈值防 flaky）', () => {
  it('10k 行初始 wrap < 200ms（预算 50ms，此为报警级断言）', () => {
    const lines = generateLines(10000, 42);
    const sb = new Scrollback(lines, 80);
    const t0 = performance.now();
    const total = sb.totalRows; // 强制全量 wrap + 前缀和
    const ms = performance.now() - t0;
    expect(total).toBeGreaterThan(10000); // 长行断行后总物理行更多
    expect(ms).toBeLessThan(200);
  });

  it('确定性生成器：同 seed 输出一致', () => {
    expect(generateLines(50, 7)).toEqual(generateLines(50, 7));
    expect(generateLines(50, 7)).not.toEqual(generateLines(50, 8));
  });

  it('100 行批量 append < 50ms（前缀和增量，不重算全量）', () => {
    const lines = generateLines(1000, 42);
    const sb = new Scrollback(lines, 80);
    expect(sb.totalRows).toBeGreaterThan(0); // 先构建前缀
    const batch = Array.from({ length: 100 }, (_, i) => `append-bench-${i}-中文测试`);
    const t0 = performance.now();
    sb.appendLines(batch);
    const ms = performance.now() - t0;
    expect(sb.lineCount).toBe(1100);
    expect(ms).toBeLessThan(50);
  });

  it('10k 行全量 wrap 后单帧渲染 < 50ms', () => {
    const out = new MemOut();
    const screen = new Screen(out, 80, 24);
    screen.start();
    out.clear();
    const sb = new Scrollback(generateLines(10000, 42), 79);
    expect(sb.totalRows).toBeGreaterThan(0);
    const t0 = performance.now();
    renderScrollback(screen, sb);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(50);
  });
});
