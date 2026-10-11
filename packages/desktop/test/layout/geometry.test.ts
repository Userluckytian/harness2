// 三栅几何与让步链纯函数测试（Z-05 / Z-06 / Z-12 / Z-15 / §8；让步链沿用 D-12）。
// 表驱动：视口宽 × 各栏偏好 → 各栏实际宽度 + 空间不足报告；并锁死「不改偏好宽度」。
import { describe, expect, it } from 'vitest';
import {
  AUTO_COLLAPSE_RESIZE_IDLE_MS,
  AUTO_COLLAPSE_RIGHTBAR_CONVERSATION_WIDTH,
  AUTO_COLLAPSE_SIDEBAR_CONVERSATION_WIDTH,
  CONVERSATION_DEFAULT_RATIO,
  CONVERSATION_MIN_RATIO,
  MAIN_MIN_WIDTH,
  RIGHTBAR_DEFAULT_RATIO,
  RIGHTBAR_EXPANDED_RATIO,
  RIGHTBAR_MAX_RATIO,
  RIGHTBAR_MIN_PX,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH_RATIO,
  SIDEBAR_MIN_WIDTH,
  TERMINAL_DEFAULT_RATIO,
  TERMINAL_EXPANDED_RATIO,
  TERMINAL_MAX_RATIO,
  TERMINAL_MIN_PX,
  clampTerminalHeight,
  clampWidth,
  computeFrameGeometry,
  defaultRightbarWidth,
  resolveAutoCollapse,
  resolveContentWidth,
  resolveTerminalHeight,
  shouldAutoCollapseRightbar,
  shouldAutoCollapseSidebar,
  sidebarMaxWidth,
  terminalMaxHeight,
  type FrameGeometryInput,
} from '../../src/renderer/layout/geometry.js';

function input(over: Partial<FrameGeometryInput> = {}): FrameGeometryInput {
  return {
    viewportWidth: 1400,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    sidebarCollapsed: false,
    rightbarOpen: false,
    rightbarWidth: null,
    ...over,
  };
}

