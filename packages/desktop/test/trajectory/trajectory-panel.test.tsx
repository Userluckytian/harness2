// @vitest-environment jsdom
// 轨迹面板呈现层验收（D-41 / D-42 / D-43 / D-44 / D-45 / D-47）：
// 纯逻辑已由 projection/overview/inspector/virtual-window 各自覆盖，本文件证明**接进 DOM 后**的形态与交互：
//   记录表：粗分割线 = 轮次边界、行内紧凑标记 = 步骤、嵌套层级来自真实 parentCallId；
//   时间概览：TTFT/解码两段（无观测则单段且标注未观测）；
//   概览交互：悬停 500ms 出详情、拖选过滤、滚轮缩放、右键清除、放大后右键平移；
//   检查器：选中记录就地展开（token/耗时/输入/输出/附件），分割线不可选；
//   虚拟化：初始只挂尾部窗口、ARIA 行索引用全局下标；
//   诚实性：进行中的行 Time 列留空、Between turns 独立区段。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { projectTrajectory } from '../../src/renderer/trajectory/projection.js';
import { TrajectoryPanel } from '../../src/renderer/trajectory/trajectory-panel.js';
import {
  betweenTurnsFixture,
  conversationFixture,
  firstOutputObservation,
  manyRowsFixture,
  nestedToolFixture,
  runningFixture,
} from './fixtures.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const rowsOf = (
  events: ReturnType<typeof conversationFixture>,
  opts: { firstOutput?: boolean; running?: boolean } = {},
) =>
  projectTrajectory({
    events,
    sessionId: 's1',
    ...(opts.firstOutput === true ? { firstOutputAtMs: firstOutputObservation() } : {}),
    ...(opts.running === true ? { running: true } : {}),
  });

