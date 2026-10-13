// 设置页共享实现测试（Z7 下沉 ui-shared）：分区导航/切换、外观端口回调、网关 / IM 分区
// （appId 掩码态、appSecret 不回显、状态不造假、凭据写入经端口、缺数据面如实降级）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { SettingsPage } from '../src/renderer/settings/SettingsPage.js';
import type { SettingsPorts } from '../src/renderer/settings/ports.js';
import type { SettingsAuthMaskedShape, SettingsConfigShape, SettingsPreferencesShape } from '../src/shared/settings.js';

(HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

const PREFS: SettingsPreferencesShape = {
  theme: 'system',
  defaultPaneCount: 1,
  showWelcome: true,
  notifyDetails: 'minimal',
};

const CFG: SettingsConfigShape = {
  providers: {},
  roles: {},
  approval: { mode: 'default', tools: {} },
  memory: { mode: 'off', nudgeInterval: 10 },
  browser: { enabled: true, idleDestroyMs: 1000, maxConcurrent: 1 },
  plugins: { enabled: true, allow: [] },
  mcpServers: {},
  subagent: { maxDepth: 1, maxTurns: 1 },
  sources: { global: true, project: false },
  warnings: [],
  errors: [],
};

const AUTH: SettingsAuthMaskedShape = {
  channels: [],
  gateways: [
    { channel: 'qq', maskedAppId: true, maskedAppSecret: true },
    { channel: 'feishu', maskedAppId: false, maskedAppSecret: false },
  ],
};

function makePorts(over: Partial<SettingsPorts> = {}): SettingsPorts {
  return {
    getPreferences: async () => PREFS,
    setPreferences: async (p) => p,
    getConfig: async () => CFG,
    updateConfig: async () => ({ ok: true, config: CFG }),
    getAuthMasked: async () => AUTH,
    updateAuth: async () => ({ ok: true }),
    getDoctorReport: async () => ({ checks: [], exitCode: 0 }),
    getCrashReports: async () => [],
    getSkills: async () => ({ skills: [], warnings: [], roots: { project: '/p', global: '/g' } }),
    theme: 'system',
    onSelectTheme: () => {},
    uiFontSize: 14,
    onUiFontSizeCommit: () => {},
    ...over,
  };
}

async function renderAt(ports: SettingsPorts, section: string): Promise<void> {
  render(<SettingsPage open onClose={() => {}} ports={ports} />);
  await screen.findByRole('dialog', { name: '设置' });
  fireEvent.click(document.querySelector(`[data-section-nav="${section}"]`) as HTMLElement);
}

afterEach(() => cleanup());

describe('设置页共享实现：分区骨架（Z-88/Z-89）', () => {
  it('默认打开第一个分区；点击导航切换正文（旧分区卸载）', async () => {
    render(<SettingsPage open onClose={() => {}} ports={makePorts()} />);
    await screen.findByRole('dialog', { name: '设置' });
    expect(document.querySelector('[data-section="general"]')).not.toBeNull();

    fireEvent.click(document.querySelector('[data-section-nav="appearance"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-section="appearance"]')).not.toBeNull());
    expect(document.querySelector('[data-section="general"]')).toBeNull();
  });

  it('sectionAllowList 白名单：只保留有真数据面的分区（隐藏其余，不摆禁用假控件）', async () => {
    render(<SettingsPage open onClose={() => {}} ports={makePorts({ sectionAllowList: ['appearance', 'gateway'] })} />);
    await screen.findByRole('dialog', { name: '设置' });
    const navs = [...document.querySelectorAll('[data-section-nav]')].map((n) => n.getAttribute('data-section-nav'));
    expect(navs).toEqual(['appearance', 'gateway']);
  });
});