describe('几何常量（Z-05 / Z-06 / Z-12 / §8）', () => {
  it('侧栏 264～容器 50%（默认 264）、折叠 4、会话列保底 320', () => {
    expect([SIDEBAR_MIN_WIDTH, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH_RATIO]).toEqual([264, 264, 0.5]);
    expect(SIDEBAR_COLLAPSED_WIDTH).toBe(4);
    expect(MAIN_MIN_WIDTH).toBe(320);
  });

  it('右栏 0 / 240 / 65%，展开 45%；会话列 52% / 35%；终端 0 / 140 / 50%，展开 30%', () => {
    expect([RIGHTBAR_DEFAULT_RATIO, RIGHTBAR_EXPANDED_RATIO, RIGHTBAR_MIN_PX, RIGHTBAR_MAX_RATIO]).toEqual([
      0, 0.45, 240, 0.65,
    ]);
    expect([CONVERSATION_DEFAULT_RATIO, CONVERSATION_MIN_RATIO]).toEqual([0.52, 0.35]);
    expect([TERMINAL_DEFAULT_RATIO, TERMINAL_EXPANDED_RATIO, TERMINAL_MIN_PX, TERMINAL_MAX_RATIO]).toEqual([
      0, 0.3, 140, 0.5,
    ]);
  });

  it('自动收起阈值按会话列宽：右栏 480 / 左栏 360；resize idle 300ms', () => {
    expect(AUTO_COLLAPSE_RIGHTBAR_CONVERSATION_WIDTH).toBe(480);
    expect(AUTO_COLLAPSE_SIDEBAR_CONVERSATION_WIDTH).toBe(360);
    expect(AUTO_COLLAPSE_RESIZE_IDLE_MS).toBe(300);
  });

  it('sidebarMaxWidth = 容器 × 0.5（容器未知/非正 → 只受下界约束）', () => {
    expect(sidebarMaxWidth(1400)).toBe(700);
    expect(sidebarMaxWidth(1000)).toBe(500);
    expect(sidebarMaxWidth(400)).toBe(264); // 200 < 264 → 保底 264
    expect(sidebarMaxWidth(0)).toBe(Number.POSITIVE_INFINITY);
    expect(sidebarMaxWidth(Number.NaN)).toBe(Number.POSITIVE_INFINITY);
  });

  it('clampWidth：上下限钳制、四舍五入、NaN/Infinity 落到下界', () => {
    expect(clampWidth(100, 264, 420)).toBe(264);
    expect(clampWidth(999, 264, 420)).toBe(420);
    expect(clampWidth(300.6, 264, 420)).toBe(301);
    expect(clampWidth(Number.NaN, 264, 420)).toBe(264);
    expect(clampWidth(Number.POSITIVE_INFINITY, 264, 420)).toBe(420);
  });

  it('defaultRightbarWidth：首开取**内容区宽** 45%（Z2-03 / Z-12，分母 = 视口 − 左栏）', () => {
    expect(defaultRightbarWidth(1136)).toBe(511); // 1400 − 264
    expect(defaultRightbarWidth(1336)).toBe(601); // 1600 − 264
    expect(defaultRightbarWidth(780)).toBe(351); // 1200 − 420
    expect(defaultRightbarWidth(0)).toBe(0);
  });

  it('resolveContentWidth：内容区宽 = 视口 − 左栏（折叠 4px，钳制后）', () => {
    expect(resolveContentWidth(1400, 264, false)).toBe(1136);
    expect(resolveContentWidth(1400, 420, false)).toBe(980);
    expect(resolveContentWidth(1400, 264, true)).toBe(1396); // 折叠 → 4px
    expect(resolveContentWidth(1400, 9999, false)).toBe(700); // 左栏钳到 容器 50%
    expect(resolveContentWidth(0, 264, false)).toBe(0); // 视口未测：内容区不为负
  });

  it('终端高度：展开 = 主列高 30%，钳制在 [140, 主列高 50%]（Z-12 / §8）', () => {
    expect(resolveTerminalHeight(0)).toBe(TERMINAL_MIN_PX); // 未测量 → 最小高
    expect(resolveTerminalHeight(400)).toBe(140); // 120 < 140 → 抬到 140
    expect(resolveTerminalHeight(600)).toBe(180); // 180 在 [140, 300]
    expect(resolveTerminalHeight(1000)).toBe(300); // 300 在 [140, 500]
    expect(resolveTerminalHeight(200)).toBe(140); // 上限 100 < 下界 140 → 落 140
    expect(terminalMaxHeight(600)).toBe(300);
    expect(terminalMaxHeight(0)).toBe(0);
    expect(clampTerminalHeight(600, 999)).toBe(300);
    expect(clampTerminalHeight(600, 10)).toBe(140);
  });

  it('自动收起阈值判定：严格小于才触发；未测量 0 不误判', () => {
    expect(shouldAutoCollapseRightbar(479)).toBe(true);
    expect(shouldAutoCollapseRightbar(480)).toBe(false);
    expect(shouldAutoCollapseRightbar(0)).toBe(false);
    expect(shouldAutoCollapseSidebar(359)).toBe(true);
    expect(shouldAutoCollapseSidebar(360)).toBe(false);
    expect(shouldAutoCollapseSidebar(0)).toBe(false);
  });
});

