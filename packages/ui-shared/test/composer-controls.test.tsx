// composer-controls 组件语义（Z3-04 / Z-94）：控件随 props 注入出现 / 缺省不渲染（web 壳口径）/
// 菜单内容与回调（选中打勾、其他 provider 模型、管理模型项、Plan↔单选联动）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer } from '../src/renderer/conversation/composer/Composer.js';
import type {
  ComposerModelSelectProps,
  ComposerModeSwitchProps,
  ComposerThoughtLevelProps,
} from '../src/renderer/conversation/composer/Composer.js';
import { ComposerStore, createComposerState } from '../src/renderer/conversation/composer/composer-state.js';
import { buildModelMenu } from '../src/renderer/conversation/composer/composer-config.js';
import { requestOpenComposerModelMenu } from '../src/renderer/conversation/composer/composer-menu-signal.js';

afterEach(cleanup);

const io = {
  createClientMessageId: () => 'cm-test',
  submit: () => undefined,
};

function renderComposer(props: {
  readonly modelSelect?: ComposerModelSelectProps;
  readonly modeSwitch?: ComposerModeSwitchProps;
  readonly thoughtLevel?: ComposerThoughtLevelProps;
}): void {
  render(
    <Composer
      sessionId="s1"
      store={new ComposerStore(createComposerState())}
      io={io}
      {...(props.modelSelect !== undefined ? { modelSelect: props.modelSelect } : {})}
      {...(props.modeSwitch !== undefined ? { modeSwitch: props.modeSwitch } : {})}
      {...(props.thoughtLevel !== undefined ? { thoughtLevel: props.thoughtLevel } : {})}
    />,
  );
}

const MENU = buildModelMenu({
  roles: { main: { channel: 'zai', model: 'glm-5.3' } },
  providers: {
    zai: { models: { 'glm-5.3': {}, 'glm-5-air': {} } },
    anthropic: { models: { 'claude-sonnet': {} } },
  },
});

function openMenu(testId: string): void {
  // Radix DropdownMenu trigger：Enter/Space keydown 打开（jsdom 无指针事件依赖）
  fireEvent.keyDown(screen.getByTestId(testId), { key: 'Enter' });
}

describe('props 缺省不渲染（web 壳无数据通道 = 控件整体不出现，不摆假控件）', () => {
  it('两个控件都不渲染；既有按钮（引用/附件/主按钮）不受影响', () => {
    renderComposer({});
    expect(screen.queryByTestId('composer-model-select')).toBeNull();
    expect(screen.queryByTestId('composer-mode-switch')).toBeNull();
    expect(screen.queryByTestId('composer-thought-level')).toBeNull();
    expect(screen.getByTestId('composer-reference')).toBeTruthy();
    expect(screen.getByTestId('composer-attach')).toBeTruthy();
    expect(screen.getByTestId('composer-primary')).toBeTruthy();
  });
});

describe('模型选择（右簇 ModelConfigSelect 对齐）', () => {
  it('trigger = provider 前缀 + 模型名；菜单含当前渠道全量（选中打勾）', () => {
    const onSelectModel = vi.fn();
    renderComposer({ modelSelect: { menu: MENU!, onSelectModel } });
    const trigger = screen.getByTestId('composer-model-select');
    expect(trigger.getAttribute('aria-label')).toBe('模型：zai · glm-5.3');
    openMenu('composer-model-select');
    const options = screen.getAllByTestId('composer-model-option');
    expect(options.map((o) => o.textContent)).toEqual(['glm-5-air', 'glm-5.3', 'claude-sonnet']);
    expect(options[0]?.getAttribute('data-selected')).toBeNull();
    expect(options[1]?.getAttribute('data-selected')).toBe('true'); // 选中打勾
    expect(options[2]?.getAttribute('data-selected')).toBeNull(); // 其他 provider 恒未选中
  });

  it('选择其他 provider 的模型：回调带上 channel（壳据此一并写 channel）', () => {
    const onSelectModel = vi.fn();
    renderComposer({ modelSelect: { menu: MENU!, onSelectModel } });
    openMenu('composer-model-select');
    fireEvent.click(screen.getAllByTestId('composer-model-option')[2]!);
    expect(onSelectModel).toHaveBeenCalledWith({ channel: 'anthropic', model: 'claude-sonnet' });
  });

  it('「管理模型」仅当壳提供入口时渲染；点击走回调', () => {
    const onManageModels = vi.fn();
    renderComposer({ modelSelect: { menu: MENU!, onSelectModel: vi.fn() } });
    openMenu('composer-model-select');
    expect(screen.queryByTestId('composer-model-manage')).toBeNull(); // web 壳口径：无通道不摆死入口
    cleanup();

    renderComposer({ modelSelect: { menu: MENU!, onSelectModel: vi.fn(), onManageModels } });
    openMenu('composer-model-select');
    fireEvent.click(screen.getByTestId('composer-model-manage'));
    expect(onManageModels).toHaveBeenCalledTimes(1);
  });
});

