// G-05 块折叠状态机单测（headless，纯 reducer）：
// - 键位映射全表（h/l/←/→/e/Shift+E/Ctrl+E/r；块级键位依赖聚焦块 id）
// - 折叠/展开方向性（h 收 l 开）、toggle、幽灵块 no-op、reducer 纯度
// - Shift+E 全展；Ctrl+E 只作用于 thinking 块（有展开 → 全收，否则全开）
// - respect_manual_folds：手动折叠不被自动折叠覆盖（缺省 true）；false 时覆盖并清手动标记
// - register 账目建立 / 重登记保留既有开合态；配置解析 parseRespectManualFolds
import { describe, expect, it } from 'vitest';
import {
  RESPECT_MANUAL_FOLDS_CONFIG_PATH,
  emptyFoldsState,
  foldKeyToAction,
  isCollapsed,
  parseRespectManualFolds,
  reduceFoldKey,
  reduceFolds,
  type FoldsState,
} from '../../../src/tui/render/folds.js';

/** 四类块各一：thinking/tool/diff 缺省折叠、message 缺省展开 */
function setup(respectManualFolds = true): FoldsState {
  return reduceFolds(emptyFoldsState(respectManualFolds), {
    type: 'register',
    blocks: [
      { id: 't1', kind: 'thinking', defaultCollapsed: true },
      { id: 'tool1', kind: 'tool', defaultCollapsed: true },
      { id: 'd1', kind: 'diff', defaultCollapsed: true },
      { id: 'm1', kind: 'message', defaultCollapsed: false },
    ],
  });
}

/** 逐块断言（collapsed, manual） */
function expectBlock(state: FoldsState, id: string, collapsed: boolean, manual: boolean): void {
  const b = state.blocks.get(id);
  expect(b, `块 ${id} 应已注册`).toBeDefined();
  expect(b?.collapsed, `块 ${id}.collapsed`).toBe(collapsed);
  expect(b?.manual, `块 ${id}.manual`).toBe(manual);
}

describe('register 账目建立', () => {
  it('新块按 defaultCollapsed 落账，manual=false（缺省折叠不算手动）', () => {
    const s = setup();
    expectBlock(s, 't1', true, false);
    expectBlock(s, 'm1', false, false);
    expect(s.kinds.get('t1')).toBe('thinking');
    expect(s.kinds.get('d1')).toBe('diff');
  });

  it('重登记同 id：保留既有开合态与手动标记，只更新 kind', () => {
    let s = setup();
    s = reduceFolds(s, { type: 'collapse', blockId: 't1' });
    s = reduceFolds(s, {
      type: 'register',
      blocks: [{ id: 't1', kind: 'message', defaultCollapsed: false }],
    });
    expectBlock(s, 't1', true, true); // 用户 h 过的块不被重登记重置
    expect(s.kinds.get('t1')).toBe('message');
  });
});

describe('键位映射 foldKeyToAction（G-05 键位表）', () => {
  it('h 与 ← 折叠；l 与 → 展开（方向性，非 toggle）', () => {
    expect(foldKeyToAction('h', 'b1')).toEqual({ type: 'collapse', blockId: 'b1' });
    expect(foldKeyToAction('ArrowLeft', 'b1')).toEqual({ type: 'collapse', blockId: 'b1' });
    expect(foldKeyToAction('l', 'b1')).toEqual({ type: 'expand', blockId: 'b1' });
    expect(foldKeyToAction('ArrowRight', 'b1')).toEqual({ type: 'expand', blockId: 'b1' });
  });

  it('e 切折叠；Shift+E 全展；Ctrl+E thinking 开合；r 原始 markdown', () => {
    expect(foldKeyToAction('e', 'b1')).toEqual({ type: 'toggle', blockId: 'b1' });
    expect(foldKeyToAction('Shift+E', null)).toEqual({ type: 'expandAll' });
    expect(foldKeyToAction('Ctrl+E', null)).toEqual({ type: 'toggleThinking' });
    expect(foldKeyToAction('r', null)).toEqual({ type: 'toggleRawMarkdown' });
  });

  it('无聚焦块时块级键位（h/l/e）无动作，全局键不受影响', () => {
    expect(foldKeyToAction('h', null)).toBeNull();
    expect(foldKeyToAction('l', null)).toBeNull();
    expect(foldKeyToAction('e', null)).toBeNull();
    expect(foldKeyToAction('Shift+E', null)).not.toBeNull();
  });

  it('未知键返回 null（不越权处理其他层键位）', () => {
    expect(foldKeyToAction('x' as never, 'b1')).toBeNull();
    expect(foldKeyToAction('j' as never, 'b1')).toBeNull(); // j/k 是滚动键（G-09），非折叠键
  });
});

describe('块级键位语义', () => {
  it('h 折叠（manual=true）；l 展开；e 双向 toggle', () => {
    let s = setup();
    s = reduceFoldKey(s, 'h', 'm1');
    expectBlock(s, 'm1', true, true);
    s = reduceFoldKey(s, 'l', 'm1');
    expectBlock(s, 'm1', false, true);
    s = reduceFoldKey(s, 'e', 'm1');
    expectBlock(s, 'm1', true, true);
    s = reduceFoldKey(s, 'e', 'm1');
    expectBlock(s, 'm1', false, true);
  });

  it('幽灵块（未注册）键位 no-op：返回原引用', () => {
    const s = setup();
    expect(reduceFoldKey(s, 'h', 'ghost')).toBe(s);
    expect(reduceFoldKey(s, 'e', 'ghost')).toBe(s);
  });

  it('reducer 纯度：折叠不改写原状态', () => {
    const s = setup();
    reduceFolds(s, { type: 'collapse', blockId: 't1' });
    expectBlock(s, 't1', true, false); // 原状态未被原地改写（manual 仍 false）
  });
});