describe('自动收起决策（Z-15：先右栏 < 480，后左栏 < 360）', () => {
  it('会话列过窄：右栏先收，会话列拿回右栏宽度后再判左栏', () => {
    // 400 < 480 → 收右栏；400 + 300 = 700 ≥ 360 → 左栏不收
    expect(
      resolveAutoCollapse({ conversationWidth: 400, rightbarOpen: true, rightbarWidth: 300, sidebarCollapsed: false }),
    ).toEqual({ collapseRightbar: true, collapseSidebar: false });
    // 右栏已关时，会话列 300 < 360 → 收左栏
    expect(
      resolveAutoCollapse({ conversationWidth: 300, rightbarOpen: false, rightbarWidth: 0, sidebarCollapsed: false }),
    ).toEqual({ collapseRightbar: false, collapseSidebar: true });
    // 收右栏后仍 300 < 360 → 左栏也收
    expect(
      resolveAutoCollapse({ conversationWidth: 300, rightbarOpen: true, rightbarWidth: 0, sidebarCollapsed: false }),
    ).toEqual({ collapseRightbar: true, collapseSidebar: true });
  });

  it('空间充足 / 未测量 / 已折叠：不产生任何收起', () => {
    expect(
      resolveAutoCollapse({ conversationWidth: 900, rightbarOpen: true, rightbarWidth: 300, sidebarCollapsed: false }),
    ).toEqual({ collapseRightbar: false, collapseSidebar: false });
    expect(
      resolveAutoCollapse({ conversationWidth: 0, rightbarOpen: true, rightbarWidth: 0, sidebarCollapsed: false }),
    ).toEqual({ collapseRightbar: false, collapseSidebar: false });
    // 已折叠的侧栏不会被重复判定为「需要收起」
    expect(
      resolveAutoCollapse({ conversationWidth: 200, rightbarOpen: false, rightbarWidth: 0, sidebarCollapsed: true }),
    ).toEqual({ collapseRightbar: false, collapseSidebar: false });
  });
});