describe('D-41：记录表按轮次组织（粗分割线 = 轮次边界，行内标记 = 步骤）', () => {
  it('两轮 → 两条粗分割线 + 步骤行；分割线带轮次标签与真实耗时', () => {
    render(<TrajectoryPanel model={rowsOf(conversationFixture())} />);

    const boundaries = document.querySelectorAll('[data-row-kind="turn-boundary"]');
    expect(boundaries.length).toBe(2);
    expect(boundaries[0]?.querySelector('.trajectory-turn-divider')).not.toBeNull(); // 粗分割线
    expect(boundaries[0]?.textContent).toContain('Turn 1');
    expect(boundaries[1]?.textContent).toContain('Turn 2');

    const steps = document.querySelectorAll('[data-row-kind="step"]');
    expect(steps.length).toBeGreaterThanOrEqual(4); // 用户/助手/工具
    // 行内紧凑标记 = #N + 角色徽标
    const first = steps[0];
    expect(first?.querySelector('.trajectory-step-marker')?.textContent).toMatch(/^#\d+$/);
    expect(first?.querySelector('.trajectory-role-badge')?.textContent).toBe('用户');
    const roles = [...steps].map((s) => s.getAttribute('data-role'));
    expect(roles).toContain('assistant');
    expect(roles).toContain('tool');
  });

  it('嵌套子工具的缩进层级来自真实 parentCallId（无引用不发明层级）', () => {
    render(<TrajectoryPanel model={rowsOf(nestedToolFixture())} />);
    const depths = [...document.querySelectorAll('[data-row-kind="step"]')].map((s) => s.getAttribute('data-depth'));
    expect(depths).toContain('1'); // c2 的 parentCallId 指向 c1
    const nested = [...document.querySelectorAll('[data-row-kind="step"]')].find(
      (s) => s.getAttribute('data-depth') === '1',
    );
    expect(nested?.querySelector('.trajectory-role-badge')?.textContent).toContain('子工具');
  });

  it('Between turns：独立压缩请求成独立区段（标题 + 条数），不与轮次混排', () => {
    render(<TrajectoryPanel model={rowsOf(betweenTurnsFixture())} />);
    const boundary = document.querySelector('[data-row-kind="between-turns-boundary"]');
    expect(boundary?.textContent).toContain('Between turns');
    expect(screen.getByTestId('trajectory-between-note').textContent).toContain('1 条独立压缩请求');
    const entry = document.querySelector('[data-row-kind="between-turns"]');
    expect(entry?.textContent).toContain('前情摘要');
  });
});

describe('D-42：时间概览按真实开始时间投影，助手条区分 TTFT 与解码', () => {
  it('有首 token 观测 → 助手条拆成 TTFT/解码两段，数值来自真实观测', () => {
    render(<TrajectoryPanel model={rowsOf(conversationFixture(), { firstOutput: true })} />);

    const assistant = document.querySelector('[data-segment-kind="assistant"]');
    expect(assistant?.getAttribute('data-split')).toBe('ttft-decode');
    expect(assistant?.getAttribute('data-ttft-ms')).toBe('100'); // 300 - 200
    expect(assistant?.getAttribute('data-decode-ms')).toBe('900'); // 1200 - 300
    expect(within(assistant as HTMLElement).getByTestId('trajectory-overview-ttft')).toBeTruthy();
    expect(within(assistant as HTMLElement).getByTestId('trajectory-overview-decode')).toBeTruthy();
  });

  it('无观测 → 单段且明确未观测（不估算 Split）', () => {
    render(<TrajectoryPanel model={rowsOf(conversationFixture())} />);
    const assistant = document.querySelector('[data-segment-kind="assistant"]');
    expect(assistant?.getAttribute('data-split')).toBe('single');
    expect(assistant?.getAttribute('data-ttft-ms')).toBe('');
    expect(assistant?.getAttribute('aria-label')).toContain('TTFT 未观测');
  });
});

describe('D-43：概览交互（悬停 500ms / 拖选 / 缩放 / 平移 / 右键清除）', () => {
  const renderPanel = () => render(<TrajectoryPanel model={rowsOf(conversationFixture(), { firstOutput: true })} />);

  it('悬停段 499ms 无详情、500ms 出详情（详情含 TTFT/解码）', () => {
    vi.useFakeTimers();
    renderPanel();
    const bar = document.querySelector('[data-segment-kind="assistant"]') as HTMLElement;

    act(() => {
      fireEvent.mouseEnter(bar);
    });
    expect(bar.className).toContain('is-hovered'); // 高亮立即
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(screen.queryByTestId('trajectory-overview-detail')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const detail = screen.getByTestId('trajectory-overview-detail');
    expect(detail.textContent).toContain('开始');
    expect(detail.textContent).toContain('TTFT 100 ms');
    expect(detail.textContent).toContain('解码 900 ms');
  });

  it('滚轮缩小/放大以指针为锚点；右键清除回到全量', () => {
    renderPanel();
    const overview = screen.getByTestId('trajectory-overview');
    const track = screen.getByTestId('trajectory-overview-track');
    expect(overview.getAttribute('data-zoom')).toBe('1');

    fireEvent.wheel(track, { deltaY: -120, clientX: 300 });
    expect(Number(overview.getAttribute('data-zoom'))).toBeGreaterThan(1);
    expect(overview.getAttribute('data-zoomed')).toBe('true');

    fireEvent.contextMenu(track);
    expect(overview.getAttribute('data-zoom')).toBe('1');
    expect(overview.getAttribute('data-pan-ms')).toBe('0');
  });

  it('拖选区间 → 位图过滤与行过滤同时生效（并如实说明被排除的无时间记录）', () => {
    renderPanel();
    const track = screen.getByTestId('trajectory-overview-track');
    const totalRows = Number(screen.getByTestId('trajectory-records').getAttribute('data-row-total'));

    fireEvent.mouseDown(track, { button: 0, clientX: 100 });
    fireEvent.mouseMove(track, { buttons: 1, clientX: 400 });
    fireEvent.mouseUp(track, { clientX: 400 });

    const overview = screen.getByTestId('trajectory-overview');
    expect(overview.getAttribute('data-selection-start')).not.toBe('');
    expect(screen.getByTestId('trajectory-overview-selection')).toBeTruthy();

    const note = screen.getByTestId('trajectory-filter-note');
    expect(note.textContent).toContain('已按区间过滤');
    expect(Number(screen.getByTestId('trajectory-records').getAttribute('data-row-total'))).toBeLessThanOrEqual(
      totalRows,
    );
  });

  it('放大后右键拖动 = 平移（不触发清除）', () => {
    renderPanel();
    const overview = screen.getByTestId('trajectory-overview');
    const track = screen.getByTestId('trajectory-overview-track');
    fireEvent.wheel(track, { deltaY: -120, clientX: 300 });

    fireEvent.mouseDown(track, { button: 2, clientX: 400 });
    fireEvent.mouseMove(track, { buttons: 2, clientX: 300 });
    fireEvent.mouseUp(track, { button: 2, clientX: 300 });

    expect(Number(overview.getAttribute('data-pan-ms'))).not.toBe(0); // 内容被平移
    expect(Number(overview.getAttribute('data-zoom'))).toBeGreaterThan(1); // 未被清除
  });

  it('点在轨道空白处（未拖动）= 单击 → 清除区间', () => {
    renderPanel();
    const track = screen.getByTestId('trajectory-overview-track');
    fireEvent.mouseDown(track, { button: 0, clientX: 100 });
    fireEvent.mouseMove(track, { buttons: 1, clientX: 400 });
    fireEvent.mouseUp(track, { clientX: 400 });
    expect(screen.getByTestId('trajectory-overview-selection')).toBeTruthy();

    fireEvent.mouseDown(track, { button: 0, clientX: 120 });
    fireEvent.mouseUp(track, { clientX: 120 });
    expect(screen.queryByTestId('trajectory-overview-selection')).toBeNull();
  });
});

describe('D-44：选中记录开局部检查器（分割线不可选）', () => {
  it('点工具步 → 检查器就地展开：token/耗时/输入/输出与附件摘要', () => {
    render(<TrajectoryPanel model={rowsOf(conversationFixture())} />);
    expect(screen.getByTestId('trajectory-inspector').getAttribute('data-empty')).toBe('true');

    const toolRow = document.querySelector('[data-row-kind="step"][data-role="tool"]') as HTMLElement;
    fireEvent.click(toolRow);

    const inspector = screen.getByTestId('trajectory-inspector');
    expect(inspector.getAttribute('data-empty')).toBe('false');
    expect(inspector.getAttribute('data-role')).toBe('tool');
    expect(screen.getByTestId('trajectory-inspector-input').textContent).toContain('ls');
    expect(screen.getByTestId('trajectory-inspector-output').textContent).toContain('file.txt');
    // 缺数据如实「无」/「未记录」，不显示 0 或空行
    expect(screen.getByTestId('trajectory-inspector-attachments').textContent).toContain('无');
    // 选中态可见
    expect(document.querySelector('[data-row-kind="step"][data-selected="true"]')).not.toBeNull();
  });

  it('点轮次分割线不改变选中（分割线不是可选记录）', () => {
    render(<TrajectoryPanel model={rowsOf(conversationFixture())} />);
    const toolRow = document.querySelector('[data-row-kind="step"][data-role="tool"]') as HTMLElement;
    fireEvent.click(toolRow);
    const selectedKey = screen.getByTestId('trajectory-inspector').getAttribute('data-inspector-key');

    const boundary = document.querySelector('[data-row-kind="turn-boundary"]') as HTMLElement;
    fireEvent.click(boundary);
    expect(screen.getByTestId('trajectory-inspector').getAttribute('data-inspector-key')).toBe(selectedKey);
  });

  it('关闭按钮收起检查器（回到空态）', () => {
    render(<TrajectoryPanel model={rowsOf(conversationFixture())} />);
    fireEvent.click(document.querySelector('[data-row-kind="step"][data-role="tool"]') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: '关闭检查器' }));
    expect(screen.getByTestId('trajectory-inspector').getAttribute('data-empty')).toBe('true');
  });
});