describe('模式切换（左簇 V4ComposerModeSwitch 对齐）', () => {
  it('trigger 显示当前单选模式；plan 生效时 trigger 出现灯泡标记', () => {
    const onModeChange = vi.fn();
    renderComposer({ modeSwitch: { mode: 'default', onModeChange } });
    expect(screen.getByTestId('composer-mode-switch').getAttribute('aria-label')).toBe('权限模式：默认');
    expect(screen.queryByTestId('composer-plan-marker')).toBeNull();
    cleanup();

    renderComposer({ modeSwitch: { mode: 'plan', onModeChange } });
    expect(screen.getByTestId('composer-mode-switch').getAttribute('aria-label')).toBe('权限模式：计划模式');
    expect(screen.getByTestId('composer-plan-marker')).toBeTruthy(); // Z-94：灯泡标记
  });

  it('菜单：Plan 复选框 + 权限单选组（图标+标题+描述，宽 w-64 由壳类承载）', () => {
    renderComposer({ modeSwitch: { mode: 'acceptEdits', onModeChange: vi.fn() } });
    openMenu('composer-mode-switch');
    expect(screen.getByTestId('composer-mode-plan').textContent).toContain('计划模式');
    expect(screen.getByTestId('composer-mode-plan').textContent).toContain('只读安全工具');
    expect(screen.getByTestId('composer-mode-default').textContent).toContain('每次工具调用都逐个请求批准');
    expect(screen.getByTestId('composer-mode-acceptEdits').textContent).toContain('自动放行编辑类工具');
    expect(screen.getByTestId('composer-mode-bypass').textContent).toContain('所有工具直接执行');
    // 单选选中态跟随 config（acceptEdits 选中）
    expect(screen.getByTestId('composer-mode-acceptEdits').getAttribute('data-state')).toBe('checked');
  });

  it('勾选 Plan → onModeChange("plan")；取消 → 回落记住的单选值（先 acceptEdits 再勾/取消）', () => {
    const onModeChange = vi.fn();
    const { rerender } = render(
      <Composer
        sessionId="s1"
        store={new ComposerStore(createComposerState())}
        io={io}
        modeSwitch={{ mode: 'acceptEdits', onModeChange }}
      />,
    );
    openMenu('composer-mode-switch');
    fireEvent.click(screen.getByTestId('composer-mode-plan'));
    expect(onModeChange).toHaveBeenCalledWith('plan');

    // 壳写盘后 config 回流 plan → 取消勾选 → 回落 acceptEdits（记忆 = 勾选前的单选值）
    rerender(
      <Composer
        sessionId="s1"
        store={new ComposerStore(createComposerState())}
        io={io}
        modeSwitch={{ mode: 'plan', onModeChange }}
      />,
    );
    openMenu('composer-mode-switch');
    expect(screen.getByTestId('composer-mode-plan').getAttribute('data-state')).toBe('checked');
    // plan 生效时单选组不显示选中态（显示任何单选选中都是假状态）
    expect(screen.getByTestId('composer-mode-bypass').getAttribute('data-state')).not.toBe('checked');
    fireEvent.click(screen.getByTestId('composer-mode-plan'));
    expect(onModeChange).toHaveBeenLastCalledWith('acceptEdits');
  });

  it('plan 生效中点单选 = 退出 plan 并落到该值', () => {
    const onModeChange = vi.fn();
    renderComposer({ modeSwitch: { mode: 'plan', onModeChange } });
    openMenu('composer-mode-switch');
    fireEvent.click(screen.getByTestId('composer-mode-bypass'));
    expect(onModeChange).toHaveBeenCalledWith('bypass');
  });
});

describe('思考档位（右簇 ThoughtLevelCycleControl 同族下拉）', () => {
  it('trigger 显示当前档位标签（已知名映射中文）；菜单列出全部档位（顺序来自声明）', () => {
    renderComposer({
      thoughtLevel: { current: 'high', values: ['low', 'medium', 'high', 'xhigh'], onSelectLevel: vi.fn() },
    });
    expect(screen.getByTestId('composer-thought-level').getAttribute('aria-label')).toBe('思考档位：高');
    openMenu('composer-thought-level');
    const options = screen.getAllByTestId('composer-thought-level-option');
    expect(options.map((o) => o.textContent)).toEqual(['低', '中', '高', '极高']);
  });

  it('选择某档位 → onSelectLevel 带其原始值（非展示标签）', () => {
    const onSelectLevel = vi.fn();
    renderComposer({
      thoughtLevel: { current: 'low', values: ['low', 'medium', 'high'], onSelectLevel },
    });
    openMenu('composer-thought-level');
    fireEvent.click(screen.getAllByTestId('composer-thought-level-option')[2]!);
    expect(onSelectLevel).toHaveBeenCalledWith('high');
  });

  it('未知档位名原样显示（不臆造中文枚举）', () => {
    renderComposer({ thoughtLevel: { current: 'turbo', values: ['turbo'], onSelectLevel: vi.fn() } });
    expect(screen.getByTestId('composer-thought-level').getAttribute('aria-label')).toBe('思考档位：turbo');
  });
});

describe('Ctrl+M openModelMenu（共享信号总线打开模型菜单）', () => {
  it('广播打开信号 → 模型菜单展开（受控 open，不新增业务状态）', () => {
    renderComposer({ modelSelect: { menu: MENU!, onSelectModel: vi.fn() } });
    expect(screen.queryByTestId('composer-model-menu')).toBeNull();
    act(() => requestOpenComposerModelMenu());
    expect(screen.getByTestId('composer-model-menu')).toBeTruthy();
  });

  it('未挂载模型选择时广播 = no-op（不报错）', () => {
    renderComposer({});
    expect(() => act(() => requestOpenComposerModelMenu())).not.toThrow();
  });
});
