// G-04 八布局区域单测（headless，纯逻辑）：
// - 确定性高度分配表驱动用例（给定终端行数 → 各区域 {top,height} 逐区断言）
// - 数据面板空数据自动隐藏（queue/todos/tasks；不造假内容）
// - 自然高度按描述符 min/max 钳制；小屏退化阶梯（scrollback 至少保 1 行）
// - overlay modal 顶层锚定（贴固定区簇之上、向上生长、钳到屏幕顶）
// - RegionLayoutManager：可见性/数据开关 + render 预算驱动（只驱动可见区域，overlay 最后）
import { describe, expect, it } from 'vitest';
import { CellBuffer } from '../../../src/tui/renderer/cell-buffer.js';
import {
  REGION_DESCRIPTORS,
  REGION_STACK_ORDER,
  RegionLayoutManager,
  allocateRegions,
  clampRegionHeight,
  regionVisible,
  type RegionAllocation,
  type RegionId,
  type RegionInput,
  type RegionLayout,
} from '../../../src/tui/render/regions.js';

/** 取某区域的分配结果（测试导航用） */
function allocOf(layout: RegionLayout, id: RegionId): RegionAllocation {
  const a = layout.regions.find((r) => r.id === id);
  expect(a, `区域 ${id} 应有分配结果`).toBeDefined();
  return a as RegionAllocation;
}

/** 常规 fullscreen 输入：prompt 三行（草稿 2 + 提示 1）、状态行/快捷键条开、浮层无 */
function baseInputs(overrides: Partial<Record<RegionId, RegionInput>> = {}): Map<RegionId, RegionInput> {
  const m = new Map<RegionId, RegionInput>();
  m.set('prompt', { naturalHeight: 3 });
  m.set('statusLine', { naturalHeight: 1 });
  m.set('shortcutsBar', { naturalHeight: 1 });
  for (const [id, input] of Object.entries(overrides)) m.set(id as RegionId, input as RegionInput);
  return m;
}

describe('描述符契约（G-04 八区域）', () => {
  it('恰好八个区域，id 全集与规格清单一致', () => {
    expect(REGION_DESCRIPTORS.map((d) => d.id)).toEqual([
      'scrollback',
      'prompt',
      'statusLine',
      'shortcutsBar',
      'queuePane',
      'todosPane',
      'tasksPane',
      'overlayModal',
    ]);
  });

  it('可聚焦性：scrollback/prompt/overlayModal 可聚焦，其余纯展示', () => {
    const focusable = REGION_DESCRIPTORS.filter((d) => d.focusable).map((d) => d.id);
    expect(focusable).toEqual(['scrollback', 'prompt', 'overlayModal']);
  });

  it('hideWhenEmpty 只落在三个数据面板上（空数据自动隐藏）', () => {
    const hidden = REGION_DESCRIPTORS.filter((d) => d.hideWhenEmpty).map((d) => d.id);
    expect(hidden).toEqual(['queuePane', 'todosPane', 'tasksPane']);
  });

  it('垂直栈序（底→顶）：快捷键条最底、数据面板在 prompt 之上', () => {
    expect(REGION_STACK_ORDER).toEqual(['shortcutsBar', 'statusLine', 'prompt', 'queuePane', 'todosPane', 'tasksPane']);
  });
});

describe('确定性高度分配（rows → 各区域行数）', () => {
  it('常规 24 行：scrollback 拿剩余、固定区簇贴底自底向上落位、空数据面板隐藏', () => {
    const layout = allocateRegions(24, baseInputs());
    expect(allocOf(layout, 'scrollback')).toEqual({ id: 'scrollback', top: 0, height: 19, visible: true });
    expect(allocOf(layout, 'prompt')).toEqual({ id: 'prompt', top: 19, height: 3, visible: true });
    expect(allocOf(layout, 'statusLine')).toEqual({ id: 'statusLine', top: 22, height: 1, visible: true });
    expect(allocOf(layout, 'shortcutsBar')).toEqual({ id: 'shortcutsBar', top: 23, height: 1, visible: true });
    // 数据面板无数据：高度 0、不可见（不占位、不渲染假内容）
    for (const id of ['queuePane', 'todosPane', 'tasksPane'] as const) {
      const a = allocOf(layout, id);
      expect(a.height).toBe(0);
      expect(a.visible).toBe(false);
    }
    expect(layout.overlay).toBeNull();
  });

  it('同输入恒同输出（确定性）', () => {
    const a = allocateRegions(24, baseInputs());
    const b = allocateRegions(24, baseInputs());
    expect(a).toEqual(b);
  });

  it('数据面板有数据：出现于 prompt 之上、自然高度钳到 max 6', () => {
    const layout = allocateRegions(
      24,
      baseInputs({
        queuePane: { naturalHeight: 100, hasData: true },
        todosPane: { naturalHeight: 2, hasData: true },
      }),
    );
    expect(allocOf(layout, 'queuePane')).toMatchObject({ top: 13, height: 6, visible: true });
    expect(allocOf(layout, 'todosPane')).toMatchObject({ top: 11, height: 2, visible: true });
    expect(allocOf(layout, 'prompt')).toMatchObject({ top: 19, height: 3 });
    expect(allocOf(layout, 'scrollback').height).toBe(11); // 24 - (3+1+1+6+2)
  });

  it('hasData=true 但装配层显式 visible=false 仍隐藏（开关叠加数据语义）', () => {
    const layout = allocateRegions(24, baseInputs({ queuePane: { naturalHeight: 4, hasData: true, visible: false } }));
    expect(allocOf(layout, 'queuePane').visible).toBe(false);
    expect(allocOf(layout, 'queuePane').height).toBe(0);
  });

  it('rows=0：全区域零高度，scrollback 不可见', () => {
    const layout = allocateRegions(0, baseInputs());
    expect(allocOf(layout, 'scrollback')).toEqual({ id: 'scrollback', top: 0, height: 0, visible: false });
    expect(allocOf(layout, 'prompt').height).toBe(0);
  });
});

