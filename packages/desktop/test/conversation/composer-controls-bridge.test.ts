// composer-controls-bridge（Z3-04）：config → composer 控件 props 的装配与写回。
// 覆盖：读装配（菜单构造/角色缺失不渲染）、写回 patch 形状、响应回带 config 刷新缓存、
// 失败如实不静默、首载幂等（多席位共享一次 IPC）、桥缺失不破坏渲染。
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Harness2Api, SettingsConfigShape } from '../../src/shared/protocol.js';
import { toastStore } from '@harness2/ui-shared/renderer/toast/index.js';
import {
  _resetComposerConfigForTest,
  composerControlsOf,
  cycleComposerMode,
  cycleComposerThoughtLevel,
  loadComposerConfig,
  peekComposerConfig,
  subscribeComposerConfig,
} from '../../src/renderer/conversation/composer-controls-bridge.js';

function configOf(overrides: Partial<SettingsConfigShape> = {}): SettingsConfigShape {
  return {
    providers: {
      zai: { protocol: 'openai', baseUrl: 'https://api.example.com', models: { 'glm-5.3': {}, 'glm-5-air': {} } },
      anthropic: { protocol: 'anthropic', baseUrl: 'https://api.example.com', models: { 'claude-sonnet': {} } },
    },
    roles: { main: { channel: 'zai', model: 'glm-5.3' } },
    approval: { mode: 'default' },
    memory: { mode: 'off', nudgeInterval: 10 },
    browser: { enabled: true, idleDestroyMs: 1, maxConcurrent: 1 },
    plugins: { enabled: true, allow: [] },
    mcpServers: {},
    subagent: { maxDepth: 1, maxTurns: 1 },
    sources: { global: false, project: false },
    warnings: [],
    errors: [],
    ...overrides,
  };
}

function setWindowApi(api: Partial<Harness2Api>): {
  getConfig: ReturnType<typeof vi.fn>;
  updateConfig: ReturnType<typeof vi.fn>;
} {
  const getConfig = (api.settingsGetConfig ?? vi.fn(async () => configOf())) as ReturnType<typeof vi.fn>;
  const updateConfig = (api.settingsUpdateConfig ?? vi.fn(async () => ({ ok: true as const }))) as ReturnType<
    typeof vi.fn
  >;
  (window as unknown as { harness2: unknown }).harness2 = {
    settingsGetConfig: getConfig,
    settingsUpdateConfig: updateConfig,
  };
  return { getConfig, updateConfig };
}

beforeEach(() => {
  _resetComposerConfigForTest();
  setWindowApi({});
});

describe('composerControlsOf：config → 控件 props 装配', () => {
  it('config 未载入（null）→ 空对象（控件整体不渲染）', () => {
    expect(composerControlsOf(null)).toEqual({});
  });

  it('roles.main 存在 → modelSelect（菜单含当前渠道 + 其他 provider）+ modeSwitch（approval 原值）', () => {
    const controls = composerControlsOf(configOf());
    expect(controls.modeSwitch?.mode).toBe('default');
    const menu = controls.modelSelect?.menu;
    expect(menu?.current).toEqual({ channel: 'zai', model: 'glm-5.3' });
    expect(menu?.groups.map((g) => g.channel)).toEqual(['zai', 'anthropic']);
    // 桌面壳有设置弹窗 → 「管理模型」入口存在（直达模型配置分区）
    expect(typeof controls.modelSelect?.onManageModels).toBe('function');
  });

  it('roles.main 缺失 → 不出 modelSelect（没有「当前模型」可如实展示）；modeSwitch 仍可切换', () => {
    const controls = composerControlsOf(configOf({ roles: {} }));
    expect(controls.modelSelect).toBeUndefined();
    expect(controls.modeSwitch?.mode).toBe('default');
  });

  it('approval.mode 缺失（运行期 JSON 可省略；类型面声明为必有）→ modeSwitch 以 undefined 传入（UI 按 core 缺省 default 展示，不臆造）', () => {
    const controls = composerControlsOf({
      ...configOf(),
      // 模拟「config.json 里 approval 对象存在但没有 mode 字段」的运行期形状（桥按 ?. 读取）
      approval: {} as unknown as SettingsConfigShape['approval'],
    });
    expect(controls.modeSwitch?.mode).toBeUndefined();
  });

  it('模型声明 reasoning.values → 出 thoughtLevel（档位集合来自声明；当前值按 effort/缺省）', () => {
    const controls = composerControlsOf(
      configOf({
        providers: {
          zai: {
            protocol: 'openai',
            baseUrl: 'https://api.example.com',
            models: { 'glm-5.3': { reasoning: { values: ['low', 'high', 'xhigh'], default: 'high' } } },
          },
        },
        roles: { main: { channel: 'zai', model: 'glm-5.3', effort: 'xhigh' } },
      }),
    );
    expect(controls.thoughtLevel?.current).toBe('xhigh');
    expect(controls.thoughtLevel?.values).toEqual(['low', 'high', 'xhigh']);
    expect(typeof controls.thoughtLevel?.onSelectLevel).toBe('function');
  });

  it('模型未声明 reasoning → 不出 thoughtLevel（无档位可选，不摆控件）', () => {
    expect(composerControlsOf(configOf()).thoughtLevel).toBeUndefined();
  });
});

