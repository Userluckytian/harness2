// 三栅几何与让步链纯函数测试（D-11 / D-12 / D-13）。
// 表驱动：视口宽 × 各栏偏好 → 各栏实际宽度 + 空间不足报告；并锁死「不改偏好宽度」。
import { describe, expect, it } from 'vitest';
import {
  clampWidth,
  computeFrameGeometry,
  defaultRightbarWidth,
  MAIN_MIN_WIDTH,
  RIGHTBAR_GIVE_MIN_WIDTH,
  RIGHTBAR_MAX_RATIO,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  shouldAutoCollapse,
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

describe('几何常量（D-11 / D-13）', () => {
  it('侧栏 264～420（默认 280）、轨道 56、中栏保底 400、右栏 45% / 上限 70% / 让步位 300', () => {
    expect([SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_DEFAULT_WIDTH]).toEqual([264, 420, 280]);
    expect(SIDEBAR_RAIL_WIDTH).toBe(56);
    expect(MAIN_MIN_WIDTH).toBe(400);
    expect(RIGHTBAR_GIVE_MIN_WIDTH).toBe(300);
    expect(RIGHTBAR_MAX_RATIO).toBe(0.7);
    expect(defaultRightbarWidth(1400)).toBe(630); // 45%
  });

  it('clampWidth：上下限钳制、四舍五入、NaN/Infinity 落到下界', () => {
    expect(clampWidth(100, 264, 420)).toBe(264);
    expect(clampWidth(999, 264, 420)).toBe(420);
    expect(clampWidth(300.6, 264, 420)).toBe(301);
    expect(clampWidth(Number.NaN, 264, 420)).toBe(264);
    expect(clampWidth(Number.POSITIVE_INFINITY, 264, 420)).toBe(420);
  });

  it('shouldAutoCollapse：< 1024px 收起，1024 及以上不收起（D-13）', () => {
    expect(shouldAutoCollapse(1023)).toBe(true);
    expect(shouldAutoCollapse(1024)).toBe(false);
    expect(shouldAutoCollapse(1920)).toBe(false);
    expect(shouldAutoCollapse(0)).toBe(false); // 视口未就绪：不误判
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
      expect: { sidebar: 280, main: 490, rightbar: 630, shrunk: false, compressed: false, shortage: 0, canShow: true },
    },
    {
      name: '首开（偏好未定）：右栏取视口 45%',
      input: input({ viewportWidth: 1600, rightbarOpen: true, rightbarWidth: null }),
      expect: { sidebar: 280, main: 600, rightbar: 720, shrunk: false, compressed: false, shortage: 0, canShow: true },
    },
    {
      name: '第 1 步：有轨道时先把右栏缩到 available（1000−280−400=320）→ 中栏回到保底 400',
      input: input({ viewportWidth: 1000, rightbarOpen: true, rightbarWidth: 450 }),
      expect: { sidebar: 280, main: 400, rightbar: 320, shrunk: true, compressed: false, shortage: 0, canShow: true },
    },
    {
      // P0-1 关键口径（上游 columns.ts:52-53）：available < 300 → 右栏宽度归零（轨道摘除），
      // 而不是把右栏按在 300 同时把中栏压到 320。
      name: '第 2 步：available < 300（900−280−400=220）→ 右栏归零、中栏拿到全部剩余 620（不压中栏）',
      input: input({ viewportWidth: 900, rightbarOpen: true, rightbarWidth: 405 }),
      expect: { sidebar: 280, main: 620, rightbar: 0, shrunk: false, compressed: false, shortage: 0, canShow: false },
    },
    {
      name: '右栏未开而视口过窄：没有可让位的对象，shortageOwner 为空（只压中栏）',
      input: input({ viewportWidth: 600, rightbarOpen: false }),
      expect: { sidebar: 280, main: 320, rightbar: 0, shrunk: false, compressed: true, shortage: 80, canShow: false },
    },
    {
      name: '侧栏收起：56px 轨道（极窄窗口也保留轨道，D-13）',
      input: input({ viewportWidth: 100, sidebarCollapsed: true }),
      expect: { sidebar: 56, main: 44, rightbar: 0, shrunk: false, compressed: true, shortage: 356, canShow: false },
    },
    {
      name: '极窄 + 右栏开：轨道摘除（右栏 0，不是顶到 300 再压中栏），中栏 444 无不足',
      input: input({ viewportWidth: 500, sidebarCollapsed: true, rightbarOpen: true, rightbarWidth: 400 }),
      expect: { sidebar: 56, main: 444, rightbar: 0, shrunk: false, compressed: false, shortage: 0, canShow: false },
    },
    {
      name: '右栏偏好超过 70% 上限：先钳到上限（1400 × 0.7 = 980），再由让步链缩到 available 720',
      input: input({ viewportWidth: 1400, rightbarOpen: true, rightbarWidth: 1300 }),
      expect: { sidebar: 280, main: 400, rightbar: 720, shrunk: true, compressed: false, shortage: 0, canShow: true },
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

  // 上游 app-frame.client.spec.tsx:296 `it.each([[756, 300, true], [755, 0, false]])` 的边界对：
  // available 恰好 300 → 右栏 300（有轨道）；299 → 轨道摘除（右栏 0）。
  it.each([
    [756, 300, true],
    [755, 0, false],
  ] as const)('在场边界：视口 %ipx（56px 轨道）→ 右栏 %ipx、canShow %s', (viewportWidth, rightbar, canShow) => {
    const g = computeFrameGeometry(
      input({ viewportWidth, sidebarCollapsed: true, rightbarOpen: true, rightbarWidth: null }),
    );
    expect(g.rightbar).toBe(rightbar);
    expect(g.rightbarCanShow).toBe(canShow);
    // 有轨道时中栏恰好保住 400；轨道摘除后中栏拿回全部剩余
    expect(g.main).toBe(viewportWidth - 56 - rightbar);
    expect(g.shortage).toBe(0);
  });

  it('只有没有右栏轨道时中栏才可能低于 400（上游注释：only without that track…）', () => {
    // 有轨道：main 恒 >= 400
    for (const viewportWidth of [1200, 1024, 900, 760]) {
      const g = computeFrameGeometry(input({ viewportWidth, rightbarOpen: true, rightbarWidth: 900 }));
      expect(g.main).toBeGreaterThanOrEqual(MAIN_MIN_WIDTH);
      expect(g.mainCompressed).toBe(false);
    }
    // 无轨道（available < 300）：右栏 0，中栏可能被压
    const dropped = computeFrameGeometry(input({ viewportWidth: 900, rightbarOpen: true, rightbarWidth: 405 }));
    expect(dropped.rightbar).toBe(0);
    expect(dropped.main).toBe(620);
    expect(dropped.mainCompressed).toBe(false);
  });

  it('报告口径（D-12）：右栏开但已无轨道 → shortageOwner = rightbar（报告交给占用方，由 canShow=false 触发自关）', () => {
    const dropped = computeFrameGeometry(input({ viewportWidth: 600, rightbarOpen: true, rightbarWidth: 400 }));
    expect(dropped.rightbarCanShow).toBe(false);
    expect({ main: dropped.main, shortage: dropped.shortage, owner: dropped.shortageOwner }).toEqual({
      main: 320,
      shortage: 80,
      owner: 'rightbar',
    });
    const noRightbar = computeFrameGeometry(input({ viewportWidth: 600 }));
    expect(noRightbar.shortageOwner).toBeNull();
    const roomy = computeFrameGeometry(input({ viewportWidth: 1920, rightbarOpen: true, rightbarWidth: 864 }));
    expect(roomy.shortage).toBe(0);
    expect(roomy.shortageOwner).toBeNull();
  });

  it('不改偏好宽度：几何计算前后入参对象逐字不变（D-12「不修改用户偏好宽度」）', () => {
    const before: FrameGeometryInput = input({ viewportWidth: 900, rightbarOpen: true, rightbarWidth: 405 });
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

  it('belowAutoCollapse 如实透出视口判定（供状态层收起侧栏）', () => {
    expect(computeFrameGeometry(input({ viewportWidth: 1000 })).belowAutoCollapse).toBe(true);
    expect(computeFrameGeometry(input({ viewportWidth: 1024 })).belowAutoCollapse).toBe(false);
  });
});

describe('侧栏宽度钳制（D-11）', () => {
  it('偏好越界（< 264 / > 420）在几何层被钳制，不产生非法宽度', () => {
    expect(computeFrameGeometry(input({ sidebarWidth: 100 })).sidebar).toBe(264);
    expect(computeFrameGeometry(input({ sidebarWidth: 900 })).sidebar).toBe(420);
    expect(computeFrameGeometry(input({ sidebarWidth: Number.NaN })).sidebar).toBe(280);
  });
});