describe('自然高度钳制（min/max）', () => {
  it('prompt：0 抬到 minHeight 1；上不封顶（高度由装配层测量决定）', () => {
    expect(clampRegionHeight('prompt', 0)).toBe(1);
    expect(clampRegionHeight('prompt', 3)).toBe(3);
    expect(clampRegionHeight('prompt', 100)).toBe(100);
  });

  it('数据面板：下限 1、上限 6（槽位占位契约，P3 接数据源再校准）', () => {
    expect(clampRegionHeight('queuePane', 0)).toBe(1);
    expect(clampRegionHeight('queuePane', 4)).toBe(4);
    expect(clampRegionHeight('tasksPane', 100)).toBe(6);
  });

  it('单行区域（statusLine/shortcutsBar）恒 1', () => {
    expect(clampRegionHeight('statusLine', 5)).toBe(1);
    expect(clampRegionHeight('shortcutsBar', 0)).toBe(1);
  });
});

describe('小屏退化阶梯（scrollback 至少保 1 行）', () => {
  it('rows=5 需求 9 行：先砍 tasks/todos/queue，再砍 statusLine，prompt 与 shortcuts 保留', () => {
    const layout = allocateRegions(
      5,
      baseInputs({
        queuePane: { naturalHeight: 1, hasData: true },
        todosPane: { naturalHeight: 1, hasData: true },
        tasksPane: { naturalHeight: 1, hasData: true },
      }),
    );
    expect(allocOf(layout, 'scrollback').height).toBe(1);
    expect(allocOf(layout, 'prompt').height).toBe(3);
    expect(allocOf(layout, 'shortcutsBar').height).toBe(1);
    expect(allocOf(layout, 'statusLine').height).toBe(0);
    expect(allocOf(layout, 'tasksPane').height).toBe(0);
  });

  it('rows=2：prompt 降到 minHeight 1，scrollback 保 1', () => {
    const layout = allocateRegions(2, baseInputs());
    expect(allocOf(layout, 'scrollback').height).toBe(1);
    expect(allocOf(layout, 'prompt').height).toBe(1);
    expect(allocOf(layout, 'statusLine').height).toBe(0);
    expect(allocOf(layout, 'shortcutsBar').height).toBe(0);
  });

  it('rows=1：阶梯多轮扫描后全部固定区归零，只留 scrollback', () => {
    const layout = allocateRegions(1, baseInputs());
    expect(allocOf(layout, 'scrollback')).toMatchObject({ top: 0, height: 1, visible: true });
    for (const id of REGION_STACK_ORDER) expect(allocOf(layout, id).height).toBe(0);
  });
});

describe('overlay modal 顶层锚定', () => {
  it('底部贴固定区簇之上、向上生长（rows=24、簇顶 19、自然高 5 → top 14）', () => {
    const layout = allocateRegions(24, baseInputs({ overlayModal: { naturalHeight: 5 } }));
    expect(layout.overlay).toEqual({ id: 'overlayModal', top: 14, height: 5, visible: true });
  });

  it('自然高超于簇顶空间：钳到簇顶、贴屏幕顶', () => {
    const layout = allocateRegions(24, baseInputs({ overlayModal: { naturalHeight: 100 } }));
    expect(layout.overlay).toEqual({ id: 'overlayModal', top: 0, height: 19, visible: true });
  });

  it('无输入 / 显式不可见 → null（顶层不渲染即不存在）', () => {
    expect(allocateRegions(24, baseInputs()).overlay).toBeNull();
    expect(allocateRegions(24, baseInputs({ overlayModal: { naturalHeight: 5, visible: false } })).overlay).toBeNull();
  });

  it('极端小屏（rows=1，簇顶 0）无空间 → null', () => {
    const layout = allocateRegions(1, baseInputs({ overlayModal: { naturalHeight: 3 } }));
    expect(layout.overlay).toBeNull();
  });
});

