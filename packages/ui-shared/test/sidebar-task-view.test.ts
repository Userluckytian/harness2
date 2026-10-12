// Z8-1 侧栏任务视图纯逻辑（Z-07 #5～#8 / Z-08 / Z-09）：视图模式、排序、筛选、
// cwd 归组、相对时间、leading 槽优先级、Pinned 超限折叠、分区装配。
import { describe, expect, it } from 'vitest';
import type { SidebarSessionItem } from '../src/renderer/sidebar/session-items.js';
import {
  DEFAULT_SIDEBAR_TASK_PREFERENCES,
  PINNED_COLLAPSE_LIMIT,
  buildSidebarSections,
  filterSessionItems,
  groupSessionsByProject,
  leadingSlot,
  projectName,
  relativeTime,
  resolveTaskViewMode,
  sortSessionItems,
  splitPinned,
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

describe('Z-08 默认偏好与视图模式解析', () => {
  it('默认 organizeBy:project / sortBy:updated（Z-08）', () => {
    expect(DEFAULT_SIDEBAR_TASK_PREFERENCES).toEqual({ viewMode: 'project', sortBy: 'updated', filter: 'all' });
  });

  it('归档开关优先于分段控件（Z-08：归档按钮进入）', () => {
    expect(resolveTaskViewMode('project', false)).toBe('project');
    expect(resolveTaskViewMode('grouped', false)).toBe('grouped');
    expect(resolveTaskViewMode('grouped', true)).toBe('archived');
  });
});

describe('Z-09 相对时间（纯函数）', () => {
  const now = 1_700_000_000_000;
  it('刚刚 / 分钟 / 小时 / 天', () => {
    expect(relativeTime(now - 5_000, now)).toBe('刚刚');
    expect(relativeTime(now - 3 * 60_000, now)).toBe('3分钟');
    expect(relativeTime(now - 16 * 3_600_000, now)).toBe('16小时');
    expect(relativeTime(now - 19 * 86_400_000, now)).toBe('19天');
  });

  it('月 / 年与未来时间（负差 → 刚刚）', () => {
    expect(relativeTime(now - 45 * 86_400_000, now)).toBe('1个月');
    expect(relativeTime(now - 800 * 86_400_000, now)).toBe('2年');
    expect(relativeTime(now + 10_000, now)).toBe('刚刚');
  });
});

describe('Z-07 #7/#8 cwd 项目名与归组', () => {
  it('项目名 = cwd 末段（Windows / Unix 分隔符、尾分隔符都认）', () => {
    expect(projectName('D:/AI_Projects/harness2')).toBe('harness2');
    expect(projectName('D:\\AI_Projects\\harness2\\')).toBe('harness2');
    expect(projectName('')).toBe('');
    expect(projectName(undefined)).toBe('');
  });

  it('按 cwd 归组保持输入顺序；无 cwd 归入 key="" 的组', () => {
    const groups = groupSessionsByProject([
      item('a', { cwd: 'D:/p/alpha' }),
      item('b', { cwd: 'D:/p/beta' }),
      item('c', { cwd: 'D:/p/alpha' }),
      item('d'),
    ]);
    expect(groups.map((g) => [g.key, g.name, g.items.map((i) => i.id)])).toEqual([
      ['D:/p/alpha', 'alpha', ['a', 'c']],
      ['D:/p/beta', 'beta', ['b']],
      ['', '', ['d']],
    ]);
  });
});

describe('Z-09 leading 槽优先级', () => {
  it('unread > running > pinned；都无 → null', () => {
    expect(leadingSlot(item('a'))).toBeNull();
    expect(leadingSlot(item('b', { pinned: true }))).toBe('pinned');
    expect(leadingSlot(item('c', { pinned: true, running: true }))).toBe('running');
    expect(leadingSlot(item('d', { pinned: true, running: true, unread: 2 }))).toBe('unread');
  });
});

describe('排序与筛选（工具栏「筛选和排序」）', () => {
  const items = [item('a', { title: 'bbb', mtimeMs: 10 }), item('b', { title: 'aaa', mtimeMs: 30 })];
  it('updated = mtime 降序；name = 标题升序', () => {
    expect(sortSessionItems(items, 'updated').map((i) => i.id)).toEqual(['b', 'a']);
    expect(sortSessionItems(items, 'name').map((i) => i.id)).toEqual(['b', 'a']);
    expect(sortSessionItems([item('x', { title: 'A' }), item('y', { title: 'B' })], 'name').map((i) => i.id)).toEqual([
      'x',
      'y',
    ]);
  });

  it('筛选只用真实数据面（running / unread）', () => {
    const mixed = [item('a', { running: true }), item('b', { unread: 1 }), item('c')];
    expect(filterSessionItems(mixed, 'all').map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(filterSessionItems(mixed, 'running').map((i) => i.id)).toEqual(['a']);
    expect(filterSessionItems(mixed, 'unread').map((i) => i.id)).toEqual(['b']);
  });
});

describe('Z-07 #6 Pinned 折叠（超 20 条）', () => {
  it('未超限：全部可见、无溢出', () => {
    const pinned = Array.from({ length: PINNED_COLLAPSE_LIMIT }, (_, i) => item(`p${i}`, { pinned: true }));
    const { visible, overflow } = splitPinned(pinned);
    expect(visible.length).toBe(PINNED_COLLAPSE_LIMIT);
    expect(overflow).toEqual([]);
  });

  it('超限：只出前 20 条 + 溢出', () => {
    const pinned = Array.from({ length: 25 }, (_, i) => item(`p${i}`, { pinned: true }));
    const { visible, overflow } = splitPinned(pinned);
    expect(visible.length).toBe(20);
    expect(overflow.map((i) => i.id)).toEqual(['p20', 'p21', 'p22', 'p23', 'p24']);
  });
});

describe('Z-08 分区装配（buildSidebarSections）', () => {
  const withCwd = [item('a', { cwd: 'D:/p/alpha', mtimeMs: 30 }), item('b', { cwd: 'D:/p/beta', mtimeMs: 20 })];
  const base = { archived: [], prefs: DEFAULT_SIDEBAR_TASK_PREFERENCES, archivedView: false };

  it('项目模式（默认）：项目区（cwd 归组）+ 会话区（无 cwd 的会话），两区不重复同一行', () => {
    const sections = buildSidebarSections({ ...base, active: [...withCwd, item('c', { mtimeMs: 10 })] });
    expect(sections.map((s) => s.kind)).toEqual(['projects', 'conversations']);
    const projects = sections.find((s) => s.kind === 'projects');
    const names = projects?.kind === 'projects' ? projects.groups.map((g) => g.name) : [];
    expect(names).toEqual(['alpha', 'beta']);
    const conversations = sections.find((s) => s.kind === 'conversations');
    expect(conversations?.kind === 'conversations' ? conversations.items.map((i) => i.id) : []).toEqual(['c']);
  });

  it('项目模式：全部有 cwd 时不渲染空的会话区（红线⑩）', () => {
    expect(buildSidebarSections({ ...base, active: withCwd }).map((s) => s.kind)).toEqual(['projects']);
  });

  it('分组模式：单区按 cwd 归组（合并两区，含无 cwd 组）', () => {
    const sections = buildSidebarSections({
      ...base,
      active: [...withCwd, item('c')],
      prefs: { ...DEFAULT_SIDEBAR_TASK_PREFERENCES, viewMode: 'grouped' },
    });
    expect(sections.map((s) => s.kind)).toEqual(['grouped']);
  });

  it('有置顶才出现 Pinned 区；归档视图下不出现', () => {
    const pinned = [item('p', { cwd: 'D:/p/alpha', pinned: true })];
    const sections = buildSidebarSections({ ...base, active: pinned });
    expect(sections.map((s) => s.kind)).toEqual(['pinned', 'projects']);
    const archivedView = buildSidebarSections({ ...base, active: pinned, archivedView: true });
    expect(archivedView.map((s) => s.kind)).toEqual(['archived']);
  });

  it('空活跃列表不摆空壳分区（红线⑩）', () => {
    expect(buildSidebarSections({ ...base, active: [] })).toEqual([]);
  });
});