describe('D-45：虚拟化（尾部 50 / 按需补页 / 全局 ARIA 索引）', () => {
  it('长会话只挂尾部窗口（不是从头挂），ARIA 行数 = 全量', () => {
    const model = rowsOf(manyRowsFixture(200));
    render(<TrajectoryPanel model={model} />);
    const grid = screen.getByTestId('trajectory-records');

    const total = Number(grid.getAttribute('data-row-total'));
    const mountedStart = Number(grid.getAttribute('data-mounted-start'));
    const mountedEnd = Number(grid.getAttribute('data-mounted-end'));
    expect(total).toBeGreaterThan(150);
    expect(mountedEnd - mountedStart).toBeLessThan(total); // 没有全量挂载
    expect(mountedStart).toBeGreaterThan(0); // 初始落在尾部，不是头部
    expect(grid.getAttribute('aria-rowcount')).toBe(String(total)); // ARIA 行数 = 全量记录（语义索引稳定）
    expect(document.querySelectorAll('[role="row"]').length).toBe(mountedEnd - mountedStart);
  });

  it('滚动到顶部：补页扩窗（物化起点前移），ARIA 语义索引不变', () => {
    const model = rowsOf(manyRowsFixture(200));
    render(<TrajectoryPanel model={model} />);
    const grid = screen.getByTestId('trajectory-records');
    const scroller = screen.getByTestId('trajectory-records-scroll');
    const firstKeyBefore = (document.querySelector('[role="row"]') as HTMLElement).getAttribute('data-row-index');

    act(() => {
      scroller.scrollTop = 0;
      fireEvent.scroll(scroller);
    });

    expect(Number(grid.getAttribute('data-mounted-start'))).toBe(0);
    // 同一条记录的全局下标恒定（语义索引不随窗口滑动而变）
    const rowAtZero = document.querySelector('[role="row"][data-row-index="0"]');
    expect(rowAtZero).not.toBeNull();
    expect(firstKeyBefore).not.toBeNull();
  });
});

