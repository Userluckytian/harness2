// composer-config 纯语义（Z3-04 / Z-94）：模型菜单构造（当前渠道组 + 其他 provider 组 +
// 管理外如实的「当前值不在目录」补行）、Plan↔mode 双向映射与回落、patch 形状。
import { describe, expect, it } from 'vitest';
import {
  COMPOSER_APPROVAL_ITEMS,
  COMPOSER_PLAN_ITEM,
  approvalModePatch,
  buildModelMenu,
  buildThoughtLevel,
  decidePlanToggle,
  decideRadioSelect,
  displayApprovalMode,
  firstAvailableModel,
  isPlanMode,
  isRadioApprovalMode,
  modelSelectionPatch,
  modelTriggerLabel,
  nextApprovalMode,
  nextThoughtLevel,
  thoughtLevelLabel,
  thoughtLevelPatch,
  type ComposerConfigSnapshot,
} from '../src/renderer/conversation/composer/composer-config.js';

function config(partial: Partial<ComposerConfigSnapshot>): ComposerConfigSnapshot {
  return {
    roles: { main: { channel: 'zai', model: 'glm-5.3' } },
    providers: { zai: { models: { 'glm-5.3': {}, 'glm-5-air': {} } } },
    approval: { mode: 'default' },
    ...partial,
  };
}

describe('模型菜单构造（Z-94 ModelConfigSelect）', () => {
  it('当前渠道组全量列出（字典序），选中态跟随 config 当前值', () => {
    const menu = buildModelMenu(config({}));
    expect(menu).toBeDefined();
    expect(menu?.current).toEqual({ channel: 'zai', model: 'glm-5.3' });
    expect(menu?.groups).toHaveLength(1);
    expect(menu?.groups[0]?.channel).toBe('zai');
    expect(menu?.groups[0]?.items.map((i) => `${i.model}:${i.selected}`)).toEqual(['glm-5-air:false', 'glm-5.3:true']);
  });

  it('当前值不在目录中 → 如实补进组首并标选中（数据来自 config，不伪造条目）', () => {
    const menu = buildModelMenu(config({ roles: { main: { channel: 'zai', model: '未声明模型' } } }));
    expect(menu?.groups[0]?.items[0]).toEqual({ channel: 'zai', model: '未声明模型', selected: true });
    expect(menu?.groups[0]?.items).toHaveLength(3); // 补行 + 两个声明模型
  });

  it('其他 provider 的声明模型纳入菜单（选中恒 false，跨渠道选择 = channel 一并写）', () => {
    const menu = buildModelMenu(
      config({
        providers: {
          zai: { models: { 'glm-5.3': {} } },
          anthropic: { models: { 'claude-sonnet': {} } },
          无目录渠道: {}, // 未声明 models → 不列空组
        },
      }),
    );
    expect(menu?.groups.map((g) => g.channel)).toEqual(['zai', 'anthropic']);
    const other = menu?.groups[1];
    expect(other?.items).toEqual([{ channel: 'anthropic', model: 'claude-sonnet', selected: false }]);
  });

  it('roles.main 缺失（未给回落）→ undefined（没有「当前模型」可如实展示，控件不渲染）', () => {
    expect(buildModelMenu(config({ roles: {} }))).toBeUndefined();
    expect(buildModelMenu({})).toBeUndefined();
  });

  it('roles.main 缺失 + 给回落 → 菜单 current = 回落值（3b 初值回落口径）', () => {
    const menu = buildModelMenu(config({ roles: {} }), { channel: 'zai', model: 'glm-5-air' });
    expect(menu?.current).toEqual({ channel: 'zai', model: 'glm-5-air' });
    expect(menu?.groups[0]?.items.find((i) => i.selected)?.model).toBe('glm-5-air');
  });

  it('roles.main 存在 → 回落参数不参与（磁盘真值优先）', () => {
    const menu = buildModelMenu(config({}), { channel: 'other', model: 'ignored' });
    expect(menu?.current).toEqual({ channel: 'zai', model: 'glm-5.3' });
  });

  it('3b：当前值展示为「渠道/模型」全名（trigger = provider 前缀 + 模型名）', () => {
    expect(modelTriggerLabel({ channel: 'buddyhub', model: 'global:deepseek-v4.1-flash' })).toBe(
      'buddyhub · global:deepseek-v4.1-flash',
    );
  });

  it('当前渠道未声明 models → 仍如实展示当前值（组内只有补行），不臆造目录', () => {
    const menu = buildModelMenu(config({ providers: { zai: {} } }));
    expect(menu?.groups[0]?.items).toEqual([{ channel: 'zai', model: 'glm-5.3', selected: true }]);
  });

  it('trigger 文案 = provider 前缀 + 模型名（Z-94）', () => {
    expect(modelTriggerLabel({ channel: 'zai', model: 'glm-5.3' })).toBe('zai · glm-5.3');
  });
});

