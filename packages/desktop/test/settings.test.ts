// 设置子系统测试（B2）：偏好规范化回落 + config.json/auth.json 的读写契约。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizePreferences, defaultPreferences } from '../src/shared/preferences.js';
import { readAuthMasked, readSettingsConfig, updateAuth, updateSettingsConfig } from '../src/main/config-file.js';

const homes = new Set<string>();
afterEach(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes.clear();
});
function tempHome(): string {
  const h = mkdtempSync(join(tmpdir(), 'harness2-settings-'));
  homes.add(h);
  return h;
}

describe('shared/preferences 规范化', () => {
  it('缺省偏好 = 暖纸/1 栏/显示欢迎/精简通知', () => {
    expect(defaultPreferences()).toEqual({
      theme: 'warmPaper',
      defaultPaneCount: 1,
      showWelcome: true,
      notifyDetails: 'minimal',
    });
  });

  it('合法值原样保留', () => {
    expect(
      normalizePreferences({ theme: 'dark', defaultPaneCount: 3, showWelcome: false, notifyDetails: 'full' }),
    ).toEqual({
      theme: 'dark',
      defaultPaneCount: 3,
      showWelcome: false,
      notifyDetails: 'full',
    });
  });

  it('非法/越界字段逐个回落默认', () => {
    expect(normalizePreferences({ theme: 'neon', defaultPaneCount: 9, showWelcome: 'yes', notifyDetails: 42 })).toEqual(
      defaultPreferences(),
    );
    expect(normalizePreferences(null)).toEqual(defaultPreferences());
    expect(normalizePreferences('oops')).toEqual(defaultPreferences());
    // 部分越界：只坏 defaultPaneCount
    const n = normalizePreferences({ theme: 'system', defaultPaneCount: 0 });
    expect(n.theme).toBe('system');
    expect(n.defaultPaneCount).toBe(1);
  });
});

describe('settings:getConfig 契约', () => {
  it('无配置文件时返回缺省形状（非空默认值；sources 全 false + 未找到告警）', () => {
    const home = tempHome();
    const s = readSettingsConfig(home, join(home, 'proj'));
    expect(s.providers).toEqual({});
    expect(s.approval.mode).toBe('default');
    expect(s.memory).toEqual({ mode: 'off', nudgeInterval: 10 });
    expect(s.browser).toEqual({ enabled: true, idleDestroyMs: 300_000, maxConcurrent: 2 });
    expect(s.subagent).toEqual({ maxDepth: 1, maxTurns: 25 });
    expect(s.sources).toEqual({ global: false, project: false });
    expect(s.errors.length).toBe(1); // 「未找到任何配置文件」
    expect(s.errors[0]).toContain('未找到');
  });
});

describe('settings:updateConfig 契约', () => {
  it('白名单 patch 深合并进全局 config.json 并回读生效', () => {
    const home = tempHome();
    const res = updateSettingsConfig(home, {
      approval: { mode: 'bypass' },
      browser: { maxConcurrent: 4 },
    });
    expect(res.ok).toBe(true);
    expect(res.config?.approval.mode).toBe('bypass');
    expect(res.config?.browser.maxConcurrent).toBe(4);
    // 磁盘确认
    const raw = JSON.parse(readFileSync(join(home, '.harness2', 'config.json'), 'utf8')) as {
      approval?: { mode?: string };
      browser?: { maxConcurrent?: number };
    };
    expect(raw.approval?.mode).toBe('bypass');
  });

  it('白名单外顶层 key 拒绝且不落盘', () => {
    const home = tempHome();
    const res = updateSettingsConfig(home, { telemetry: { enabled: true } });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('不允许的配置字段');
  });

  it('密钥类字段名拒绝（apiKey/appSecret 走 auth.json）', () => {
    const home = tempHome();
    const res = updateSettingsConfig(home, { providers: { a: { apiKey: 'x' } } });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('不允许写入密钥');
  });

  it('plan 审批模式已被内核支持（终端轨道 T1 新增第四态，桌面合并后同样接受）', () => {
    const home = tempHome();
    const res = updateSettingsConfig(home, { approval: { mode: 'plan' } });
    expect(res.ok).toBe(true);
    const raw = JSON.parse(readFileSync(join(home, '.harness2', 'config.json'), 'utf8')) as {
      approval?: { mode?: string };
    };
    expect(raw.approval?.mode).toBe('plan');
  });
});

describe('settings:updateAuth 契约（网关凭据，掩码回显）', () => {
  it('写 gateway 凭据后掩码视图仅报告存在性', () => {
    const home = tempHome();
    expect(updateAuth(home, { gateways: { qq: { appId: 'CID', appSecret: 'SECRET123' } } }).ok).toBe(true);
    const masked = readAuthMasked(home);
    expect(masked.gateways).toContainEqual({ channel: 'qq', maskedAppId: true, maskedAppSecret: true });
  });

  it('空凭据 = 移除渠道；null 也移除', () => {
    const home = tempHome();
    updateAuth(home, { gateways: { qq: { appId: 'CID', appSecret: 'SECRET123' } } });
    // 只填 appId：空 appSecret 保留原值（防误删），渠道仍在
    expect(updateAuth(home, { gateways: { qq: { appId: 'CID2', appSecret: '' } } }).ok).toBe(true);
    const afterKeep = readAuthMasked(home);
    expect(afterKeep.gateways).toContainEqual({ channel: 'qq', maskedAppId: true, maskedAppSecret: true });
    updateAuth(home, { gateways: { qq: null } });
    expect(readAuthMasked(home).gateways).toEqual([]);
  });

  it('空白字段保留原值（只改策略不动密钥场景）', () => {
    const home = tempHome();
    updateAuth(home, { gateways: { qq: { appId: 'CID', appSecret: 'SECRET123' } } });
    updateAuth(home, { gateways: { qq: { appId: 'CID2', appSecret: '' } } });
    const raw = readFileSync(join(home, '.harness2', 'auth.json'), 'utf8');
    expect(raw).toContain('CID2');
    expect(raw).toContain('SECRET123');
  });

  it('gateways 缺失时报错', () => {
    const home = tempHome();
    const res = updateAuth(home, { bogus: 1 });
    expect(res.ok).toBe(false);
  });
});
