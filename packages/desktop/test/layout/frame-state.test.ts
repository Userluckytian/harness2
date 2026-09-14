// 面板几何即时状态测试（D-13 / D-14）：只存内存、窄屏 override 双向重置、右栏首开 45%、拖宽钳制、
// 开右栏只在窄屏收起侧栏（上游 stores.ts:108-142 口径）。
import { describe, expect, it } from 'vitest';
import {
  applyFrameAction,
  initialFrameState,
  isSidebarCollapsed,
  rightbarMaxWidth,
  type FrameAction,
  type FrameState,
} from '../../src/renderer/layout/frame-state.js';
import {
  MAIN_CONVERSATION_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  computeFrameGeometry,
} from '../../src/renderer/layout/index.js';

function run(state: FrameState, ...actions: FrameAction[]): FrameState {
  return actions.reduce((s, a) => applyFrameAction(s, a), state);
}

/** 先把视口宽测进状态（上游 setViewportWidth 语义；其余 action 都读状态里的视口宽） */
function at(width: number, state: FrameState = initialFrameState()): FrameState {
  return applyFrameAction(state, { type: 'viewport', viewportWidth: width });
}

describe('初值与复位（D-14）', () => {
  it('初值：侧栏 280 展开、无窄屏 override、视口未测（0）、右栏关闭、conversation key', () => {
    const s = initialFrameState();
    expect(s).toEqual({
      sidebarWidth: 280,
      sidebarCollapsed: false,
      narrowExpanded: false,
      viewportWidth: 0,
      rightbarOpen: false,
      rightbarWidth: null,
      rightbarFullscreen: false,
      mainKey: MAIN_CONVERSATION_KEY,
    });
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(280);
  });

  it('reset 等价于重新挂载：几何/开合回到默认（视口测量值保留 —— 重挂载会立刻重测同值）', () => {
    const dirty = run(
      at(1400),
      { type: 'sidebar/width', width: 400 },
      { type: 'sidebar/toggle' },
      { type: 'rightbar/toggle' },
      { type: 'rightbar/width', width: 900 },
      { type: 'main/select-key', key: 'plan' },
    );
    expect(dirty).not.toEqual(initialFrameState());
    expect(applyFrameAction(dirty, { type: 'reset' })).toEqual(
      run(initialFrameState(), { type: 'viewport', viewportWidth: 1400 }),
    );
  });
});