describe('写回链路：patch 形状 + 响应回带 config 刷新（无第二次 IPC）', () => {
  it('onSelectModel → settings:updateConfig 收到 roles.main patch；缓存刷新有通知', async () => {
    const controls = composerControlsOf(configOf());
    const updateConfig = vi.fn(async () => ({
      ok: true as const,
      config: configOf({ roles: { main: { channel: 'anthropic', model: 'claude-sonnet' } } }),
    }));
    setWindowApi({ settingsUpdateConfig: updateConfig });

    const listener = vi.fn();
    const unsubscribe = subscribeComposerConfig(listener);
    await controls.modelSelect!.onSelectModel({ channel: 'anthropic', model: 'claude-sonnet' });

    expect(updateConfig).toHaveBeenCalledWith({ roles: { main: { channel: 'anthropic', model: 'claude-sonnet' } } });
    expect(listener).toHaveBeenCalled(); // 缓存刷新有通知（订阅者重渲 → 菜单选中态更新）
    expect(peekComposerConfig()?.roles.main).toEqual({ channel: 'anthropic', model: 'claude-sonnet' });
    unsubscribe();
  });

  it('onModeChange → patch { approval: { mode } }；plan 也走同一通道', async () => {
    const controls = composerControlsOf(configOf());
    const updateConfig = vi.fn(async () => ({ ok: true as const, config: configOf({ approval: { mode: 'plan' } }) }));
    setWindowApi({ settingsUpdateConfig: updateConfig });
    await controls.modeSwitch!.onModeChange('plan');
    expect(updateConfig).toHaveBeenCalledWith({ approval: { mode: 'plan' } });
  });

  it('写回失败（ok=false）→ 桥层 console.error 如实记录 + 全局 Toast（Z10-8b 接入），不伪造成功', async () => {
    toastStore.clear();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const controls = composerControlsOf(configOf());
    setWindowApi({ settingsUpdateConfig: vi.fn(async () => ({ ok: false as const, error: '不允许的配置字段 x' })) });
    await controls.modeSwitch!.onModeChange('bypass');
    // 回调是 fire-and-forget（void …catch(logPatchError)）→ 失败落定在后续微任务，先排空再断言
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(errorSpy).toHaveBeenCalled();
    // Z10-8b：原来只 console.error（等同静默）→ 现在如实弹一条 error Toast
    const items = toastStore.getSnapshot();
    expect(items.some((t) => t.kind === 'error' && t.message === '设置保存失败')).toBe(true);
    expect(items.find((t) => t.message === '设置保存失败')?.detail).toContain('不允许的配置字段 x');
    errorSpy.mockRestore();
    toastStore.clear();
  });
});

describe('loadComposerConfig：首载 + 幂等（多席位共享一次 IPC）', () => {
  it('并发/多次 load 只触发一次 settingsGetConfig', async () => {
    const { getConfig } = setWindowApi({});
    await Promise.all([loadComposerConfig(), loadComposerConfig(), loadComposerConfig()]);
    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(peekComposerConfig()).toEqual(configOf());
    // 已有缓存再 load = 不再发 IPC
    await loadComposerConfig();
    expect(getConfig).toHaveBeenCalledTimes(1);
  });

  it('桥缺失（settingsGetConfig 不是函数）→ 如实记录且不缓存（下次可重试），不抛出破坏渲染', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (window as unknown as { harness2: Record<string, unknown> }).harness2 = {};
    await loadComposerConfig();
    expect(errorSpy).toHaveBeenCalled();
    expect(peekComposerConfig()).toBeNull();
    errorSpy.mockRestore();
  });
});

describe('快捷键写路径（Ctrl+Shift+M / Ctrl+T 复用同一 config 通道）', () => {
  const cyclingConfig = (): SettingsConfigShape =>
    configOf({
      providers: {
        zai: {
          protocol: 'openai',
          baseUrl: 'https://api.example.com',
          models: { 'glm-5.3': { reasoning: { values: ['low', 'high', 'xhigh'], default: 'low' } } },
        },
      },
      roles: { main: { channel: 'zai', model: 'glm-5.3', effort: 'high' } },
    });

  it('config 未载入 → 两条循环均 no-op（不臆造起点、不发写请求）', () => {
    const { updateConfig } = setWindowApi({});
    cycleComposerMode();
    cycleComposerThoughtLevel();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('cycleComposerMode → 写 approval.mode 的下一个模式', async () => {
    const updateConfig = vi.fn(async () => ({ ok: true as const, config: configOf() }));
    setWindowApi({ settingsGetConfig: vi.fn(async () => cyclingConfig()), settingsUpdateConfig: updateConfig });
    await loadComposerConfig();
    cycleComposerMode();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updateConfig).toHaveBeenCalledWith({ approval: { mode: 'acceptEdits' } });
  });

  it('cycleComposerThoughtLevel → 写 roles.main.effort 的下一档', async () => {
    const updateConfig = vi.fn(async () => ({ ok: true as const, config: cyclingConfig() }));
    setWindowApi({ settingsGetConfig: vi.fn(async () => cyclingConfig()), settingsUpdateConfig: updateConfig });
    await loadComposerConfig();
    cycleComposerThoughtLevel();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updateConfig).toHaveBeenCalledWith({
      roles: { main: { channel: 'zai', model: 'glm-5.3', effort: 'xhigh' } },
    });
  });

  it('模型未声明档位 → cycleComposerThoughtLevel no-op', async () => {
    const updateConfig = vi.fn(async () => ({ ok: true as const }));
    setWindowApi({ settingsGetConfig: vi.fn(async () => configOf()), settingsUpdateConfig: updateConfig });
    await loadComposerConfig();
    cycleComposerThoughtLevel();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