describe('D-45：虚拟化（真渲染窗口：尾部 50 / 只挂可见+缓冲 / 语义索引稳定）', () => {
  // manyRowsFixture(200) → 1 条轮次分割线 + 1 条用户行 + 200 条工具行 = 202 行
  const TOTAL = 202;
  const ROW_HEIGHT = 28;
  const VIEWPORT = 480;
  const renderTable = () =>
    render(
      <TrajectoryPanel
        model={rowsOf(manyRowsFixture(200))}
        rowHeightPx={ROW_HEIGHT}
        viewportHeightPx={VIEWPORT}
        overscan={8}
        pageSize={50}
      />,
    );

  it('P2-7 高视口（4K 全屏）：挂载即按实测视口补足物化窗口，可见区顶部无未物化空白', () => {
    // 视口 2160px ≈ 78 行 > 尾部 50 行：固定窗口会让顶部出现未物化留白（且无余量可滚来自愈）
    const VIEWPORT_4K = 2160;
    render(
      <TrajectoryPanel
        model={rowsOf(manyRowsFixture(200))}
        rowHeightPx={ROW_HEIGHT}
        viewportHeightPx={VIEWPORT_4K}
        overscan={8}
        pageSize={50}
      />,
    );
    const grid = screen.getByTestId('trajectory-records');
    const renderStart = Number(grid.getAttribute('data-mounted-start'));
    const materializedStart = Number(grid.getAttribute('data-materialized-start'));
    expect(Number(grid.getAttribute('data-row-total'))).toBe(TOTAL);
    // 初始即补页（不是固定 0 页 50 行）
    expect(Number(grid.getAttribute('data-loaded-pages'))).toBeGreaterThanOrEqual(1);
    // 物化区覆盖可见窗口（含 overscan）的顶部：materializedStart <= renderStart ⇒ 顶部留白为 0
    expect(materializedStart).toBeLessThanOrEqual(renderStart);
    // 仍只挂窗口（不是全量）
    const domRows = document.querySelectorAll('[role="row"]').length;
    expect(domRows).toBe(Number(grid.getAttribute('data-mounted-end')) - renderStart);
    expect(domRows).toBeLessThan(TOTAL);
  });

  it('初始已物化区 = 末尾 50 行；DOM 只挂可见窗口 + 缓冲（远小于总行数）', () => {
    renderTable();
    const grid = screen.getByTestId('trajectory-records');
    expect(Number(grid.getAttribute('data-row-total'))).toBe(TOTAL);
    expect(Number(grid.getAttribute('data-materialized-start'))).toBe(TOTAL - 50); // 尾部 50
    expect(Number(grid.getAttribute('data-mounted-end'))).toBe(TOTAL);
    expect(Number(grid.getAttribute('data-loaded-pages'))).toBe(0);

    const domRows = document.querySelectorAll('[role="row"]');
    const renderStart = Number(grid.getAttribute('data-mounted-start'));
    const renderEnd = Number(grid.getAttribute('data-mounted-end'));
    expect(domRows.length).toBe(renderEnd - renderStart); // DOM 行 = 计算窗口，不多不少
    expect(domRows.length).toBeLessThan(TOTAL); // 不是全量挂载
    const visibleRows = Math.ceil(VIEWPORT / ROW_HEIGHT); // 18
    expect(domRows.length).toBeLessThanOrEqual(visibleRows + 2 * 8); // 只挂可见 + 缓冲
    // aria-rowcount = 全量语义行数（不是已挂数目）
    expect(grid.getAttribute('aria-rowcount')).toBe(String(TOTAL));
  });

  it('行键来自模型且唯一；补页前后同一条记录的全局索引/ARIA 索引不变', () => {
    renderTable();
    const grid = screen.getByTestId('trajectory-records');
    const scroller = screen.getByTestId('trajectory-records-scroll');

    const keys = [...document.querySelectorAll('[role="row"]')].map((n) => n.getAttribute('data-row-key'));
    expect(new Set(keys).size).toBe(keys.length); // 无重复键（错位会静默渲染错行）

    // 取本轮窗口内的一条记录（底部窗口 = [176,202)）
    const sample = document.querySelector('[role="row"][data-row-index="180"]') as HTMLElement;
    expect(sample).not.toBeNull();
    const sampleKey = sample.getAttribute('data-row-key');
    const ariaBefore = sample.getAttribute('aria-rowindex');
    expect(ariaBefore).toBe('181'); // 全局下标 + 1

    // 上滚若干行：窗口滑动但该记录仍在挂载区间内 → 索引必须原样
    act(() => {
      scroller.scrollTop = 4616; // 视口顶 ≈ 第 164 行，渲染窗口 ≈ [156,190)
      fireEvent.scroll(scroller);
    });
    expect(Number(grid.getAttribute('data-mounted-start'))).toBe(156);

    const stillMounted = document.querySelector(`[role="row"][data-row-key="${sampleKey}"]`) as HTMLElement;
    expect(stillMounted).not.toBeNull();
    expect(stillMounted.getAttribute('data-row-index')).toBe('180');
    expect(stillMounted.getAttribute('aria-rowindex')).toBe(ariaBefore);
  });
});

