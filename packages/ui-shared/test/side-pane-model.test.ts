// 右栏标签体系纯逻辑测试（Z2-04 / Z-13 / Z-14）：开/关/重排/激活回落/LRU 驱逐/启动器清单。
// 这些语义 desktop 与未来 web 共用，在共享包内直接钉住。
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SIDE_PANE_SESSION,
  MODEL_TRAJECTORY_TAB_PREFIX,
  SIDE_PANE_LAUNCHER_ITEM_IDS,
  SIDE_PANE_MEMORY_LIMIT,
  SIDE_PANE_TABS,
  activateSidePaneTab,
  closeAllSidePaneTabs,
  closeOtherSidePaneTabs,
  closeSidePaneTab,
  moveSidePaneTab,
  openSidePaneTab,
  sidePaneDropIndex,
  sidePaneMoveTarget,
  sidePaneOf,
  sidePaneOpenTarget,
  sidePaneTabLabel,
  trajectoryTabId,
  trajectoryTabSessionId,
  type SidePaneMemory,
  type SidePaneSessionTabs,
  type SidePaneTabId,
} from '../src/renderer/side-pane/side-pane-model.js';

/** 造一份内存：每桶的 tab 列表给有序 id，激活 tab = 最后一个 */
function memoryOf(entries: Record<string, SidePaneTabId[]>): SidePaneMemory {
  const m = new Map<string, SidePaneSessionTabs>();
  for (const [k, tabs] of Object.entries(entries)) {
    m.set(k, { openTabs: tabs, activeTab: tabs.at(-1) ?? null });
  }
  return m;
}

describe('side-pane-model：打开与激活（Z-13 默认零 tab）', () => {
  it('未知会话 → 空桶（零 tab，宿主据此显示启动器）', () => {
    expect(sidePaneOf(new Map(), 's1')).toBe(EMPTY_SIDE_PANE_SESSION);
    expect(sidePaneOf(new Map(), 's1').openTabs).toEqual([]);
    expect(sidePaneOf(new Map(), 's1').activeTab).toBeNull();
  });

  it('打开 tab：追加到末尾并激活', () => {
    const m0 = memoryOf({ s1: ['plan'] });
    const m1 = openSidePaneTab(m0, 's1', 'tasks');
    expect(sidePaneOf(m1, 's1').openTabs).toEqual(['plan', 'tasks']);
    expect(sidePaneOf(m1, 's1').activeTab).toBe('tasks');
    expect(sidePaneOf(m0, 's1').openTabs).toEqual(['plan']); // 入参不可变
  });

  it('打开已打开的 tab：仅激活，顺序不动；开当前激活 tab 幂等同引用', () => {
    const m0 = memoryOf({ s1: ['plan', 'tasks'] });
    const m1 = openSidePaneTab(m0, 's1', 'tasks'); // 已在末尾且被激活
    expect(sidePaneOf(m1, 's1').openTabs).toEqual(['plan', 'tasks']);
    expect(sidePaneOf(m1, 's1').activeTab).toBe('tasks');
    const m2 = openSidePaneTab(m1, 's1', 'plan'); // 已打开但未激活 → 仅激活
    expect(sidePaneOf(m2, 's1').openTabs).toEqual(['plan', 'tasks']);
    expect(sidePaneOf(m2, 's1').activeTab).toBe('plan');
    expect(openSidePaneTab(m2, 's1', 'plan')).toBe(m2); // 已激活再开 → 同引用免渲染
  });

  it('激活未打开的 tab：不隐性开 tab，原样返回', () => {
    const m0 = memoryOf({ s1: ['plan'] });
    expect(activateSidePaneTab(m0, 's1', 'config')).toBe(m0);
  });
});

