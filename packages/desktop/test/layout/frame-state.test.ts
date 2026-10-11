// 面板几何即时状态测试（Z-05 / Z-06 / Z-12 / Z-15）：只存内存、折叠不持久化、
// 右栏首开 45%、拖宽钳制、自动收起为幂等动作（计时在 hook 层）。
import { describe, expect, it } from 'vitest';
import {
  applyFrameAction,
  initialFrameState,
  isSidebarCollapsed,
  rightbarMaxWidth,
  type FrameAction,
  type FrameState,
} from '@harness2/ui-shared/renderer/layout/frame-state.js';
import {
  MAIN_CONVERSATION_KEY,
  RIGHTBAR_MIN_PX,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_COLLAPSED_WIDTH,
  computeFrameGeometry,
  sidebarMaxWidth,
} from '../../src/renderer/layout/index.js';

function run(state: FrameState, ...actions: FrameAction[]): FrameState {
  return actions.reduce((s, a) => applyFrameAction(s, a), state);
}

/** 先把视口宽测进状态（其余 action 都读状态里的视口宽） */
function at(width: number, state: FrameState = initialFrameState()): FrameState {
  return applyFrameAction(state, { type: 'viewport', viewportWidth: width });
}

describe('初值与复位（不持久化）', () => {
  it('初值：侧栏 264 展开、视口未测（0）、右栏关闭、conversation key；无窄屏 override 字段', () => {
    const s = initialFrameState();
    expect(s).toEqual({
      sidebarWidth: 264,
      sidebarCollapsed: false,
      viewportWidth: 0,
      rightbarOpen: false,
      rightbarWidth: null,
      rightbarFullscreen: false,
      mainKey: MAIN_CONVERSATION_KEY,
    });
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(264);
  });

  it('reset 等价于重新挂载：几何/开合回到默认（视口测量值保留）', () => {
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

describe('侧栏（Z-05 / Z-06）', () => {
  it('拖宽：264～容器 50% 内取值；越界钳到边界；宽度不变时返回原状态对象', () => {
    const base = at(1400);
    expect(applyFrameAction(base, { type: 'sidebar/width', width: 320 }).sidebarWidth).toBe(320);
    expect(applyFrameAction(base, { type: 'sidebar/width', width: 10 }).sidebarWidth).toBe(264);
    expect(applyFrameAction(base, { type: 'sidebar/width', width: 900 }).sidebarWidth).toBe(700); // 1400 × 0.5
    const same = applyFrameAction(base, { type: 'sidebar/width', width: SIDEBAR_DEFAULT_WIDTH });
    expect(same).toBe(base);
  });

  it('手动开关：toggle 双向改折叠偏好；折叠不改宽度（展开后仍是拖过的宽度）', () => {
    const wide = at(1400, applyFrameAction(initialFrameState(), { type: 'sidebar/width', width: 360 }));
    const collapsed = applyFrameAction(wide, { type: 'sidebar/toggle' });
    expect(collapsed.sidebarCollapsed).toBe(true);
    expect(isSidebarCollapsed(collapsed)).toBe(true);
    expect(collapsed.sidebarWidth).toBe(360);
    const back = applyFrameAction(collapsed, { type: 'sidebar/toggle' });
    expect(back.sidebarCollapsed).toBe(false);
    expect(back.sidebarWidth).toBe(360);
    // 折叠态几何 = 4px（Z-06）
    const g = computeFrameGeometry({
      viewportWidth: 1400,
      sidebarWidth: back.sidebarWidth,
      sidebarCollapsed: true,
      rightbarOpen: false,
      rightbarWidth: null,
    });
    expect(g.sidebar).toBe(SIDEBAR_COLLAPSED_WIDTH);
  });

  it('自动收起动作幂等：已折叠时返回原状态对象；展开态一次折叠到位', () => {
    const expanded = at(1400);
    const collapsed = applyFrameAction(expanded, { type: 'sidebar/collapse' });
    expect(collapsed.sidebarCollapsed).toBe(true);
    expect(applyFrameAction(collapsed, { type: 'sidebar/collapse' })).toBe(collapsed);
  });

  it('视口测量只记录宽度，不做阈值跨界重置（自动收起改由 resize idle 判定，Z-15）', () => {
    const base = initialFrameState();
    expect(applyFrameAction(base, { type: 'viewport', viewportWidth: 0 })).toBe(base);
    const measured = applyFrameAction(base, { type: 'viewport', viewportWidth: 1024 });
    expect(measured.viewportWidth).toBe(1024);
    expect(applyFrameAction(measured, { type: 'viewport', viewportWidth: 1024 })).toBe(measured);
    // 变窄/变宽都不改折叠偏好（用户偏好说了算；自动收起由 hook 在 resize idle 时显式派发）
    const collapsed = applyFrameAction(measured, { type: 'sidebar/toggle' });
    const narrowed = applyFrameAction(collapsed, { type: 'viewport', viewportWidth: 600 });
    expect(narrowed.sidebarCollapsed).toBe(true);
    const widened = applyFrameAction(narrowed, { type: 'viewport', viewportWidth: 1600 });
    expect(widened.sidebarCollapsed).toBe(true);
    expect(widened.viewportWidth).toBe(1600);
  });
});

describe('右栏（Z-12）', () => {
  it('首开：取**内容区宽** 45%（视口 1400 − 左栏 264 = 1136 → 511）；再次开合保留像素偏好', () => {
    const opened = applyFrameAction(at(1400), { type: 'rightbar/toggle' });
    expect(opened.rightbarOpen).toBe(true);
    expect(opened.rightbarWidth).toBe(511); // 1136 × 0.45

    const resized = applyFrameAction(opened, { type: 'rightbar/width', width: 500 });
    expect(resized.rightbarWidth).toBe(500);
    const closed = applyFrameAction(resized, { type: 'rightbar/toggle' });
    expect(closed.rightbarOpen).toBe(false);
    const reopened = applyFrameAction(applyFrameAction(closed, { type: 'viewport', viewportWidth: 2000 }), {
      type: 'rightbar/toggle',
    });
    expect(reopened.rightbarWidth).toBe(500); // 保留用户像素宽度，不回到 45%
  });

  it('自动收起动作幂等：已关闭时返回原状态对象；展开态一次关闭到位并清全屏标记', () => {
    const opened = applyFrameAction(at(1400), { type: 'rightbar/toggle' });
    const full = applyFrameAction(opened, { type: 'rightbar/fullscreen', fullscreen: true });
    const closed = applyFrameAction(full, { type: 'rightbar/collapse' });
    expect(closed.rightbarOpen).toBe(false);
    expect(closed.rightbarFullscreen).toBe(false);
    expect(applyFrameAction(closed, { type: 'rightbar/collapse' })).toBe(closed);
  });

  it('右栏拖宽：下界 240、上界**内容区宽** 65%；拖宽不改侧栏状态', () => {
    const opened = applyFrameAction(at(1400), { type: 'rightbar/toggle' });
    expect(rightbarMaxWidth(1136)).toBe(738); // 内容区 1136 × 0.65
    expect(applyFrameAction(opened, { type: 'rightbar/width', width: 100 }).rightbarWidth).toBe(RIGHTBAR_MIN_PX);
    expect(applyFrameAction(opened, { type: 'rightbar/width', width: 5000 }).rightbarWidth).toBe(738);
    // 视口未测（0）：内容区 0 → 上限退化到在场下界 240（不给非法上限），宽度仍不越界
    expect(rightbarMaxWidth(0)).toBe(RIGHTBAR_MIN_PX);
    expect(applyFrameAction(initialFrameState(), { type: 'rightbar/width', width: 700 }).rightbarWidth).toBe(
      RIGHTBAR_MIN_PX,
    );
    const widened = applyFrameAction(opened, { type: 'rightbar/width', width: 700 });
    expect(widened.sidebarCollapsed).toBe(opened.sidebarCollapsed);
    expect(rightbarMaxWidth(300)).toBe(RIGHTBAR_MIN_PX);
  });

  it('全屏形态标记置位后不影响宽度偏好（D-74 预接线）', () => {
    const opened = applyFrameAction(at(1400), { type: 'rightbar/toggle' });
    const full = applyFrameAction(opened, { type: 'rightbar/fullscreen', fullscreen: true });
    expect(full.rightbarFullscreen).toBe(true);
    expect(full.rightbarWidth).toBe(511);
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

  it('sidebarMaxWidth 与几何口径一致（1400 → 700）', () => {
    expect(sidebarMaxWidth(1400)).toBe(700);
  });
});