describe('侧栏（D-11 / D-13）', () => {
  it('拖宽：264～420 内取值；越界钳到边界；宽度不变时返回原状态对象（无意义重渲染不发）', () => {
    const base = initialFrameState();
    expect(applyFrameAction(base, { type: 'sidebar/width', width: 320 }).sidebarWidth).toBe(320);
    expect(applyFrameAction(base, { type: 'sidebar/width', width: 10 }).sidebarWidth).toBe(264);
    expect(applyFrameAction(base, { type: 'sidebar/width', width: 900 }).sidebarWidth).toBe(420);
    const same = applyFrameAction(base, { type: 'sidebar/width', width: SIDEBAR_DEFAULT_WIDTH });
    expect(same).toBe(base);
  });

  it('宽屏手动开关：toggle 双向改偏好；收起不改偏好宽度（展开后仍是拖过的宽度）', () => {
    const wide = at(1400, applyFrameAction(initialFrameState(), { type: 'sidebar/width', width: 360 }));
    const collapsed = applyFrameAction(wide, { type: 'sidebar/toggle' });
    expect(collapsed.sidebarCollapsed).toBe(true);
    expect(isSidebarCollapsed(collapsed)).toBe(true);
    expect(collapsed.sidebarWidth).toBe(360);
    const back = applyFrameAction(collapsed, { type: 'sidebar/toggle' });
    expect(back.sidebarCollapsed).toBe(false);
    expect(back.sidebarWidth).toBe(360);
    // 收起态几何 = 56px 轨道（D-13）
    const g = computeFrameGeometry({
      viewportWidth: 1400,
      sidebarWidth: back.sidebarWidth,
      sidebarCollapsed: true,
      rightbarOpen: false,
      rightbarWidth: null,
    });
    expect(g.sidebar).toBe(SIDEBAR_RAIL_WIDTH);
  });

  it('窄屏 toggle 只翻 override，不改宽屏偏好（回到宽屏仍是拖过的宽度）', () => {
    const narrow = at(900, applyFrameAction(initialFrameState(), { type: 'sidebar/width', width: 360 }));
    expect(isSidebarCollapsed(narrow)).toBe(true); // 窄屏默认自动收起
    const expanded = applyFrameAction(narrow, { type: 'sidebar/toggle' });
    expect(expanded.narrowExpanded).toBe(true);
    expect(expanded.sidebarCollapsed).toBe(false); // 宽屏偏好未被改写
    expect(isSidebarCollapsed(expanded)).toBe(false);
    expect(expanded.sidebarWidth).toBe(360);
  });

  it('跨 1024 阈值（双向）重置窄屏 override：900 → 1400 回到宽态偏好（展开 280）', () => {
    const wide = at(1400);
    expect(isSidebarCollapsed(wide)).toBe(false);
    const narrow = applyFrameAction(wide, { type: 'viewport', viewportWidth: 900 });
    expect(isSidebarCollapsed(narrow)).toBe(true); // 窄屏自动收起
    const widened = applyFrameAction(narrow, { type: 'viewport', viewportWidth: 1600 });
    expect(isSidebarCollapsed(widened)).toBe(false); // 回到宽态偏好（侧栏展开 280）
    expect(widened.sidebarCollapsed).toBe(false);
  });

  it('窄屏手动展开后回到宽屏：override 被重置，宽屏偏好说了算（不把临时展开写死成偏好）', () => {
    const narrow = at(900);
    const expanded = applyFrameAction(narrow, { type: 'sidebar/toggle' }); // 手动展开
    expect(isSidebarCollapsed(expanded)).toBe(false);
    const widened = applyFrameAction(expanded, { type: 'viewport', viewportWidth: 1400 });
    expect(widened.narrowExpanded).toBe(false);
    expect(isSidebarCollapsed(widened)).toBe(false);
    // 宽屏偏好是「收起」时，回到宽屏同样按偏好收起
    const wideCollapsed = applyFrameAction(widened, { type: 'sidebar/toggle' });
    expect(wideCollapsed.sidebarCollapsed).toBe(true);
    const narrowAgain = applyFrameAction(wideCollapsed, { type: 'viewport', viewportWidth: 900 });
    expect(isSidebarCollapsed(narrowAgain)).toBe(true);
    const widenBack = applyFrameAction(narrowAgain, { type: 'viewport', viewportWidth: 1400 });
    expect(isSidebarCollapsed(widenBack)).toBe(true); // 宽屏偏好（收起）保留
  });

  it('视口未就绪（0）与同宽重复测量：不改状态引用；跨到 1024 不算窄屏', () => {
    const base = initialFrameState();
    expect(applyFrameAction(base, { type: 'viewport', viewportWidth: 0 })).toBe(base);
    const measured = applyFrameAction(base, { type: 'viewport', viewportWidth: 1024 });
    expect(measured.viewportWidth).toBe(1024);
    expect(isSidebarCollapsed(measured)).toBe(false);
    expect(applyFrameAction(measured, { type: 'viewport', viewportWidth: 1024 })).toBe(measured);
    // 窄屏内同区段反复测量不重置 override
    const narrow = applyFrameAction(measured, { type: 'viewport', viewportWidth: 900 });
    const stillNarrow = applyFrameAction(narrow, { type: 'viewport', viewportWidth: 800 });
    expect(stillNarrow.narrowExpanded).toBe(false);
    expect(stillNarrow.viewportWidth).toBe(800);
  });
});

