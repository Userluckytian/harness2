// D1 会话草稿测试：按会话隔离（A/B 项目不串）+ 持久化往返（desktop-drafts.json）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DRAFT_MAX_CHARS, dropDraft, getDraftValue, normalizeDrafts, setDraftValue } from '../src/shared/drafts.js';
import { draftsFilePath, readDrafts, writeDrafts } from '../src/main/drafts-file.js';
import { AppStore } from '../src/renderer/store.js';

const dirs: string[] = [];
function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-draft-home-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('drafts 纯函数', () => {
  it('normalizeDrafts：只接受非空字符串；非法形状/空串丢弃', () => {
    expect(normalizeDrafts(null)).toEqual({});
    expect(normalizeDrafts([1, 2])).toEqual({});
    expect(normalizeDrafts({ a: 'hi', b: '', c: 42, '': 'x' })).toEqual({ a: 'hi' });
  });

  it('normalizeDrafts：超长草稿截断到上限（防御性）', () => {
    const long = 'x'.repeat(DRAFT_MAX_CHARS + 10);
    expect(normalizeDrafts({ a: long }).a!.length).toBe(DRAFT_MAX_CHARS);
  });

  it('setDraftValue：写入/覆盖；空串删除键（文件保持干净）', () => {
    let m = setDraftValue({}, 's1', '你好');
    expect(m).toEqual({ s1: '你好' });
    m = setDraftValue(m, 's2', 'A 项目草稿');
    expect(getDraftValue(m, 's2')).toBe('A 项目草稿');
    m = setDraftValue(m, 's1', '');
    expect(m.s1).toBeUndefined();
    expect(dropDraft(m, 's2')).toEqual({});
  });
});

describe('desktop-drafts.json 往返（主进程真实 fs）', () => {
  it('写后读回一致；文件缺失/损坏回退空映射', () => {
    const home = tmpHome();
    expect(readDrafts(home)).toEqual({}); // 缺失 → 空
    writeDrafts(home, { s1: '草稿一', s2: '草稿二' });
    expect(readDrafts(home)).toEqual({ s1: '草稿一', s2: '草稿二' });
    // 落盘形状为归一化后的 JSON（换行结尾，便于 diff）
    const raw = readFileSync(draftsFilePath(home), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    // 写非法结构 → 归一化后落盘（不落脏）
    expect(writeDrafts(home, { s1: 123 as never, s2: 'ok' })).toEqual({ s2: 'ok' });
    expect(readDrafts(home)).toEqual({ s2: 'ok' });
  });
});

describe('store 草稿按会话隔离（A/B 项目不串）', () => {
  it('切换会话各自保留草稿；发送方只清自己的', () => {
    const store = new AppStore();
    store.applyDrafts({});
    store.setDraft('A', 'A 项目写到一半');
    store.setDraft('B', 'B 项目另一句');
    expect(store.draftFor('A')).toBe('A 项目写到一半');
    expect(store.draftFor('B')).toBe('B 项目另一句');

    store.setDraft('A', ''); // A 会话发送后清空
    expect(store.draftFor('A')).toBe('');
    expect(store.draftFor('B')).toBe('B 项目另一句'); // B 不受影响
  });

  it('applyDrafts（磁盘回读）整份替换并归一化', () => {
    const store = new AppStore();
    store.setDraft('A', '本地临时');
    store.applyDrafts({ B: '磁盘草稿', bad: 1 });
    expect(store.draftFor('A')).toBe('');
    expect(store.draftFor('B')).toBe('磁盘草稿');
  });
});