describe('D-47：进行中不虚构耗时 + 无时间戳不投影', () => {
  it('进行中的轮次：Time 列留空、标「进行中」，步骤耗时也不显示', () => {
    const model = rowsOf(runningFixture(), { running: true });
    render(<TrajectoryPanel model={model} />);

    const boundary = document.querySelector('[data-row-kind="turn-boundary"]') as HTMLElement;
    const time = boundary.querySelector('.trajectory-turn-time') as HTMLElement;
    expect(time.textContent).toBe(''); // 不虚构耗时
    expect(time.getAttribute('data-missing')).toBe('true');
    expect(boundary.textContent).toContain('进行中');

    const stepTime = document.querySelector('.trajectory-step-time') as HTMLElement;
    expect(stepTime.textContent).toBe('');
    expect(stepTime.getAttribute('data-missing')).toBe('true');
    expect(screen.getByTestId('trajectory-panel').getAttribute('data-running')).toBe('true');
  });

  it('空模型：明确说明无可投影事件，不画空壳', () => {
    render(<TrajectoryPanel model={rowsOf([])} />);
    const panel = screen.getByTestId('trajectory-panel');
    expect(panel.getAttribute('data-empty')).toBe('true');
    expect(panel.textContent).toContain('还没有可投影的事件');
  });

  it('进行中的工具步骤：状态 running、Time 列留空（不把「现在-开始」当耗时）', () => {
    const model = rowsOf(runningFixture(), { running: true });
    render(<TrajectoryPanel model={model} />);

    const toolRow = document.querySelector('[data-row-kind="step"][data-role="tool"]') as HTMLElement;
    expect(toolRow.getAttribute('data-state')).toBe('running');
    const time = toolRow.querySelector('.trajectory-step-time') as HTMLElement;
    expect(time.textContent).toBe(''); // 结果未到 = 耗时未知，留空而非猜
    expect(time.getAttribute('data-missing')).toBe('true');
    // 轮次分割线同样不虚构（会话在跑且无 turn-end）
    const boundary = document.querySelector('[data-row-kind="turn-boundary"]') as HTMLElement;
    expect((boundary.querySelector('.trajectory-turn-time') as HTMLElement).getAttribute('data-missing')).toBe('true');
  });
});