describe('右栏（D-11 / D-13）', () => {
  it('首开：取视口 45%；再次开合保留上次像素宽度偏好（不再按 45% 重算）', () => {
    const opened = applyFrameAction(at(1400), { type: 'rightbar/toggle' });
    expect(opened.rightbarOpen).toBe(true);
    expect(opened.rightbarWidth).toBe(630); // 1400 × 0.45

    const resized = applyFrameAction(opened, { type: 'rightbar/width', width: 500 });
    expect(resized.rightbarWidth).toBe(500);
    const closed = applyFrameAction(resized, { type: 'rightbar/toggle' });
    expect(closed.rightbarOpen).toBe(false);
    const reopened = applyFrameAction(applyFrameAction(closed, { type: 'viewport', viewportWidth: 2000 }), {
      type: 'rightbar/toggle',
    });
    expect(reopened.rightbarWidth).toBe(500); // 保留用户像素宽度，不回到 45%
  });

  it('宽屏打开右栏不动侧栏（P0-2 上游 stores.ts:131）；窄屏才清掉手动展开的 override', () => {
    // 宽屏（1400 ≥ 1024）：侧栏保持展开
    const wideOpened = applyFrameAction(at(1400), { type: 'rightbar/toggle' });
    expect(wideOpened.rightbarOpen).toBe(true);
    expect(isSidebarCollapsed(wideOpened)).toBe(false);
    expect(wideOpened.sidebarCollapsed).toBe(false);

    // 窄屏（900 < 1024）：用户手动展开 → 打开右栏 → 清 override（侧栏回 56px 轨道）
    const narrow = at(900);
    const manuallyExpanded = applyFrameAction(narrow, { type: 'sidebar/toggle' });
    expect(isSidebarCollapsed(manuallyExpanded)).toBe(false);
    const narrowOpened = applyFrameAction(manuallyExpanded, { type: 'rightbar/toggle' });
    expect(narrowOpened.rightbarOpen).toBe(true);
    expect(narrowOpened.narrowExpanded).toBe(false);
    expect(isSidebarCollapsed(narrowOpened)).toBe(true);
    // 窄屏自动收起态下再开一次右栏：仍是收起（幂等，不产生 override）
    const closed = applyFrameAction(narrowOpened, { type: 'rightbar/toggle' });
    const reopened = applyFrameAction(closed, { type: 'rightbar/toggle' });
    expect(isSidebarCollapsed(reopened)).toBe(true);
    expect(reopened.narrowExpanded).toBe(false);
  });

  it('右栏拖宽：下界 300、上界视口 70%；拖宽不改侧栏状态', () => {
    const opened = applyFrameAction(at(1400), { type: 'rightbar/toggle' });
    expect(rightbarMaxWidth(1400)).toBe(980);
    expect(applyFrameAction(opened, { type: 'rightbar/width', width: 100 }).rightbarWidth).toBe(300);
    expect(applyFrameAction(opened, { type: 'rightbar/width', width: 5000 }).rightbarWidth).toBe(980);
    // 视口未测（0）：上限退化到在场下界 300（不给非法上限），宽度仍不越界
    expect(rightbarMaxWidth(0)).toBe(300);
    expect(applyFrameAction(initialFrameState(), { type: 'rightbar/width', width: 700 }).rightbarWidth).toBe(300);
    const widened = applyFrameAction(opened, { type: 'rightbar/width', width: 700 });
    expect(widened.sidebarCollapsed).toBe(opened.sidebarCollapsed);
    expect(rightbarMaxWidth(300)).toBe(300);
  });

  it('全屏形态标记置位后不影响宽度偏好（D-74 预接线）', () => {
    const opened = applyFrameAction(at(1400), { type: 'rightbar/toggle' });
    const full = applyFrameAction(opened, { type: 'rightbar/fullscreen', fullscreen: true });
    expect(full.rightbarFullscreen).toBe(true);
    expect(full.rightbarWidth).toBe(630);
    expect(applyFrameAction(full, { type: 'rightbar/fullscreen', fullscreen: true })).toBe(full);
    expect(applyFrameAction(full, { type: 'rightbar/toggle' }).rightbarFullscreen).toBe(false);
  });
});

describe('main keyed 席位（D-10）', () => {
  it('select-key 切换；null 回到保留的 conversation key', () => {
    const base = initialFrameState();
    expect(base.mainKey).toBe('conversation');
    const panel = applyFrameAction(base, { type: 'main/select-key', key: 'plan' });
    expect(panel.mainKey).toBe('plan');
    expect(applyFrameAction(panel, { type: 'main/select-key', key: null }).mainKey).toBe(MAIN_CONVERSATION_KEY);
    expect(applyFrameAction(panel, { type: 'main/select-key', key: 'plan' })).toBe(panel);
  });
});
