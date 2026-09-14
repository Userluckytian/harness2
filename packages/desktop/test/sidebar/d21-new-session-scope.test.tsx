// D-21 新会话作用域优先级：显式指定 → 当前会话所属 → 最近活跃 → 空白。
// 纯函数表驱动 + 组件级（点击新会话按钮，回调收到解析结果）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { resolveNewSessionScope } from '../../src/renderer/sidebar/new-session-scope.js';
import { renderSidebar } from './harness.js';

afterEach(() => {
  cleanup();
});

describe('D-21 resolveNewSessionScope 优先级表', () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof resolveNewSessionScope>[0];
    expected: ReturnType<typeof resolveNewSessionScope>;
  }> = [
    {
      name: '① 显式指定命中（即使存在当前会话与最近活跃）',
      input: {
        explicitWorkspaceId: 'w-explicit',
        currentSessionWorkspaceId: 'w-current',
        recentWorkspaceIds: ['w-recent'],
      },
      expected: { kind: 'workspace', workspaceId: 'w-explicit', source: 'explicit' },
    },
    {
      name: '② 无显式指定 → 当前会话所属',
      input: { currentSessionWorkspaceId: 'w-current', recentWorkspaceIds: ['w-recent'] },
      expected: { kind: 'workspace', workspaceId: 'w-current', source: 'current-session' },
    },
    {
      name: '③ 无显式、无当前会话 → 最近活跃（取首项）',
      input: { recentWorkspaceIds: ['w-recent-1', 'w-recent-2'] },
      expected: { kind: 'workspace', workspaceId: 'w-recent-1', source: 'recent' },
    },
    {
      name: '④ 四档全空 → 空白新会话',
      input: {},
      expected: { kind: 'blank', source: 'none' },
    },
    {
      name: '④ 一个工作区都没有（当前会话也无工作区）→ 空白，不伪造工作区',
      input: { recentWorkspaceIds: [] },
      expected: { kind: 'blank', source: 'none' },
    },
    {
      name: '显式指定不在已知集合 → 继续下探到当前会话',
      input: {
        explicitWorkspaceId: 'w-ghost',
        currentSessionWorkspaceId: 'w-current',
        knownWorkspaceIds: ['w-current'],
      },
      expected: { kind: 'workspace', workspaceId: 'w-current', source: 'current-session' },
    },
    {
      name: '当前会话工作区不在已知集合 → 继续下探到最近活跃',
      input: {
        currentSessionWorkspaceId: 'w-ghost',
        recentWorkspaceIds: ['w-recent'],
        knownWorkspaceIds: ['w-recent'],
      },
      expected: { kind: 'workspace', workspaceId: 'w-recent', source: 'recent' },
    },
    {
      name: '最近活跃序里不认识的首项被跳过，取第一个认识的',
      input: { recentWorkspaceIds: ['w-ghost', 'w-recent'], knownWorkspaceIds: ['w-recent'] },
      expected: { kind: 'workspace', workspaceId: 'w-recent', source: 'recent' },
    },
    {
      name: '空白串等同缺省（不把 " " 当工作区 id）',
      input: { explicitWorkspaceId: '  ', currentSessionWorkspaceId: '', recentWorkspaceIds: ['  ', 'w-recent'] },
      expected: { kind: 'workspace', workspaceId: 'w-recent', source: 'recent' },
    },
    {
      name: '不给已知集合时不校验（装配层自担数据正确性）',
      input: { explicitWorkspaceId: 'w-whatever' },
      expected: { kind: 'workspace', workspaceId: 'w-whatever', source: 'explicit' },
    },
  ];

  for (const c of cases) {
    it(c.name, () => expect(resolveNewSessionScope(c.input)).toEqual(c.expected));
  }
});

describe('D-21 新会话按钮接线', () => {
  it('点击新会话按钮：回调收到按优先级解析出的作用域', () => {
    const received: Array<ReturnType<typeof resolveNewSessionScope>> = [];
    renderSidebar({
      newSessionScope: { currentSessionWorkspaceId: 'w-current', recentWorkspaceIds: ['w-recent'] },
      onNewSession: (scope) => received.push(scope),
    });
    screen.getByTestId('sidebar-new-session').click();
    expect(received).toEqual([{ kind: 'workspace', workspaceId: 'w-current', source: 'current-session' }]);
  });

  it('无任何工作区时进入空白新会话（scope.kind = blank）', () => {
    const received: Array<ReturnType<typeof resolveNewSessionScope>> = [];
    renderSidebar({ newSessionScope: {}, onNewSession: (scope) => received.push(scope) });
    screen.getByTestId('sidebar-new-session').click();
    expect(received).toEqual([{ kind: 'blank', source: 'none' }]);
  });

  it('newSessionEnabled=false 时按钮禁用且不回调（连接未就绪不假装可用）', () => {
    const received: unknown[] = [];
    renderSidebar({ newSessionEnabled: false, onNewSession: (scope) => received.push(scope) });
    const button = screen.getByTestId('sidebar-new-session') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    button.click();
    expect(received).toEqual([]);
  });
});

// 装配级证词（P4-② 补缺）：四级降级不只在纯函数上成立，还要在**组件内点击时**逐档走通 ——
// 作用域是在点击那一刻解析的（数据最新），所以装配级必须复验整条链；上面的纯函数表是 ②/④ 的
// 单档实现证据，这里是四档串起来的装配证据（同一份 D-21 规格，两个观察面）。
describe('D-21 四级降级表（装配级：组件内点击解析）', () => {
  const levels: Array<{
    name: string;
    scope: Parameters<typeof resolveNewSessionScope>[0];
    expected: ReturnType<typeof resolveNewSessionScope>;
  }> = [
    {
      name: '① 显式指定',
      scope: { explicitWorkspaceId: 'w-x', currentSessionWorkspaceId: 'w-c', recentWorkspaceIds: ['w-r'] },
      expected: { kind: 'workspace', workspaceId: 'w-x', source: 'explicit' },
    },
    {
      name: '② 当前会话所属',
      scope: { currentSessionWorkspaceId: 'w-c', recentWorkspaceIds: ['w-r'] },
      expected: { kind: 'workspace', workspaceId: 'w-c', source: 'current-session' },
    },
    {
      name: '③ 最近活跃（取首项）',
      scope: { recentWorkspaceIds: ['w-r1', 'w-r2'] },
      expected: { kind: 'workspace', workspaceId: 'w-r1', source: 'recent' },
    },
    {
      name: '④ 四档全空 → 空白新会话',
      scope: {},
      expected: { kind: 'blank', source: 'none' },
    },
  ];

  for (const level of levels) {
    it(level.name, () => {
      const received: Array<ReturnType<typeof resolveNewSessionScope>> = [];
      renderSidebar({ newSessionScope: level.scope, onNewSession: (scope) => received.push(scope) });
      screen.getByTestId('sidebar-new-session').click();
      expect(received).toEqual([level.expected]);
    });
  }
});
