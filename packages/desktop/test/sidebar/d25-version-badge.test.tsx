// D-25 版本徐标：`version[-commit][-dirty]`，来源 DSH_CLIENT_VERSION /
// DSH_CLIENT_COMMIT_HASH（7 位）/ DSH_CLIENT_GIT_DIRTY；缺元数据不显示徐标。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { BUILD_VERSION_ENV_KEYS, formatBuildVersion, resolveBuildVersion } from '../../src/renderer/sidebar/brand.js';
import { renderSidebar } from './harness.js';

afterEach(() => {
  cleanup();
});

describe('D-25 buildVersion 纯函数', () => {
  it('只有 version → 只显示 version', () => {
    expect(formatBuildVersion({ version: '1.2.3' })).toBe('1.2.3');
  });

  it('version + commit → `version-commit`', () => {
    expect(formatBuildVersion({ version: '1.2.3', commit: 'abcdef0' })).toBe('1.2.3-abcdef0');
  });

  it('commit 取前 7 位（长哈希截断）', () => {
    expect(formatBuildVersion({ version: '1.2.3', commit: 'abcdef0123456789' })).toBe('1.2.3-abcdef0');
  });

  it('dirty=true → 追加 -dirty；dirty=false 不追加', () => {
    expect(formatBuildVersion({ version: '1.2.3', commit: 'abcdef0', dirty: true })).toBe('1.2.3-abcdef0-dirty');
    expect(formatBuildVersion({ version: '1.2.3', dirty: false })).toBe('1.2.3');
  });

  it('缺 version（含空白）→ undefined（不摆占位徐标）', () => {
    expect(formatBuildVersion({})).toBeUndefined();
    expect(formatBuildVersion({ version: '   ' })).toBeUndefined();
    expect(formatBuildVersion({ version: undefined, commit: 'abcdef0', dirty: true })).toBeUndefined();
  });

  it('环境变量解析按 DSH_CLIENT_* 键名，且只有字面 true 算脏', () => {
    expect(
      resolveBuildVersion({
        [BUILD_VERSION_ENV_KEYS.version]: '2.0.0',
        [BUILD_VERSION_ENV_KEYS.commit]: 'abcdef0',
        [BUILD_VERSION_ENV_KEYS.dirty]: 'true',
      }),
    ).toBe('2.0.0-abcdef0-dirty');
    expect(
      resolveBuildVersion({ [BUILD_VERSION_ENV_KEYS.version]: '2.0.0', [BUILD_VERSION_ENV_KEYS.dirty]: '1' }),
    ).toBe('2.0.0');
    expect(resolveBuildVersion({})).toBeUndefined();
  });
});

describe('D-25 徐标落点', () => {
  it('徐标挂在品牌名席位内（品牌行下方），文案为解析后的构建标签', () => {
    renderSidebar({ buildVersion: '1.2.3-abcdef0' });
    const badge = screen.getByTestId('sidebar-version-badge');
    expect(badge.textContent).toBe('1.2.3-abcdef0');
    expect(screen.getByTestId('sidebar-brand-name').contains(badge)).toBe(true);
    expect(screen.getByTestId('sidebar-brand-name').textContent).toBe('本地构建1.2.3-abcdef0');
  });

  it('从环境表解析（装配层传 buildEnv 时不必自己拼串）', () => {
    renderSidebar({
      buildEnv: { [BUILD_VERSION_ENV_KEYS.version]: '3.1.4', [BUILD_VERSION_ENV_KEYS.commit]: 'abcdef0123' },
    });
    expect(screen.getByTestId('sidebar-version-badge').textContent).toBe('3.1.4-abcdef0');
  });

  it('无版本元数据 → 整个徐标不渲染（只有回落品牌名）', () => {
    renderSidebar({ buildEnv: {} });
    expect(screen.queryByTestId('sidebar-version-badge')).toBeNull();
    expect(screen.getByTestId('sidebar-brand-name').textContent).toBe('本地构建');
  });

  it('轨道态不渲染徐标（只有标记席位）', () => {
    renderSidebar({ collapsed: true, buildVersion: '1.2.3' });
    expect(screen.queryByTestId('sidebar-version-badge')).toBeNull();
  });
});
