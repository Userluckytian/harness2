// 设置页共享实现测试（Z7 下沉 ui-shared）：分区导航/切换、外观端口回调、网关 / IM 分区
// （appId 掩码态、appSecret 不回显、状态不造假、凭据写入经端口、缺数据面如实降级）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { SettingsPage } from '../src/renderer/settings/SettingsPage.js';
import type { SettingsPorts } from '../src/renderer/settings/ports.js';
import { codePreferencesStore } from '../src/renderer/code/code-preferences.js';
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

describe('外观分区（Z10-7）：代码设置卡经偏好通道持久化 + 预览卡消费运行时 store', () => {
  it('改浅色代码主题 → 写运行时 store + setPreferences 收到 codeThemeLight', async () => {
    codePreferencesStore.reset();
    const setPreferences = vi.fn(async (p: SettingsPreferencesShape) => p);
    await renderAt(makePorts({ setPreferences }), 'appearance');

    const trigger = await screen.findByRole('combobox', { name: '浅色代码主题' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(screen.getByRole('option', { name: 'Vitesse' }));

    await waitFor(() => expect(codePreferencesStore.getSnapshot().themeLight).toBe('vitesse-light'));
    await waitFor(() =>
      expect(setPreferences).toHaveBeenCalledWith(expect.objectContaining({ codeThemeLight: 'vitesse-light' })),
    );
    codePreferencesStore.reset();
  });

  it('预览卡消费 store：主题 id 与徽标随偏好更新', async () => {
    codePreferencesStore.reset();
    await renderAt(makePorts(), 'appearance');
    // 浅色预览卡（默认 github-light）标题 + 徽标（system→浅色界面 → 当前生效）
    const light = document.querySelector('[data-theme-preview="light"]') as HTMLElement;
    expect(light.getAttribute('data-preview-theme')).toBe('github-light');
    expect(light.textContent).toContain('浅色预览');
    expect(light.querySelector('[data-preview-badge]')?.getAttribute('data-preview-badge')).toBe('当前生效');
    const dark = document.querySelector('[data-theme-preview="dark"]') as HTMLElement;
    expect(dark.getAttribute('data-preview-theme')).toBe('github-dark');
    codePreferencesStore.reset();
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

describe('措辞缺省：中性且正确（不含桌面专属事实）', () => {
  it('缺省通用分区：偏好措辞中性，不含 desktop-preferences.json 与 Ctrl+,', async () => {
    await renderAt(makePorts(), 'general');
    const text = document.querySelector('[data-section="general"]')?.textContent ?? '';
    expect(text).toContain('本机偏好文件');
    expect(text).not.toContain('desktop-preferences.json');
    expect(text).not.toContain('Ctrl+,');
  });

  it('缺省快捷键表：只列两壳共同真绑定，不含 Ctrl+, / 开发者工具 / 未绑定的 Ctrl+F', async () => {
    await renderAt(makePorts(), 'shortcuts');
    const text = document.querySelector('[data-section="shortcuts"]')?.textContent ?? '';
    expect(text).toContain('Ctrl+K / Cmd+K');
    expect(text).toContain('Ctrl+N / Cmd+N');
    expect(text).toContain('Ctrl+J / Cmd+J');
    expect(text).not.toContain('Ctrl+,');
    expect(text).not.toContain('开发者工具');
    expect(text).not.toContain('Ctrl+F');
  });

  it('缺省关于标题 = harness2（不写「桌面端」）', async () => {
    await renderAt(makePorts(), 'about');
    expect(document.querySelector('[data-section="about"] h3')?.textContent).toBe('harness2');
    expect(document.querySelector('[data-section="about"]')?.textContent ?? '').not.toContain('桌面端');
  });

  it('缺省定时任务说明：不再写「见后续版本」，指向侧栏「自动化」与 CLI', async () => {
    await renderAt(makePorts(), 'cron');
    const text = document.querySelector('[data-section="cron"]')?.textContent ?? '';
    expect(text).not.toContain('见后续版本');
    expect(text).toContain('自动化');
    expect(text).toContain('harness2 cron');
  });
});

describe('措辞注入：按壳覆盖（copy prop）', () => {
  it('注入 copy → 偏好文件名 / 打开设置键位 / 快捷键表 / 关于标题均按注入呈现', async () => {
    const copy = {
      aboutTitle: 'harness2 测试端',
      preferencesFileLabel: 'my-prefs.json',
      openSettingsKeys: 'Ctrl+,',
      shortcutRows: [{ keys: 'Ctrl+,', label: '打开设置' }],
    };
    render(<SettingsPage open onClose={() => {}} ports={makePorts()} copy={copy} />);
    await screen.findByRole('dialog', { name: '设置' });

    // general（默认分区）：偏好文件名按注入
    expect(document.querySelector('[data-section="general"]')?.textContent ?? '').toContain('my-prefs.json');
    expect(document.querySelector('[data-section="general"]')?.textContent ?? '').toContain('Ctrl+, 打开本设置');

    fireEvent.click(document.querySelector('[data-section-nav="shortcuts"]') as HTMLElement);
    await waitFor(() =>
      expect(document.querySelector('[data-section="shortcuts"]')?.textContent ?? '').toContain('Ctrl+,'),
    );

    fireEvent.click(document.querySelector('[data-section-nav="about"]') as HTMLElement);
    await waitFor(() =>
      expect(document.querySelector('[data-section="about"] h3')?.textContent).toBe('harness2 测试端'),
    );
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