describe('让步链（D-12，表驱动 + 上游 columns.ts:50-57 次序）', () => {
  const cases: Array<{
    name: string;
    input: FrameGeometryInput;
    expect: {
      sidebar: number;
      main: number;
      rightbar: number;
      shrunk: boolean;
      compressed: boolean;
      shortage: number;
      canShow: boolean;
    };
  }> = [
    {
      name: '空间充足：右栏按偏好 45% 展开，三栏并列，无让步',
      input: input({ viewportWidth: 1400, rightbarOpen: true, rightbarWidth: 630 }),
      expect: { sidebar: 264, main: 506, rightbar: 630, shrunk: false, compressed: false, shortage: 0, canShow: true },
    },
    {
      name: '首开（偏好未定）：右栏取**内容区宽** 45%（1600−264=1336 → 601）',
      input: input({ viewportWidth: 1600, rightbarOpen: true, rightbarWidth: null }),
      expect: { sidebar: 264, main: 735, rightbar: 601, shrunk: false, compressed: false, shortage: 0, canShow: true },
    },
    {
      name: '第 1 步：有轨道时先把右栏缩到 available（1000−264−320=416）→ 会话列回到保底 320',
      input: input({ viewportWidth: 1000, rightbarOpen: true, rightbarWidth: 450 }),
      expect: { sidebar: 264, main: 320, rightbar: 416, shrunk: true, compressed: false, shortage: 0, canShow: true },
    },
    {
      // P0-1 关键口径（上游 columns.ts:52-53）：available < 240 → 右栏宽度归零（轨道摘除），
      // 而不是把右栏按在 240 同时把会话列压到更窄。
      name: '第 2 步：available < 240（800−264−320=216）→ 右栏归零、会话列拿到全部剩余 536（不压中栏）',
      input: input({ viewportWidth: 800, rightbarOpen: true, rightbarWidth: 405 }),
      expect: { sidebar: 264, main: 536, rightbar: 0, shrunk: false, compressed: false, shortage: 0, canShow: false },
    },
    {
      name: '右栏未开而视口过窄：没有可让位的对象，shortageOwner 为空（只压中栏）',
      input: input({ viewportWidth: 560, rightbarOpen: false }),
      expect: { sidebar: 264, main: 296, rightbar: 0, shrunk: false, compressed: true, shortage: 24, canShow: false },
    },
    {
      name: '侧栏折叠：4px（Z-06，无图标轨道）',
      input: input({ viewportWidth: 100, sidebarCollapsed: true }),
      expect: { sidebar: 4, main: 96, rightbar: 0, shrunk: false, compressed: true, shortage: 224, canShow: false },
    },
    {
      name: '极窄 + 右栏开：轨道摘除（右栏 0，不是顶到 240 再压中栏），会话列 496 无不足',
      input: input({ viewportWidth: 500, sidebarCollapsed: true, rightbarOpen: true, rightbarWidth: 400 }),
      expect: { sidebar: 4, main: 496, rightbar: 0, shrunk: false, compressed: false, shortage: 0, canShow: false },
    },
    {
      name: '右栏偏好超过 内容区 65% 上限：先钳到上限（1136 × 0.65 = 738），上限 < available 816 → 不再压窄',
      input: input({ viewportWidth: 1400, rightbarOpen: true, rightbarWidth: 1300 }),
      expect: { sidebar: 264, main: 398, rightbar: 738, shrunk: false, compressed: false, shortage: 0, canShow: true },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const g = computeFrameGeometry(c.input);
      expect({ sidebar: g.sidebar, main: g.main, rightbar: g.rightbar }).toEqual({
        sidebar: c.expect.sidebar,
        main: c.expect.main,
        rightbar: c.expect.rightbar,
      });
      expect({
        shrunk: g.rightbarShrunk,
        compressed: g.mainCompressed,
        shortage: g.shortage,
        canShow: g.rightbarCanShow,
      }).toEqual({
        shrunk: c.expect.shrunk,
        compressed: c.expect.compressed,
        shortage: c.expect.shortage,
        canShow: c.expect.canShow,
      });
    });
  }

  // 让步下界（240）边界对：available 恰好 240 → 右栏 240（有轨道）；239 → 轨道摘除（右栏 0）。
  // 侧栏折叠 4px：内容区 = viewport − 4，available = 内容区 − 320 = viewport − 324。
  it.each([
    [564, 240, true],
    [563, 0, false],
  ] as const)('在场边界：视口 %ipx（4px 折叠侧栏）→ 右栏 %ipx、canShow %s', (viewportWidth, rightbar, canShow) => {
    const g = computeFrameGeometry(
      input({ viewportWidth, sidebarCollapsed: true, rightbarOpen: true, rightbarWidth: null }),
    );
    expect(g.rightbarCanShow).toBe(canShow);
    // 有轨道时右栏取 min(available, 内容区 45%)；available 恰 240 时被 available 卡住
    expect(g.rightbar).toBe(canShow ? Math.min(240, defaultRightbarWidth(viewportWidth - 4)) : 0);
    expect(g.main).toBe(viewportWidth - 4 - g.rightbar);
    expect(g.shortage).toBe(0);
  });

  it('只有没有右栏轨道时中栏才可能低于 320（上游注释：only without that track…）', () => {
    // 有轨道：main 恒 >= 320
    for (const viewportWidth of [1200, 1000, 900, 760]) {
      const g = computeFrameGeometry(input({ viewportWidth, rightbarOpen: true, rightbarWidth: 900 }));
      expect(g.main).toBeGreaterThanOrEqual(MAIN_MIN_WIDTH);
      expect(g.mainCompressed).toBe(false);
    }
    // 无轨道（available < 240）：右栏 0，中栏可能被压
    const dropped = computeFrameGeometry(input({ viewportWidth: 500, rightbarOpen: true, rightbarWidth: 405 }));
    expect(dropped.rightbar).toBe(0);
    expect(dropped.main).toBe(236);
    expect(dropped.mainCompressed).toBe(true);
  });

  it('报告口径（D-12）：右栏开但已无轨道 → shortageOwner = rightbar（报告交给占用方，由 canShow=false 触发自关）', () => {
    const dropped = computeFrameGeometry(input({ viewportWidth: 560, rightbarOpen: true, rightbarWidth: 400 }));
    expect(dropped.rightbarCanShow).toBe(false);
    expect({ main: dropped.main, shortage: dropped.shortage, owner: dropped.shortageOwner }).toEqual({
      main: 296,
      shortage: 24,
      owner: 'rightbar',
    });
    const noRightbar = computeFrameGeometry(input({ viewportWidth: 560 }));
    expect(noRightbar.shortageOwner).toBeNull();
    const roomy = computeFrameGeometry(input({ viewportWidth: 1920, rightbarOpen: true, rightbarWidth: 864 }));
    expect(roomy.shortage).toBe(0);
    expect(roomy.shortageOwner).toBeNull();
  });

  it('不改偏好宽度：几何计算前后入参对象逐字不变（D-12「不修改用户偏好宽度」）', () => {
    const before: FrameGeometryInput = input({ viewportWidth: 800, rightbarOpen: true, rightbarWidth: 405 });
    const snapshot = { ...before };
    computeFrameGeometry(before);
    expect(before).toEqual(snapshot);
    expect(before.rightbarWidth).toBe(405); // 让步只是渲染几何：偏好像素宽度原样保留
  });

  it('全屏形态：右栏覆盖窗口（中栏/侧栏不参与挤压），无让步、无不足', () => {
    const g = computeFrameGeometry(
      input({ viewportWidth: 1400, rightbarOpen: true, rightbarFullscreen: true, rightbarWidth: 630 }),
    );
    expect(g.rightbar).toBe(1400);
    expect(g.main).toBe(0);
    expect(g.shortage).toBe(0);
    expect(g.rightbarShrunk).toBe(false);
  });

  it('belowAutoCollapse 透出「会话列宽 < 左栏自动收起阈值 360」', () => {
    expect(computeFrameGeometry(input({ viewportWidth: 600 })).belowAutoCollapse).toBe(true); // main = 336
    expect(computeFrameGeometry(input({ viewportWidth: 700 })).belowAutoCollapse).toBe(false); // main = 436
  });

  // Z2-03 核心口径：右栏展开宽 = **内容区宽** × 0.45（分母 = 视口 − 左栏），不是视口 × 0.45
  it.each([
    [1400, 264, 511], // 内容区 1136 → 511
    [1600, 264, 601], // 内容区 1336 → 601
    [1200, 420, 351], // 内容区 780 → 351
    [1920, 264, 745], // 内容区 1656 → 745
  ] as const)('视口 %ipx / 左栏 %ipx：右栏首开 %ipx = 内容区 × 0.45', (viewportWidth, sidebarWidth, rightbar) => {
    const g = computeFrameGeometry(input({ viewportWidth, sidebarWidth, rightbarOpen: true, rightbarWidth: null }));
    expect(g.contentWidth).toBe(viewportWidth - sidebarWidth);
    expect(g.rightbar).toBe(rightbar);
    expect(g.rightbar).toBe(defaultRightbarWidth(g.contentWidth));
    // 右栏打开时会话列 = 内容区 − 右栏（右栏拿 45%，会话列拿剩余）
    expect(g.main).toBe(g.contentWidth - g.rightbar);
  });
});

describe('侧栏宽度钳制（Z-05：264～容器 50%）', () => {
  it('偏好越界在几何层被钳制；折叠时内容仍保留展开宽度（sidebarExpandedWidth）', () => {
    expect(computeFrameGeometry(input({ sidebarWidth: 100 })).sidebar).toBe(264);
    expect(computeFrameGeometry(input({ sidebarWidth: 900 })).sidebar).toBe(700); // 1400 × 0.5
    expect(computeFrameGeometry(input({ sidebarWidth: Number.NaN })).sidebar).toBe(264);
    const collapsed = computeFrameGeometry(input({ sidebarWidth: 300, sidebarCollapsed: true }));
    expect(collapsed.sidebar).toBe(4);
    expect(collapsed.sidebarExpandedWidth).toBe(300);
  });
});
