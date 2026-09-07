// B3 会话展示态覆层测试：normalizeMetadata/filterSessionList 纯逻辑 + metadata-file 读写契约。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultMetadata,
  displayTitle,
  filterSessionList,
  isArchived,
  isDeleted,
  normalizeMetadata,
  type SessionMetadataMap,
} from '../src/shared/metadata.js';
import { readMetadata, writeMetadataPatch } from '../src/main/metadata-file.js';

const homes = new Set<string>();
afterEach(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes.clear();
});
function tempHome(): string {
  const h = mkdtempSync(join(tmpdir(), 'harness2-meta-'));
  homes.add(h);
  return h;
}

const S = { id: 's1', firstUserText: '你好' };

describe('normalizeMetadata（共享校验）', () => {
  it('顶层非对象回落空映射', () => {
    expect(normalizeMetadata(null)).toEqual(defaultMetadata());
    expect(normalizeMetadata('x')).toEqual(defaultMetadata());
    expect(normalizeMetadata([])).toEqual(defaultMetadata());
  });

  it('条目字段逐个校验：非对象条目忽略、非布尔标记忽略', () => {
    const m = normalizeMetadata({ a: 'nope', b: { title: ' 名字 ', archived: 1, deleted: 'y' } });
    expect(m).toEqual({ b: { title: '名字' } });
  });

  it('字段类型不符回落无该字段：空 title 被丢弃', () => {
    const m = normalizeMetadata({ c: { title: '   ', archived: true } });
    expect(m).toEqual({ c: { archived: true } });
  });

  it('无效满条目整体丢弃', () => {
    expect(normalizeMetadata({ d: {} })).toEqual({});
  });
});

describe('filterSessionList（B3 搜索分区纯函数）', () => {
  it('无元数据：全部归 active', () => {
    const { active, archived } = filterSessionList([S], {}, '');
    expect(active).toEqual([S]);
    expect(archived).toEqual([]);
  });

  it('搜索命中 title（不分大小写）与 firstUserText', () => {
    const meta: SessionMetadataMap = { s1: { title: 'TURN 分析' } };
    expect(filterSessionList([S], meta, 'turn').active).toEqual([S]);
    expect(filterSessionList([S], meta, '你好').active).toEqual([S]);
    expect(filterSessionList([S], meta, '不存在').active).toEqual([]);
  });

  it('归档：archived 归折叠区；deleted 不可见', () => {
    const archivedMeta: SessionMetadataMap = { s1: { archived: true } };
    const r = filterSessionList([S], archivedMeta, '');
    expect(r.active).toEqual([]);
    expect(r.archived).toEqual([S]);
    expect(filterSessionList([S], { s1: { archived: true, deleted: true } }, '').active).toEqual([]);
    expect(filterSessionList([S], { s1: { archived: true, deleted: true } }, '').archived).toEqual([]);
    expect(filterSessionList([S], { s1: { deleted: true } }, '').active).toEqual([]);
  });
});

describe('displayTitle / isArchived / isDeleted', () => {
  it('title 优先返回，缺失回落 null', () => {
    expect(displayTitle({}, 's1')).toBeNull();
    expect(displayTitle({ s1: { title: '新标题' } }, 's1')).toBe('新标题');
    expect(displayTitle({ s1: { title: '' } }, 's1')).toBeNull();
  });
  it('archived/deleted 缺省 false；deleted 时不视为 archived', () => {
    expect(isArchived({}, 's1')).toBe(false);
    expect(isArchived({ s1: { archived: true } }, 's1')).toBe(true);
    expect(isArchived({ s1: { archived: true, deleted: true } }, 's1')).toBe(false);
    expect(isDeleted({ s1: { deleted: true } }, 's1')).toBe(true);
  });
});

describe('metadata-file 读写契约（~/.harness2/desktop-metadata.json）', () => {
  it('无文件回落空映射；写 patch 生成文件', () => {
    const home = tempHome();
    expect(readMetadata(home)).toEqual({});
    const after = writeMetadataPatch(home, 's1', { title: '标题甲', archived: true });
    expect(after.s1).toEqual({ title: '标题甲', archived: true });
    const raw = JSON.parse(readFileSync(join(home, '.harness2', 'desktop-metadata.json'), 'utf8')) as SessionMetadataMap;
    expect(raw.s1).toEqual({ title: '标题甲', archived: true });
    expect(readMetadata(home)).toEqual(after);
  });

  it('空 title 不落盘；archived:true 可被 archived:false 清除（恢复）', () => {
    const home = tempHome();
    writeMetadataPatch(home, 's1', { title: '   ', archived: true });
    let raw = JSON.parse(readFileSync(join(home, '.harness2', 'desktop-metadata.json'), 'utf8')) as SessionMetadataMap;
    expect(raw.s1).toEqual({ archived: true });
    const m = writeMetadataPatch(home, 's1', { archived: false });
    expect(m.s1).toEqual({ archived: false });
    raw = JSON.parse(readFileSync(join(home, '.harness2', 'desktop-metadata.json'), 'utf8')) as SessionMetadataMap;
    expect(raw.s1).toEqual({ archived: false }); // false 落盘=显式恢复：normalize 保留 boolean
  });

  it('多个会话各自 patch 互不覆盖', () => {
    const home = tempHome();
    writeMetadataPatch(home, 's1', { title: 'A' });
    const m = writeMetadataPatch(home, 's2', { title: 'B' });
    expect(m.s1).toEqual({ title: 'A' });
    expect(m.s2).toEqual({ title: 'B' });
  });

  it('字段清空后条目移除（写盘语义一致）', () => {
    const home = tempHome();
    writeMetadataPatch(home, 's1', { title: 'A', archived: true });
    const m = writeMetadataPatch(home, 's1', { title: '' });
    expect(m.s1).toEqual({ archived: true });
  });

  it('损坏文件回落空映射（可恢复）', () => {
    const home = tempHome();
    mkdirSync(join(home, '.harness2'), { recursive: true });
    writeFileSync(join(home, '.harness2', 'desktop-metadata.json'), '{broken', 'utf8');
    expect(readMetadata(home)).toEqual({});
  });
});