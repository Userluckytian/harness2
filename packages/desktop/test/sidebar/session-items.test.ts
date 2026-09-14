// D-23 数据适配：store 会话摘要 + 展示态覆层 → 侧栏行数据。
import { describe, expect, it } from 'vitest';
import { UNTITLED_SESSION_LABEL, buildSessionItems, toSessionItem } from '../../src/renderer/sidebar/session-items.js';
import type { SidebarSessionSource } from '../../src/renderer/sidebar/session-items.js';

const source = (id: string, overrides: Partial<SidebarSessionSource> = {}): SidebarSessionSource => ({
  id,
  mtimeMs: 1_700_000_000_000,
  firstUserText: `首条提示 ${id}`,
  messageCount: 2,
  ...overrides,
});

describe('D-23 toSessionItem', () => {
  it('标题优先级：覆层 title > firstUserText', () => {
    expect(toSessionItem(source('a'), { metadata: { a: { title: '重命名后' } } }).title).toBe('重命名后');
    expect(toSessionItem(source('a'), { metadata: {} }).title).toBe('首条提示 a');
  });

  it('无覆层且首条提示为空 → 空会话占位（不编造标题）', () => {
    expect(toSessionItem(source('a', { firstUserText: '   ' }), { metadata: {} }).title).toBe(UNTITLED_SESSION_LABEL);
  });

  it('归档/运行/未读如实带出；缺省为 false/0', () => {
    const plain = toSessionItem(source('a'), { metadata: {} });
    expect([plain.archived, plain.running, plain.unread]).toEqual([false, false, 0]);
    const busy = toSessionItem(source('b'), { metadata: {}, archived: true, flags: { running: true, unread: 5 } });
    expect([busy.archived, busy.running, busy.unread]).toEqual([true, true, 5]);
  });
});

describe('D-23 buildSessionItems', () => {
  const sessions = [source('a'), source('b'), source('c'), source('d')];
  const metadata = {
    b: { archived: true },
    c: { deleted: true },
    d: { title: '被钉住的名字' },
  };

  it('分区与隐藏复用 shared/metadata 口径：deleted 不出现在任何一组', () => {
    const { active, archived } = buildSessionItems({ sessions, metadata });
    expect(active.map((i) => i.id)).toEqual(['a', 'd']);
    expect(archived.map((i) => i.id)).toEqual(['b']);
  });

  it('查询过滤按标题匹配，并保留归档分区', () => {
    const { active, archived } = buildSessionItems({ sessions, metadata, query: '首条提示 b' });
    expect(active).toEqual([]);
    expect(archived.map((i) => i.id)).toEqual(['b']);
  });

  it('逐行运行态由 flagsOf 提供', () => {
    const { active } = buildSessionItems({ sessions, metadata, flagsOf: (id) => ({ running: id === 'a', unread: 9 }) });
    expect(active.map((i) => [i.id, i.running, i.unread])).toEqual([
      ['a', true, 9],
      ['d', false, 9],
    ]);
  });

  it('占位标题可本地化覆盖', () => {
    const { active } = buildSessionItems({
      sessions: [source('x', { firstUserText: '' })],
      metadata: {},
      untitled: '（未命名）',
    });
    expect(active[0]?.title).toBe('（未命名）');
  });
});