describe('side-pane-model：关闭与激活回落', () => {
  it('关闭非激活 tab：激活不变', () => {
    const m0 = memoryOf({ s1: ['plan', 'tasks', 'config'] });
    const m1 = activateSidePaneTab(m0, 's1', 'plan');
    const m2 = closeSidePaneTab(m1, 's1', 'tasks');
    expect(sidePaneOf(m2, 's1').openTabs).toEqual(['plan', 'config']);
    expect(sidePaneOf(m2, 's1').activeTab).toBe('plan');
  });

  it('关闭激活 tab：回落右邻（同位次）', () => {
    const m0 = memoryOf({ s1: ['plan', 'tasks', 'config'] });
    const m1 = closeSidePaneTab(activateSidePaneTab(m0, 's1', 'plan'), 's1', 'plan');
    expect(sidePaneOf(m1, 's1').activeTab).toBe('tasks');
  });

  it('关闭末位激活 tab：回落左邻', () => {
    const m0 = memoryOf({ s1: ['plan', 'tasks'] });
    const m1 = closeSidePaneTab(activateSidePaneTab(m0, 's1', 'tasks'), 's1', 'tasks');
    expect(sidePaneOf(m1, 's1').openTabs).toEqual(['plan']);
    expect(sidePaneOf(m1, 's1').activeTab).toBe('plan');
  });

  it('关空 → 删整条桶（启动器回归、LRU 槽位释放）；关闭不存在的 tab 原样返回', () => {
    const m0 = memoryOf({ s1: ['plan'] });
    const m1 = closeSidePaneTab(m0, 's1', 'plan');
    expect(m1.has('s1')).toBe(false);
    expect(closeSidePaneTab(m1, 's1', 'plan')).toBe(m1);
    expect(closeSidePaneTab(m0, 's2', 'plan')).toBe(m0);
  });

  it('关闭其他：只留指定 tab 并激活；指定的 tab 未打开则不替用户开', () => {
    const m0 = memoryOf({ s1: ['plan', 'tasks', 'config'] });
    const m1 = closeOtherSidePaneTabs(m0, 's1', 'tasks');
    expect(sidePaneOf(m1, 's1').openTabs).toEqual(['tasks']);
    expect(sidePaneOf(m1, 's1').activeTab).toBe('tasks');
    expect(closeOtherSidePaneTabs(m0, 's1', 'file')).toBe(m0);
    // 只剩一个且已激活 → 同引用
    const m2 = closeOtherSidePaneTabs(m1, 's1', 'tasks');
    expect(m2).toBe(m1);
  });

  it('全部关闭：删桶；桶不存在原样返回', () => {
    const m0 = memoryOf({ s1: ['plan', 'tasks'] });
    expect(closeAllSidePaneTabs(m0, 's1').has('s1')).toBe(false);
    expect(closeAllSidePaneTabs(m0, 's2')).toBe(m0);
  });
});

describe('side-pane-model：拖拽排序（Z-14）', () => {
  it('移动 tab 到最终下标；激活 tab 不因重排改变', () => {
    const m0 = memoryOf({ s1: ['plan', 'tasks', 'changes', 'config'] });
    const m1 = activateSidePaneTab(m0, 's1', 'plan');
    const m2 = moveSidePaneTab(m1, 's1', 0, 2); // plan 挪到第 3 位
    expect(sidePaneOf(m2, 's1').openTabs).toEqual(['tasks', 'changes', 'plan', 'config']);
    expect(sidePaneOf(m2, 's1').activeTab).toBe('plan');
  });

  it('非法/等价输入原样返回（越界、from===to、空桶）', () => {
    const m0 = memoryOf({ s1: ['plan', 'tasks'] });
    expect(moveSidePaneTab(m0, 's1', 0, 0)).toBe(m0);
    expect(moveSidePaneTab(m0, 's1', -1, 1)).toBe(m0);
    expect(moveSidePaneTab(m0, 's1', 0, 5)).toBe(m0);
    expect(moveSidePaneTab(m0, 's2', 0, 1)).toBe(m0);
  });

  it('落点换算：越过中点才算落到它前面；全越过后落最后；无效矩形 → null', () => {
    // 三个 100px 宽的 tab：中点 50/150/250
    const rects = [
      { left: 0, right: 100 },
      { left: 100, right: 200 },
      { left: 200, right: 300 },
    ];
    expect(sidePaneDropIndex(rects, 49)).toBe(0);
    expect(sidePaneDropIndex(rects, 50)).toBe(1);
    expect(sidePaneDropIndex(rects, 150)).toBe(2);
    expect(sidePaneDropIndex(rects, 999)).toBe(3);
    expect(sidePaneDropIndex([], 10)).toBeNull();
    expect(sidePaneDropIndex([{ left: 0, right: 0 }], 10)).toBeNull(); // jsdom 零矩形：不重排
  });

  it('最终下标换算（原始下标 from + 矩形落点 → 移除后补位）', () => {
    expect(sidePaneMoveTarget(0, 2)).toBe(1); // 第 1 个拖到第 3 格前 → 落位后下标 1
    expect(sidePaneMoveTarget(2, 0)).toBe(0);
    expect(sidePaneMoveTarget(1, 3)).toBe(2);
  });
});

