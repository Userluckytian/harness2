// P0-3b 侧栏「项目」分组融合纯逻辑（Z-16 #6/#7/#9）：
//   mergeProjectGroups（显式项目 + 会话 → 项目组 + 游离段）与
//   buildSidebarSections 的 projects 接管 / 向后兼容反向钉。
// 规则口径见 sidebar/project-groups.ts 头注：
//   - 每个显式项目恒成组（0 会话也在场，渲染侧显示「暂无任务」）；
//   - 会话按归一 cwd 归属（Windows 不区分大小写、`\`≡`/`、忽略尾分隔符）；
//   - 不匹配任何显式项目（含无 cwd）→ 游离段；
//   - 组排序 = addedAt 升序；组内/游离保持输入顺序（排序/筛选在 buildSidebarSections 已做）；
//   - projects 为空数组 → 不接管分组，既有输出逐字节不变（反向钉）。
import { describe, expect, it } from 'vitest';
import type { SidebarSessionItem } from '../src/renderer/sidebar/session-items.js';
import { mergeProjectGroups, projectName } from '../src/renderer/sidebar/project-groups.js';
import {
  projectName as projectNameFromTaskView,
  buildSidebarSections,
  DEFAULT_SIDEBAR_TASK_PREFERENCES,
} from '../src/renderer/sidebar/task-view.js';

const item = (id: string, overrides: Partial<SidebarSessionItem> = {}): SidebarSessionItem => ({
  id,
  title: `会话 ${id}`,
  messageCount: 2,
  mtimeMs: 1_700_000_000_000,
  archived: false,
  running: false,
  unread: 0,
  pendingApprovals: 0,
  pinned: false,
  ...overrides,
});

describe('projectName（P0-3b 起定义在 project-groups，task-view 再导出）', () => {
  it('末段目录名：Windows / Unix 分隔符、尾分隔符都认', () => {
    expect(projectName('D:/AI_Projects/harness2')).toBe('harness2');
    expect(projectName('D:\\AI_Projects\\harness2\\')).toBe('harness2');
    expect(projectName('/srv/app')).toBe('app');
    expect(projectName('')).toBe('');
    expect(projectName(undefined)).toBe('');
  });

  it('task-view 再导出的 projectName 与本源是同一函数（引用面不变）', () => {
    expect(projectNameFromTaskView).toBe(projectName);
  });
});