describe('firstAvailableModel（3b 回落：providers 列表首项）', () => {
  it('渠道名升序取首个有 models 的渠道，模型名升序取首项', () => {
    const got = firstAvailableModel({
      providers: {
        zai: { models: { 'glm-5-air': {}, 'glm-5.3': {} } },
        anthropic: { models: { 'claude-sonnet': {} } },
        空渠道: {}, // 无 models → 跳过
      },
    });
    expect(got).toEqual({ channel: 'anthropic', model: 'claude-sonnet' });
  });

  it('同渠道多模型 → 字典序首项（与菜单排序口径一致）', () => {
    expect(firstAvailableModel({ providers: { zai: { models: { 'glm-5-air': {}, 'glm-5.3': {} } } } })).toEqual({
      channel: 'zai',
      model: 'glm-5-air',
    });
  });

  it('无任何 provider/models → undefined（无从选择，控件仍不渲染）', () => {
    expect(firstAvailableModel({})).toBeUndefined();
    expect(firstAvailableModel({ providers: { a: {} } })).toBeUndefined();
  });
});

describe('模型切换 patch（同渠道只写 model；跨渠道 channel 一并写）', () => {
  it('同渠道：只写 model，channel 字段不进 patch（深合并语义下不覆盖不丢失）', () => {
    const patch = modelSelectionPatch({ channel: 'zai', model: 'glm-5.3' }, { channel: 'zai', model: 'glm-5-air' });
    expect(patch).toEqual({ roles: { main: { channel: 'zai', model: 'glm-5-air' } } });
  });

  it('跨渠道：channel 与 model 都写', () => {
    const patch = modelSelectionPatch(
      { channel: 'zai', model: 'glm-5.3' },
      { channel: 'anthropic', model: 'claude-sonnet' },
    );
    expect(patch).toEqual({ roles: { main: { channel: 'anthropic', model: 'claude-sonnet' } } });
  });
});

describe('权限模式映射（Z-94 V4ComposerModeSwitch：Plan 复选框 + 单选组）', () => {
  it('plan 判定：仅 mode==="plan" 为真；未知值/未设置按 default 展示（core 缺省，不臆造）', () => {
    expect(isPlanMode('plan')).toBe(true);
    expect(isPlanMode('default')).toBe(false);
    expect(isPlanMode(undefined)).toBe(false);
    expect(displayApprovalMode(undefined)).toBe('default');
    expect(displayApprovalMode('acceptEdits')).toBe('acceptEdits');
    expect(displayApprovalMode('plan')).toBe('plan');
    expect(displayApprovalMode('什么都不是')).toBe('default');
  });

  it('单选值守卫：三单选值为真，plan/未知为假', () => {
    expect(isRadioApprovalMode('default')).toBe(true);
    expect(isRadioApprovalMode('acceptEdits')).toBe(true);
    expect(isRadioApprovalMode('bypass')).toBe(true);
    expect(isRadioApprovalMode('plan')).toBe(false);
    expect(isRadioApprovalMode(undefined)).toBe(false);
  });

  it('勾 Plan：写 plan，并记住勾选前生效的单选值（config 当前值优先）', () => {
    const d = decidePlanToggle('acceptEdits', 'default', true);
    expect(d.mode).toBe('plan');
    expect(d.rememberedRadio).toBe('acceptEdits'); // 记住 config 当前值，不用旧记忆
  });

  it('勾 Plan（config 已是 plan / 未知值）：记忆优先，兜底 default', () => {
    expect(decidePlanToggle('plan', 'bypass', true)).toEqual({ mode: 'plan', rememberedRadio: 'bypass' });
    expect(decidePlanToggle(undefined, undefined, true)).toEqual({ mode: 'plan', rememberedRadio: 'default' });
  });

  it('取消 Plan：回落到记住的单选值', () => {
    const d = decidePlanToggle('plan', 'bypass', false);
    expect(d.mode).toBe('bypass');
    expect(d.rememberedRadio).toBe('bypass');
  });

  it('取消 Plan 而无记忆：按 config 当前值回落；两者皆无 → default', () => {
    expect(decidePlanToggle('plan', undefined, false)).toEqual({ mode: 'default', rememberedRadio: 'default' });
    expect(decidePlanToggle('acceptEdits', undefined, false)).toEqual({
      mode: 'acceptEdits',
      rememberedRadio: 'acceptEdits',
    });
  });

  it('单选选择：写该值并校准记忆（plan 中点单选 = 退出 plan）', () => {
    expect(decideRadioSelect('acceptEdits')).toEqual({ mode: 'acceptEdits', rememberedRadio: 'acceptEdits' });
  });

  it('patch 形状：写 approval.mode（走同一 settings:updateConfig）', () => {
    expect(approvalModePatch('plan')).toEqual({ approval: { mode: 'plan' } });
    expect(approvalModePatch('bypass')).toEqual({ approval: { mode: 'bypass' } });
  });

  it('菜单元数据用 core 审批服务的真实语义（逐工具审批 / 编辑类放行 / 全部放行）', () => {
    expect(COMPOSER_PLAN_ITEM).toMatchObject({ mode: 'plan', title: '计划模式' });
    expect(COMPOSER_APPROVAL_ITEMS.map((i) => i.mode)).toEqual(['default', 'acceptEdits', 'bypass']);
    expect(COMPOSER_APPROVAL_ITEMS.map((i) => i.title)).toEqual(['默认', '自动接受编辑', '全部放行']);
    expect(COMPOSER_APPROVAL_ITEMS[0]?.description).toContain('逐个');
    expect(COMPOSER_APPROVAL_ITEMS[1]?.description).toContain('编辑类工具');
    expect(COMPOSER_APPROVAL_ITEMS[2]?.description).toContain('不再请求批准');
  });

  it('模式循环（cycleSessionMode）：default → acceptEdits → bypass → plan → default 回绕', () => {
    expect(nextApprovalMode('default')).toBe('acceptEdits');
    expect(nextApprovalMode('acceptEdits')).toBe('bypass');
    expect(nextApprovalMode('bypass')).toBe('plan');
    expect(nextApprovalMode('plan')).toBe('default');
    // 未设置/未知值按 core 缺省 default 起算（不臆造起点）
    expect(nextApprovalMode(undefined)).toBe('acceptEdits');
    expect(nextApprovalMode('什么都不是')).toBe('acceptEdits');
  });
});