describe('side-pane-model：LRU 内存（Z-13 上限 50，重启不保留）', () => {
  it('超过 50 个会话桶 → 驱逐最旧（最久未 mutate）条目', () => {
    let m: SidePaneMemory = new Map();
    for (let i = 0; i < SIDE_PANE_MEMORY_LIMIT; i += 1) {
      m = openSidePaneTab(m, `s${i}`, 'plan');
    }
    expect(m.size).toBe(SIDE_PANE_MEMORY_LIMIT);
    m = openSidePaneTab(m, 's-new', 'plan');
    expect(m.size).toBe(SIDE_PANE_MEMORY_LIMIT);
    expect(m.has('s0')).toBe(false); // 最旧被驱逐
    expect(m.has('s-new')).toBe(true);
  });

  it('mutation 触碰刷新 LRU 新鲜度（读不触碰）', () => {
    let m: SidePaneMemory = new Map();
    for (let i = 0; i < SIDE_PANE_MEMORY_LIMIT; i += 1) {
      m = openSidePaneTab(m, `s${i}`, 'plan');
    }
    m = openSidePaneTab(m, 's0', 'tasks'); // 触碰最旧的 s0 → 它变最新
    m = openSidePaneTab(m, 's-fresh', 'plan');
    expect(m.has('s0')).toBe(true);
    expect(m.has('s1')).toBe(false); // 现在 s1 才是最旧
  });
});

describe('side-pane-model：目录与启动器清单（vs ZCode 启动器差异已登记）', () => {
  it('目录 8 项带中文标签；未知 id 回落 id 本身', () => {
    expect(SIDE_PANE_TABS.map((t) => t.id)).toEqual([
      'plan',
      'tasks',
      'background-tasks',
      'approvals',
      'changes',
      'workspace',
      'file',
      'config',
    ]);
    expect(sidePaneTabLabel('plan')).toBe('计划');
    expect(sidePaneTabLabel('file')).toBe('文件');
    expect(sidePaneTabLabel('background-tasks')).toBe('后台任务'); // Z2-08
  });

  it('启动器不列「文件」（D-86 路由专属，同 ZCode code-viewer 不进加号菜单）；列「模型轨迹」与「后台任务」', () => {
    expect(SIDE_PANE_LAUNCHER_ITEM_IDS).toEqual([
      'plan',
      'tasks',
      'background-tasks',
      'approvals',
      'changes',
      'workspace',
      'config',
      'model-trajectory',
    ]);
    expect(SIDE_PANE_LAUNCHER_ITEM_IDS).not.toContain('file');
    // Z2-08：「后台任务」项常列；按需可用的显隐策略在宿主（桌面 SidePanel）落实
    expect(sidePaneOpenTarget('background-tasks', 's1')).toBe('background-tasks'); // 固定 id，不按会话解析
  });
});

describe('side-pane-model：轨迹 tab（Z-14 model-trajectory:{sessionId}，Z2-05）', () => {
  it('trajectoryTabId 按会话拼装；trajectoryTabSessionId 反解（非轨迹 tab → null）', () => {
    expect(trajectoryTabId('s1')).toBe('model-trajectory:s1');
    expect(MODEL_TRAJECTORY_TAB_PREFIX).toBe('model-trajectory:');
    expect(trajectoryTabSessionId(trajectoryTabId('s1'))).toBe('s1');
    expect(trajectoryTabSessionId('plan')).toBeNull();
    expect(trajectoryTabSessionId('file')).toBeNull();
  });

  it('轨迹 tab 标签「模型轨迹」（不摆英文假文案）', () => {
    expect(sidePaneTabLabel(trajectoryTabId('s1'))).toBe('模型轨迹');
  });

  it('sidePaneOpenTarget：「模型轨迹」启动器项按会话解析；静态项原样', () => {
    expect(sidePaneOpenTarget('model-trajectory', 's1')).toBe('model-trajectory:s1');
    expect(sidePaneOpenTarget('plan', 's1')).toBe('plan');
    expect(sidePaneOpenTarget('config', 's9')).toBe('config');
  });

  it('轨迹 tab 走同一套状态机：打开/激活/关闭回落对 composite id 一视同仁', () => {
    const t1 = trajectoryTabId('s1');
    const t2 = trajectoryTabId('s2');
    let m: SidePaneMemory = new Map();
    m = openSidePaneTab(m, 's1', 'plan');
    m = openSidePaneTab(m, 's1', t1);
    expect(sidePaneOf(m, 's1').openTabs).toEqual(['plan', t1]);
    expect(sidePaneOf(m, 's1').activeTab).toBe(t1);
    // 同会话再开 → 幂等激活（每桶至多一个轨迹 tab）
    expect(openSidePaneTab(m, 's1', t1)).toBe(m);
    // 轨迹 tab id 按会话不同（s2 的轨迹 tab ≠ s1 的）
    expect(sidePaneOf(m, 's1').openTabs).not.toContain(t2);
    // 关闭轨迹 tab：回落左邻 plan
    m = closeSidePaneTab(m, 's1', t1);
    expect(sidePaneOf(m, 's1').openTabs).toEqual(['plan']);
    expect(sidePaneOf(m, 's1').activeTab).toBe('plan');
  });
});