describe('regionVisible 谓词（不做假入口）', () => {
  it('未接线的区域不可见（statusLine 非数据面板，但没接线同样不渲染）', () => {
    expect(regionVisible('statusLine', undefined)).toBe(false);
    expect(regionVisible('statusLine', { naturalHeight: 1 })).toBe(true);
  });

  it('hideWhenEmpty 区域：hasData=true 才可见；scrollback 主区缺省可见', () => {
    expect(regionVisible('queuePane', undefined)).toBe(false);
    expect(regionVisible('queuePane', { hasData: false })).toBe(false);
    expect(regionVisible('queuePane', { hasData: true })).toBe(true);
    expect(regionVisible('scrollback', undefined)).toBe(true);
  });

  it('显式 visible=false 一票否决', () => {
    expect(regionVisible('scrollback', { visible: false })).toBe(false);
    expect(regionVisible('queuePane', { hasData: true, visible: false })).toBe(false);
  });
});

describe('RegionLayoutManager（运行时薄壳）', () => {
  it('缺省（零输入）：三数据面板隐藏，scrollback 独占全屏', () => {
    const mgr = new RegionLayoutManager();
    const layout = mgr.layout(24);
    expect(allocOf(layout, 'scrollback')).toEqual({ id: 'scrollback', top: 0, height: 24, visible: true });
    expect(allocOf(layout, 'queuePane').visible).toBe(false);
  });

  it('setData 打开数据面板 / setVisible 关闭区域', () => {
    const mgr = new RegionLayoutManager();
    mgr.setInput('queuePane', { naturalHeight: 2 }); // setInput 整对象替换，须先于 setData
    mgr.setData('queuePane', true);
    mgr.setVisible('statusLine', false);
    const layout = mgr.layout(24);
    expect(allocOf(layout, 'queuePane')).toMatchObject({ height: 2, visible: true });
    expect(allocOf(layout, 'statusLine').height).toBe(0);
    // 同输入再布局恒同输出
    expect(mgr.layout(24)).toEqual(layout);
  });

  it('render：只驱动可见且高 >0 且有回调的区域，预算矩形与分配一致', () => {
    const buf = new CellBuffer(40, 24);
    const mgr = new RegionLayoutManager();
    const calls: string[] = [];
    mgr.setInput('prompt', {
      naturalHeight: 3,
      render: (b) => {
        calls.push(b.id);
        expect(b.top).toBe(20);
        expect(b.height).toBe(3);
        expect(b.cols).toBe(40);
        expect(b.buf).toBe(buf);
      },
    });
    mgr.setInput('statusLine', { naturalHeight: 1, render: (b) => calls.push(b.id) });
    mgr.setInput('scrollback', { render: (b) => calls.push(b.id) });
    // 不可见区域带回调也不驱动（数据面板空数据）
    mgr.setInput('queuePane', { naturalHeight: 4, hasData: false, render: (b) => calls.push(b.id) });
    const layout = mgr.layout(24);
    mgr.render(buf, layout);
    expect(calls).toEqual(['scrollback', 'statusLine', 'prompt']); // regions 顺序：scrollback → 栈序（底→顶）
  });

  it('render：overlay 顶层最后画（压在固定区之上）', () => {
    const buf = new CellBuffer(40, 24);
    const mgr = new RegionLayoutManager();
    const calls: string[] = [];
    for (const id of ['scrollback', 'prompt', 'overlayModal'] as const) {
      mgr.setInput(
        id,
        id === 'overlayModal'
          ? { naturalHeight: 4, render: (b) => calls.push(b.id) }
          : { render: (b) => calls.push(b.id) },
      );
    }
    mgr.setInput('prompt', { naturalHeight: 3, render: (b) => calls.push(b.id) });
    mgr.render(buf, mgr.layout(24));
    expect(calls[calls.length - 1]).toBe('overlayModal');
  });

  it('snapshot 返回输入快照（不泄漏内部可变引用语义）', () => {
    const mgr = new RegionLayoutManager();
    mgr.setInput('prompt', { naturalHeight: 2 });
    expect(mgr.snapshot().get('prompt')?.naturalHeight).toBe(2);
  });
});