describe('外观分区：主题 / 字号经端口真生效', () => {
  it('选择主题 → onSelectTheme + 偏好写回被调用（宿主负责即时呈现）', async () => {
    const onSelectTheme = vi.fn();
    const setPreferences = vi.fn(async (p: SettingsPreferencesShape) => p);
    await renderAt(makePorts({ onSelectTheme, setPreferences }), 'appearance');

    const trigger = await screen.findByRole('combobox', { name: '界面主题' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(screen.getByRole('option', { name: '深色' }));

    await waitFor(() => expect(onSelectTheme).toHaveBeenCalledWith('zai-dark'));
    await waitFor(() => expect(setPreferences).toHaveBeenCalledWith({ ...PREFS, theme: 'zai-dark' }));
  });

  it('提交字号 → onUiFontSizeCommit 收到提交值', async () => {
    const onUiFontSizeCommit = vi.fn();
    await renderAt(makePorts({ onUiFontSizeCommit }), 'appearance');
    const field = await screen.findByRole('spinbutton', { name: '界面字号' });
    fireEvent.change(field, { target: { value: '16' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(onUiFontSizeCommit).toHaveBeenCalledWith(16));
  });
});

describe('网关 / IM 分区', () => {
  it('掩码态展示：QQ 已配置（appId/secret 掩码），无明文回显；连接状态恒为「未探测」不造假', async () => {
    await renderAt(makePorts(), 'gateway');
    expect((await screen.findAllByText(/IM 网关/)).length).toBeGreaterThan(0);

    // QQ 行：已配置（掩码）
    const qq = document.querySelector('[data-gateway-channel="qq"]') as HTMLElement;
    expect(qq.querySelector('[data-gateway-credential]')?.getAttribute('data-gateway-credential')).toBe('configured');
    expect(qq.textContent).toContain('掩码');
    // 连接状态：只报「未探测」（红线⑩：不造假绿点）
    for (const c of ['qq', 'feishu']) {
      const row = document.querySelector(`[data-gateway-channel="${c}"]`) as HTMLElement;
      expect(row.querySelector('[data-gateway-status]')?.getAttribute('data-gateway-status')).toBe('unprobed');
      expect(row.textContent).toContain('未探测');
    }
    // appSecret 输入是 password 型，且页面无明文密钥字样
    const secretInput = document.querySelector('[aria-label="QQ AppSecret"]') as HTMLInputElement;
    expect(secretInput.type).toBe('password');
    document.querySelectorAll('input[type="password"]').forEach((i) => {
      expect((i as HTMLInputElement).value).toBe(''); // 不回显已存密钥
    });
  });

  it('凭据写入经端口 updateAuth（只写不回显）；策略写入经 updateConfig', async () => {
    const updateAuth = vi.fn(async () => ({ ok: true }));
    const updateConfig = vi.fn(async (_patch: Record<string, unknown>) => ({ ok: true, config: CFG }));
    await renderAt(makePorts({ updateAuth, updateConfig }), 'gateway');

    fireEvent.change(await screen.findByLabelText('QQ AppID'), { target: { value: 'app-1' } });
    fireEvent.change(screen.getByLabelText('QQ AppSecret'), { target: { value: 'sec-1' } });
    fireEvent.click(screen.getAllByRole('button', { name: '保存凭据' })[0]!);
    await waitFor(() =>
      expect(updateAuth).toHaveBeenCalledWith({ gateways: { qq: { appId: 'app-1', appSecret: 'sec-1' } } }),
    );

    fireEvent.click(screen.getAllByRole('button', { name: '保存策略' })[0]!);
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    const patch = updateConfig.mock.calls[0]![0];
    expect(Object.keys(patch['gateways'] as Record<string, unknown>)).toEqual(['qq']);
  });

  it('未配置任何渠道 → 空态 + 启动指引（不摆假条目）', async () => {
    await renderAt(
      makePorts({
        getConfig: async () => ({ ...CFG, gateways: {} }),
        getAuthMasked: async () => ({ channels: [], gateways: [] }),
      }),
      'gateway',
    );
    expect(document.querySelector('[data-gateway-empty]')).not.toBeNull();
    expect(document.body.textContent).toContain('harness2 gateway');
  });

  it('无凭据写入通道（updateAuth 缺失）→ 如实提示，不渲染假保存按钮', async () => {
    await renderAt(makePorts({ updateAuth: undefined }), 'gateway');
    expect(document.querySelector('[data-gateway-credential-unavailable]')).not.toBeNull();
    expect(screen.queryByLabelText('QQ AppSecret')).toBeNull();
  });

  it('无 config/auth 数据面（getConfig 缺失）→ 只读指引态（红线⑩）', async () => {
    await renderAt(makePorts({ getConfig: undefined, getAuthMasked: undefined }), 'gateway');
    expect(await screen.findByText(/此壳不提供 config.json 读取/)).toBeTruthy();
    expect(document.querySelector('[data-gateway-unavailable]')).not.toBeNull();
  });
});

describe('Z9-6c 配置读失败：分区如实报错（不再停在「加载中…」）', () => {
  it('getConfig 抛错 → cfg 依赖分区显示可读错误，不显示「加载中…」也不谎称成功', async () => {
    const ports = makePorts({
      getConfig: async () => {
        throw new Error('配置读取失败：HTTP 500');
      },
    });
    render(<SettingsPage open onClose={() => {}} ports={ports} />);
    await screen.findByRole('dialog', { name: '设置' });
    fireEvent.click(document.querySelector(`[data-section-nav="memory"]`) as HTMLElement);

    // 错误如实暴露到分区（含原始消息）
    expect(await screen.findByText(/配置读取失败：HTTP 500/)).toBeTruthy();
    expect(document.querySelector('[data-settings-load-error]')).not.toBeNull();
    // 反向钉：不再停留在「加载中…」，也没有成功态
    expect(screen.queryByText('加载中…')).toBeNull();
  });

  it('config 读失败 → gateway 分区（有端口）同样如实报错而非「加载中…」', async () => {
    const ports = makePorts({
      getConfig: async () => {
        throw new Error('配置读取失败：HTTP 503');
      },
    });
    await renderAt(ports, 'gateway');
    expect(await screen.findByText(/配置读取失败：HTTP 503/)).toBeTruthy();
    expect(screen.queryByText('加载中…')).toBeNull();
    expect(document.querySelector('[data-gateway-unavailable]')).toBeNull();
  });
});