describe('mergeProjectGroups（纯函数）', () => {
  it('空显式项目输入 → 零组、全部会话进游离段（不接管）', () => {
    const items = [item('a', { cwd: 'D:/p/alpha' }), item('b')];
    const merged = mergeProjectGroups({ projects: [], items });
    expect(merged.groups).toEqual([]);
    expect(merged.loose.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('含空组：0 会话的显式项目也成组（渲染侧「暂无任务」的数据源）', () => {
    const merged = mergeProjectGroups({
      projects: [
        { cwd: 'D:/p/alpha', addedAt: 10 },
        { cwd: 'D:/p/empty', addedAt: 20 },
      ],
      items: [item('a', { cwd: 'D:/p/alpha' })],
    });
    expect(merged.groups.map((g) => [g.key, g.name, g.source, g.items.length])).toEqual([
      ['project:D:/p/alpha', 'alpha', 'project', 1],
      ['project:D:/p/empty', 'empty', 'project', 0],
    ]);
  });

  it('会话按 cwd 归属；无匹配（含无 cwd）归游离段；组内保持输入顺序', () => {
    const merged = mergeProjectGroups({
      projects: [
        { cwd: 'D:/p/alpha', addedAt: 1 },
        { cwd: 'D:/p/beta', addedAt: 2 },
      ],
      items: [
        item('b1', { cwd: 'D:/p/beta' }),
        item('a1', { cwd: 'D:/p/alpha' }),
        item('z', { cwd: 'D:/p/gamma' }),
        item('n'),
      ],
    });
    const [alpha, beta] = merged.groups;
    expect(alpha?.items.map((i) => i.id)).toEqual(['a1']);
    expect(beta?.items.map((i) => i.id)).toEqual(['b1']);
    expect(merged.loose.map((i) => i.id)).toEqual(['z', 'n']);
  });

  it('组排序 = addedAt 升序（与输入顺序无关）', () => {
    const merged = mergeProjectGroups({
      projects: [
        { cwd: '/late', addedAt: 300 },
        { cwd: '/first', addedAt: 100 },
        { cwd: '/mid', addedAt: 200 },
      ],
      items: [],
    });
    expect(merged.groups.map((g) => g.cwd)).toEqual(['/first', '/mid', '/late']);
  });

  it('cwd 归一匹配：Windows 大小写不敏感、反斜杠≡正斜杠、忽略尾分隔符', () => {
    const merged = mergeProjectGroups({
      projects: [{ cwd: 'D:\\AI_Projects\\harness2\\', addedAt: 1 }],
      items: [item('u1', { cwd: 'd:/ai_projects/HARNESS2' }), item('u2', { cwd: 'D:\\AI_Projects\\harness2\\sub' })],
    });
    const group = merged.groups[0];
    expect(group?.items.map((i) => i.id)).toEqual(['u1']);
    expect(merged.loose.map((i) => i.id)).toEqual(['u2']);
  });

  it('重复显式项目（归一后同路径）先到先得，不产生重复组', () => {
    const merged = mergeProjectGroups({
      projects: [
        { cwd: 'D:/p/x', addedAt: 1 },
        { cwd: 'd:\\p\\X\\', addedAt: 2 },
      ],
      items: [],
    });
    expect(merged.groups.map((g) => g.key)).toEqual(['project:D:/p/x']);
  });
});

describe('buildSidebarSections 的 projects 接管与向后兼容反向钉', () => {
  const base = {
    active: [
      item('a', { cwd: 'D:/p/alpha', mtimeMs: 3 }),
      item('b', { cwd: 'D:/p/other', mtimeMs: 2 }),
      item('c', { mtimeMs: 1 }),
    ],
    archived: [] as SidebarSessionItem[],
    prefs: DEFAULT_SIDEBAR_TASK_PREFERENCES,
    archivedView: false,
  };

  it('反向钉：projects 省略 与 projects: [] 输出逐字节一致（web / 旧调用点行为不变）', () => {
    const without = buildSidebarSections({ ...base });
    const empty = buildSidebarSections({ ...base, projects: [] });
    expect(empty).toEqual(without);
    // 既有语义本身也钉一下：项目区 = 有 cwd 会话聚合，任务区 = 无 cwd 平铺。
    expect(without.map((s) => s.kind)).toEqual(['projects', 'conversations']);
  });

  it('projects 非空 → 显式组接管项目区（空组在场），不匹配会话 + 无 cwd 进任务区', () => {
    const sections = buildSidebarSections({
      ...base,
      projects: [
        { cwd: 'D:/p/alpha', addedAt: 5 },
        { cwd: 'D:/p/void', addedAt: 9 },
      ],
    });
    expect(sections.map((s) => s.kind)).toEqual(['projects', 'conversations']);
    const projects = sections[0];
    if (projects?.kind !== 'projects') throw new Error('期望 projects 分区');
    expect(projects.groups.map((g) => [g.key, g.source, g.items.map((i) => i.id)])).toEqual([
      ['project:D:/p/alpha', 'project', ['a']],
      ['project:D:/p/void', 'project', []],
    ]);
    const conversations = sections[1];
    if (conversations?.kind !== 'conversations') throw new Error('期望 conversations 分区');
    expect(conversations.items.map((i) => i.id)).toEqual(['b', 'c']);
  });

  it('全部会话都归入显式项目时任务区仍恒在（Z-16 #9：空 items，渲染侧「暂无任务」）', () => {
    const sections = buildSidebarSections({
      active: [item('a', { cwd: 'D:/p/alpha' })],
      archived: [],
      prefs: DEFAULT_SIDEBAR_TASK_PREFERENCES,
      archivedView: false,
      projects: [{ cwd: 'D:/p/alpha', addedAt: 1 }],
    });
    expect(sections.map((s) => s.kind)).toEqual(['projects', 'conversations']);
    const conversations = sections[1];
    expect(conversations?.kind === 'conversations' ? conversations.items : null).toEqual([]);
  });
});