describe('思考档位（Z-94 ThoughtLevelCycleControl；数据源 = roles.main.effort + 模型 reasoning.values）', () => {
  const withReasoning = (partial: Partial<ComposerConfigSnapshot> = {}): ComposerConfigSnapshot =>
    config({
      providers: {
        zai: {
          models: {
            'glm-5.3': { reasoning: { values: ['low', 'medium', 'high', 'xhigh'], default: 'medium' } },
            'glm-5-air': {},
          },
        },
      },
      ...partial,
    });

  it('档位取值来自模型声明（顺序即菜单顺序），未自造枚举', () => {
    const level = buildThoughtLevel(withReasoning());
    expect(level?.values).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('当前值：config 显式 effort 优先（explicit=true）', () => {
    const level = buildThoughtLevel(
      withReasoning({ roles: { main: { channel: 'zai', model: 'glm-5.3', effort: 'high' } } }),
    );
    expect(level).toEqual({ current: 'high', values: ['low', 'medium', 'high', 'xhigh'], explicit: true });
  });

  it('未设置 effort → 用模型 reasoning.default（explicit=false）；default 不在 values 内则回落首档', () => {
    expect(buildThoughtLevel(withReasoning())?.current).toBe('medium');
    expect(buildThoughtLevel(withReasoning())?.explicit).toBe(false);
    const noDefault = config({
      providers: { zai: { models: { 'glm-5.3': { reasoning: { values: ['a', 'b'] } } } } },
    });
    expect(buildThoughtLevel(noDefault)?.current).toBe('a');
    const badDefault = config({
      providers: { zai: { models: { 'glm-5.3': { reasoning: { values: ['a', 'b'], default: 'z' } } } } },
    });
    expect(buildThoughtLevel(badDefault)?.current).toBe('a');
  });

  it('模型未声明 reasoning / 角色缺失 / 值为空 → undefined（无档位可选，控件不渲染）', () => {
    expect(buildThoughtLevel(config({ providers: { zai: { models: { 'glm-5.3': {} } } } }))).toBeUndefined();
    expect(buildThoughtLevel(config({ roles: {} }))).toBeUndefined();
    expect(
      buildThoughtLevel(config({ providers: { zai: { models: { 'glm-5.3': { reasoning: { values: [] } } } } } })),
    ).toBeUndefined();
  });

  it('档位循环：values 顺序向后一格回绕；不足两档返回 undefined', () => {
    expect(nextThoughtLevel('low', ['low', 'medium', 'high'])).toBe('medium');
    expect(nextThoughtLevel('high', ['low', 'medium', 'high'])).toBe('low');
    // 当前值不在清单（外部改过 config）→ 从首档起
    expect(nextThoughtLevel('未知', ['low', 'high'])).toBe('low');
    expect(nextThoughtLevel('low', ['low'])).toBeUndefined();
  });

  it('档位标签：已知名映射中文，未知值原样显示 provider 档位名', () => {
    expect(thoughtLevelLabel('off')).toBe('关闭');
    expect(thoughtLevelLabel('XHIGH')).toBe('极高');
    expect(thoughtLevelLabel('max')).toBe('最高');
    expect(thoughtLevelLabel('provider-private-name')).toBe('provider-private-name');
  });

  it('档位 patch：带 channel/model（深合并，其余角色字段不丢）', () => {
    expect(thoughtLevelPatch('main', { channel: 'zai', model: 'glm-5.3' }, 'high')).toEqual({
      roles: { main: { channel: 'zai', model: 'glm-5.3', effort: 'high' } },
    });
  });
});