describe('Shift+E 全部展开', () => {
  it('混合开合态 → 全部展开且 manual=true（批量用户动作）', () => {
    let s = setup();
    s = reduceFolds(s, { type: 'expandAll' });
    for (const id of ['t1', 'tool1', 'd1', 'm1']) expectBlock(s, id, false, true);
  });

  it('空账目 no-op（返回原引用）', () => {
    const s = emptyFoldsState();
    expect(reduceFolds(s, { type: 'expandAll' })).toBe(s);
  });
});

describe('Ctrl+E thinking 块开合', () => {
  it('存在展开态 thinking → 全部 thinking 收起，tool/diff/message 不动', () => {
    let s = setup();
    s = reduceFolds(s, { type: 'expand', blockId: 't1' });
    s = reduceFolds(s, { type: 'toggleThinking' });
    expectBlock(s, 't1', true, true);
    expectBlock(s, 'tool1', true, false); // 非 thinking 块不受影响（manual 也没被碰）
    expectBlock(s, 'm1', false, false);
  });

  it('thinking 全收 → 全部 thinking 展开', () => {
    let s = setup(); // t1 缺省收起
    s = reduceFolds(s, { type: 'toggleThinking' });
    expectBlock(s, 't1', false, true);
  });

  it('无 thinking 块 no-op（返回原引用）', () => {
    const s = reduceFolds(emptyFoldsState(), {
      type: 'register',
      blocks: [{ id: 'm1', kind: 'message', defaultCollapsed: false }],
    });
    expect(reduceFolds(s, { type: 'toggleThinking' })).toBe(s);
  });
});

describe('r 原始 markdown 视图', () => {
  it('全局开关：false → true → false，与折叠状态正交', () => {
    let s = setup();
    expect(s.rawMarkdown).toBe(false);
    s = reduceFoldKey(s, 'r', null);
    expect(s.rawMarkdown).toBe(true);
    expect(isCollapsed(s, 't1')).toBe(true); // 折叠态不受影响
    s = reduceFoldKey(s, 'r', 'whatever'); // 聚焦块有无均不影响全局键
    expect(s.rawMarkdown).toBe(false);
  });
});

describe('respect_manual_folds（自动折叠 vs 手动折叠）', () => {
  it('缺省 true：autoFold 跳过手动块，非手动块正常应用', () => {
    let s = setup(); // 缺省 respectManualFolds = true
    s = reduceFolds(s, { type: 'expand', blockId: 't1' }); // 用户手动展开
    s = reduceFolds(s, {
      type: 'autoFold',
      updates: [
        { blockId: 't1', collapsed: true }, // 想收手动展开的块
        { blockId: 'm1', collapsed: true }, // 想收缺省展开的普通块
      ],
    });
    expectBlock(s, 't1', false, true); // 手动折叠神圣不可侵犯
    expectBlock(s, 'm1', true, false); // 非手动块被自动折叠收起
  });

  it('autoFold 目标态与当前一致：no-op 返回原引用', () => {
    const s = setup(); // t1 已是折叠态
    expect(reduceFolds(s, { type: 'autoFold', updates: [{ blockId: 't1', collapsed: true }] })).toBe(s);
  });

  it('autoFold 幽灵块跳过', () => {
    const s = setup();
    expect(reduceFolds(s, { type: 'autoFold', updates: [{ blockId: 'ghost', collapsed: true }] })).toBe(s);
  });

  it('respectManualFolds=false：autoFold 覆盖手动块并清手动标记', () => {
    let s = setup(false); // 不尊重手动折叠
    s = reduceFolds(s, { type: 'expand', blockId: 't1' });
    expectBlock(s, 't1', false, true);
    s = reduceFolds(s, { type: 'autoFold', updates: [{ blockId: 't1', collapsed: true }] });
    expectBlock(s, 't1', true, false); // 被覆盖，manual 标记随之失效
  });

  it('setRespectManualFolds 切换；同值 no-op', () => {
    let s = setup();
    s = reduceFolds(s, { type: 'setRespectManualFolds', value: false });
    expect(s.respectManualFolds).toBe(false);
    expect(reduceFolds(s, { type: 'setRespectManualFolds', value: false })).toBe(s);
  });

  it('配置解析：布尔直出，其余 null（调用方回退缺省并告警）', () => {
    expect(parseRespectManualFolds(true)).toBe(true);
    expect(parseRespectManualFolds(false)).toBe(false);
    expect(parseRespectManualFolds('true')).toBeNull();
    expect(parseRespectManualFolds(1)).toBeNull();
    expect(parseRespectManualFolds(undefined)).toBeNull();
  });

  it('配置路径常量与规格记法一致', () => {
    expect(RESPECT_MANUAL_FOLDS_CONFIG_PATH).toBe('scrollback.scroll.respect_manual_folds');
  });
});

describe('isCollapsed 查询', () => {
  it('已注册块返回记账态；未注册块恒未折叠', () => {
    const s = setup();
    expect(isCollapsed(s, 't1')).toBe(true);
    expect(isCollapsed(s, 'm1')).toBe(false);
    expect(isCollapsed(s, 'ghost')).toBe(false);
  });
});
