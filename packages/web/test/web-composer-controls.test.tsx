// web-composer-controls（Z10-2b）：web 侧 composer 控件数据桥 —— serve 设置端口装配、写回，
// 以及「思考档位」装配（模型声明 reasoning.values 才出控件；Ctrl+T 循环写回 roles.main.effort）。
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsConfigShape } from '@harness2/ui-shared/shared/settings.js';
import {
  _resetWebComposerConfigForTest,
  loadWebComposerConfig,
  peekWebComposerConfig,
  webComposerControlsOf,
  webCycleComposerMode,
  webCycleComposerThoughtLevel,
} from '../src/web-composer-controls.js';
import type { WebSettingsDataPorts } from '../src/web-settings.js';

function configOf(overrides: Partial<SettingsConfigShape> = {}): SettingsConfigShape {
  return {
    providers: { zai: { protocol: 'openai', baseUrl: 'https://api.example.com', models: { 'glm-5.3': {} } } },
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

function portsOf(
  getConfig: () => Promise<SettingsConfigShape>,
  updateConfig: (
    patch: Record<string, unknown>,
  ) => Promise<{ ok: boolean; config?: SettingsConfigShape; error?: string }>,
): WebSettingsDataPorts {
  return { getConfig, updateConfig } as unknown as WebSettingsDataPorts;
}

beforeEach(() => {
  _resetWebComposerConfigForTest();
});

describe('webComposerControlsOf：serve config 视图 → 控件 props', () => {
  it('config 未载入（null）→ 空对象（控件不渲染）', () => {
    expect(
      webComposerControlsOf(
        null,
        portsOf(
          async () => configOf(),
          async () => ({ ok: true }),
        ),
      ),
    ).toEqual({});
  });

  it('roles.main 存在 → modelSelect（无「管理模型」入口，web 无直达设置分区通道）+ modeSwitch', () => {
    const ports = portsOf(
      async () => configOf(),
      async () => ({ ok: true }),
    );
    const controls = webComposerControlsOf(configOf(), ports);
    expect(controls.modeSwitch?.mode).toBe('default');
    expect(controls.modelSelect?.menu.current).toEqual({ channel: 'zai', model: 'glm-5.3' });
    // web 无「打开设置直达模型分区」通道 → 不摆死入口
    expect(controls.modelSelect?.onManageModels).toBeUndefined();
  });

  it('模型声明 reasoning.values → 出 thoughtLevel（current 取 roles.main.effort）', () => {
    const config = configOf({
      providers: {
        zai: {
          protocol: 'openai',
          baseUrl: 'https://api.example.com',
          models: { 'glm-5.3': { reasoning: { values: ['low', 'high'], default: 'low' } } },
        },
      },
      roles: { main: { channel: 'zai', model: 'glm-5.3', effort: 'high' } },
    });
    const controls = webComposerControlsOf(
      config,
      portsOf(
        async () => config,
        async () => ({ ok: true }),
      ),
    );
    expect(controls.thoughtLevel?.current).toBe('high');
    expect(controls.thoughtLevel?.values).toEqual(['low', 'high']);
  });

  it('反向钉：模型未声明 reasoning.values → 不出 thoughtLevel（无档位可选不摆控件）', () => {
    const config = configOf({
      providers: {
        zai: {
          protocol: 'openai',
          baseUrl: 'https://api.example.com',
          models: { 'glm-5.3': { contextWindow: 128000 } },
        },
      },
      roles: { main: { channel: 'zai', model: 'glm-5.3' } },
    });
    const controls = webComposerControlsOf(
      config,
      portsOf(
        async () => config,
        async () => ({ ok: true }),
      ),
    );
    expect('thoughtLevel' in controls).toBe(false);
  });

  it('未显式设置 effort 时按模型 default 展示（explicit=false 由 buildThoughtLevel 内部决定）', () => {
    const config = configOf({
      providers: {
        zai: {
          protocol: 'openai',
          baseUrl: 'https://api.example.com',
          models: { 'glm-5.3': { reasoning: { values: ['low', 'high'], default: 'high' } } },
        },
      },
      roles: { main: { channel: 'zai', model: 'glm-5.3' } },
    });
    const controls = webComposerControlsOf(
      config,
      portsOf(
        async () => config,
        async () => ({ ok: true }),
      ),
    );
    expect(controls.thoughtLevel?.current).toBe('high');
  });

  it('roles.main 缺失 → 不出 modelSelect；modeSwitch 仍可切换', () => {
    const ports = portsOf(
      async () => configOf(),
      async () => ({ ok: true }),
    );
    const controls = webComposerControlsOf(configOf({ roles: {} }), ports);
    expect(controls.modelSelect).toBeUndefined();
    expect(controls.modeSwitch?.mode).toBe('default');
  });
});

describe('写回链路：PUT /api/settings/config + 响应回带视图刷新缓存', () => {
  it('首载幂等（并发共享一次 getConfig）；写回用响应 config 刷新', async () => {
    const next = configOf({ approval: { mode: 'bypass' } });
    const getConfig = vi.fn(async () => configOf());
    const updateConfig = vi.fn(async () => ({ ok: true, config: next }));
    const ports = portsOf(getConfig, updateConfig);
    await Promise.all([loadWebComposerConfig(ports), loadWebComposerConfig(ports)]);
    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(peekWebComposerConfig()).toEqual(configOf());

    const controls = webComposerControlsOf(peekWebComposerConfig(), ports);
    await controls.modeSwitch!.onModeChange('bypass');
    expect(updateConfig).toHaveBeenCalledWith({ approval: { mode: 'bypass' } });
    expect(peekWebComposerConfig()?.approval.mode).toBe('bypass');
  });

  it('onSelectModel → PUT roles.main patch', async () => {
    const updateConfig = vi.fn(async () => ({ ok: true, config: configOf() }));
    const ports = portsOf(async () => configOf(), updateConfig);
    const controls = webComposerControlsOf(configOf(), ports);
    await controls.modelSelect!.onSelectModel({ channel: 'zai', model: 'glm-5.3' });
    expect(updateConfig).toHaveBeenCalledWith({ roles: { main: { channel: 'zai', model: 'glm-5.3' } } });
  });

  it('onSelectLevel → PUT roles.main patch（含 channel/model/effort）', async () => {
    const config = configOf({
      providers: {
        zai: {
          protocol: 'openai',
          baseUrl: 'https://api.example.com',
          models: { 'glm-5.3': { reasoning: { values: ['low', 'high'] } } },
        },
      },
      roles: { main: { channel: 'zai', model: 'glm-5.3', effort: 'low' } },
    });
    const updateConfig = vi.fn(async () => ({ ok: true, config }));
    const ports = portsOf(async () => config, updateConfig);
    const controls = webComposerControlsOf(config, ports);
    await controls.thoughtLevel!.onSelectLevel('high');
    expect(updateConfig).toHaveBeenCalledWith({
      roles: { main: { channel: 'zai', model: 'glm-5.3', effort: 'high' } },
    });
  });

  it('写回失败（ok=false）→ 如实记录，不伪造成功', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ports = portsOf(
      async () => configOf(),
      async () => ({ ok: false, error: '不允许的配置字段 x' }),
    );
    const controls = webComposerControlsOf(configOf(), ports);
    await controls.modeSwitch!.onModeChange('bypass');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('webCycleComposerMode（Ctrl+Shift+M）：复用同一 PUT 写路径', () => {
  it('端口缺失 → no-op', () => {
    expect(() => webCycleComposerMode(undefined)).not.toThrow();
  });

  it('已载入 config → 写下一模式', async () => {
    const updateConfig = vi.fn(async () => ({ ok: true, config: configOf({ approval: { mode: 'acceptEdits' } }) }));
    const ports = portsOf(async () => configOf(), updateConfig);
    await loadWebComposerConfig(ports);
    webCycleComposerMode(ports);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updateConfig).toHaveBeenCalledWith({ approval: { mode: 'acceptEdits' } });
  });
});

describe('webCycleComposerThoughtLevel（Ctrl+T）：复用同一 PUT 写路径', () => {
  function reasonedConfig(): SettingsConfigShape {
    return configOf({
      providers: {
        zai: {
          protocol: 'openai',
          baseUrl: 'https://api.example.com',
          models: { 'glm-5.3': { reasoning: { values: ['low', 'high'] } } },
        },
      },
      roles: { main: { channel: 'zai', model: 'glm-5.3', effort: 'low' } },
    });
  }

  it('端口缺失 → no-op', () => {
    expect(() => webCycleComposerThoughtLevel(undefined)).not.toThrow();
  });

  it('已载入 config（有档位）→ 写下一档 roles.main.effort', async () => {
    const config = reasonedConfig();
    const updateConfig = vi.fn(async () => ({ ok: true, config }));
    const ports = portsOf(async () => config, updateConfig);
    await loadWebComposerConfig(ports);
    webCycleComposerThoughtLevel(ports);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updateConfig).toHaveBeenCalledWith({
      roles: { main: { channel: 'zai', model: 'glm-5.3', effort: 'high' } },
    });
  });

  it('模型未声明档位 → no-op（不写回，如实）', async () => {
    const config = configOf();
    const updateConfig = vi.fn(async () => ({ ok: true, config }));
    const ports = portsOf(async () => config, updateConfig);
    await loadWebComposerConfig(ports);
    webCycleComposerThoughtLevel(ports);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
