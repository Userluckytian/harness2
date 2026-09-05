// 文件快照存储测试：capture/commitAfter/restore/restoreAfter/冲突检测/dryRun/崩溃残行。
// 全部使用临时目录（快照内容可能含用户代码，不入测试仓库——Global Constraint 2）。
import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REWIND_POINTS_FILE, SnapshotStore, snapshotTargetFile, readTextOrNull } from '../src/session/snapshots.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-snap-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function snap(dir = tmpDir()): SnapshotStore {
  return new SnapshotStore(dir);
}

describe('capture / commitAfter 落盘', () => {
  it('capture+commitAfter 追加一条 JSONL；条目含绝对路径与 before/after', () => {
    const dir = tmpDir();
    const store = snap(dir);
    store.capture({ seq: 5, file: 'a.txt', before: 'old' }); // 相对路径按进程 cwd 规范化
    store.commitAfter({ seq: 5, after: 'new' });

    const text = readFileSync(join(dir, REWIND_POINTS_FILE), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const entry = JSON.parse(text.trim()) as { v: number; seq: number; file: string; before: string; after: string };
    expect(entry.seq).toBe(5);
    expect(entry.before).toBe('old');
    expect(entry.after).toBe('new');
    expect(entry.file).not.toBe('a.txt'); // 已规范化为绝对路径
    expect(entry.file.endsWith(`a.txt`)).toBe(true);
  });

  it('绝对路径原样保存；多次条目逐行追加', () => {
    const dir = tmpDir();
    const abs = join(dir, 'sub', 'x.txt');
    const store = snap(dir);
    store.capture({ seq: 1, file: abs, before: null });
    store.commitAfter({ seq: 1, after: 'v1' });
    store.capture({ seq: 2, file: abs, before: 'v1' });
    store.commitAfter({ seq: 2, after: 'v2' });

    const lines = readFileSync(join(dir, REWIND_POINTS_FILE), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const entries = lines.map((l) => JSON.parse(l) as { file: string });
    expect(entries[0]!.file).toBe(abs);
    expect(entries[1]!.file).toBe(abs);
  });

  it('commitAfter 未先 capture → 抛错（协议误用即失败）', () => {
    const store = snap();
    expect(() => store.commitAfter({ seq: 9, after: 'x' })).toThrow(/commitAfter without capture for seq 9/);
  });

  it('只 capture 不 commitAfter（失败/取消路径）→ 不产生任何落盘条目', () => {
    const dir = tmpDir();
    const store = snap(dir);
    store.capture({ seq: 3, file: 'a.txt', before: 'x' });
    expect(existsSync(join(dir, REWIND_POINTS_FILE))).toBe(false);
    expect(store.entries()).toEqual([]);
  });

  it('同 seq 二次 capture 覆盖待写表（以最后一次为准）', () => {
    const dir = tmpDir();
    const store = snap(dir);
    store.capture({ seq: 4, file: 'a.txt', before: 'first' });
    store.capture({ seq: 4, file: 'b.txt', before: 'second' });
    store.commitAfter({ seq: 4, after: 'done' });
    const entries = store.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ seq: 4, before: 'second', after: 'done' });
    expect(entries[0]!.file.endsWith('b.txt')).toBe(true);
  });
});

describe('restore（undo：seq > toSeq 取每文件最早一条恢复 before）', () => {
  it('恢复 before 内容；dryRun 不落盘', () => {
    const dir = tmpDir();
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'current', 'utf8');
    const store = snap(dir);
    store.capture({ seq: 5, file, before: 'before-content' });
    store.commitAfter({ seq: 5, after: 'current' });

    const dry = store.restore(2, { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.items).toHaveLength(1);
    expect(dry.items[0]).toMatchObject({
      file,
      target: 'before-content',
      current: 'current',
      externallyModified: false,
      restored: false,
    });
    expect(readFileSync(file, 'utf8')).toBe('current'); // dryRun 无副作用

    const real = store.restore(2);
    expect(real.items[0]!.restored).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('before-content');
  });

  it('创建的文件（before=null）恢复为删除', () => {
    const dir = tmpDir();
    const file = join(dir, 'created.txt');
    writeFileSync(file, 'data', 'utf8');
    const store = snap(dir);
    store.capture({ seq: 2, file, before: null });
    store.commitAfter({ seq: 2, after: 'data' });

    const result = store.restore(1);
    expect(result.items[0]).toMatchObject({ target: null, restored: true });
    expect(existsSync(file)).toBe(false);
  });

  it('同文件多次修改：恢复最早一条的 before；冲突基准 = 最新 after', () => {
    const dir = tmpDir();
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'C', 'utf8');
    const store = snap(dir);
    store.capture({ seq: 5, file, before: 'A' });
    store.commitAfter({ seq: 5, after: 'B' });
    store.capture({ seq: 8, file, before: 'B' });
    store.commitAfter({ seq: 8, after: 'C' });

    const result = store.restore(4); // 撤掉两次修改 → 回到 A
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ target: 'A', current: 'C', externallyModified: false, restored: true });
    expect(readFileSync(file, 'utf8')).toBe('A');
  });

  it('部分撤回：toSeq 落在中间 → 只撤其后的修改（恢复中间态）', () => {
    const dir = tmpDir();
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'C', 'utf8');
    const store = snap(dir);
    store.capture({ seq: 5, file, before: 'A' });
    store.commitAfter({ seq: 5, after: 'B' });
    store.capture({ seq: 8, file, before: 'B' });
    store.commitAfter({ seq: 8, after: 'C' });

    const result = store.restore(5); // 只撤 seq8 的修改
    expect(result.items[0]).toMatchObject({ target: 'B', restored: true });
    expect(readFileSync(file, 'utf8')).toBe('B');
  });

  it('冲突检测：当前内容 ≠ 最新 after → externallyModified，实际恢复仍执行', () => {
    const dir = tmpDir();
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'externally-edited', 'utf8');
    const store = snap(dir);
    store.capture({ seq: 5, file, before: 'A' });
    store.commitAfter({ seq: 5, after: 'B' });

    const dry = store.restore(4, { dryRun: true });
    expect(dry.items[0]!.externallyModified).toBe(true);
    expect(dry.items[0]!.restored).toBe(false);

    const real = store.restore(4); // 报告后仍执行
    expect(real.items[0]!.externallyModified).toBe(true);
    expect(real.items[0]!.restored).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('A');
  });

  it('toSeq 边界：seq == toSeq 的条目不参与恢复（严格大于）', () => {
    const dir = tmpDir();
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'now', 'utf8');
    const store = snap(dir);
    store.capture({ seq: 5, file, before: 'old' });
    store.commitAfter({ seq: 5, after: 'now' });

    expect(store.restore(5).items).toHaveLength(0);
    expect(store.restore(6).items).toHaveLength(0);
    expect(readFileSync(file, 'utf8')).toBe('now');
  });

  it('无命中条目 / 快照文件不存在 → 空结果', () => {
    const dir = tmpDir();
    const store = snap(dir);
    expect(store.restore(1)).toEqual({ dryRun: false, items: [] });
    const store2 = snap(tmpDir());
    expect(store2.restore(1).items).toEqual([]);
  });
});

describe('restoreAfter（redo：seq > fromSeq 取每文件最新一条恢复 after）', () => {
  it('单文件单次修改：恢复 after', () => {
    const dir = tmpDir();
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'A', 'utf8'); // undo 已恢复到 before
    const store = snap(dir);
    store.capture({ seq: 5, file, before: 'A' });
    store.commitAfter({ seq: 5, after: 'B' });

    const result = store.restoreAfter(4);
    expect(result.items[0]).toMatchObject({ target: 'B', current: 'A', externallyModified: false, restored: true });
    expect(readFileSync(file, 'utf8')).toBe('B');
  });

  it('同文件多次修改：恢复最新一条的 after；冲突基准 = 最早一条的 before', () => {
    const dir = tmpDir();
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'A', 'utf8'); // undo（撤两次）后的状态
    const store = snap(dir);
    store.capture({ seq: 5, file, before: 'A' });
    store.commitAfter({ seq: 5, after: 'B' });
    store.capture({ seq: 8, file, before: 'B' });
    store.commitAfter({ seq: 8, after: 'C' });

    const result = store.restoreAfter(4);
    expect(result.items[0]).toMatchObject({ target: 'C', externallyModified: false, restored: true });
    expect(readFileSync(file, 'utf8')).toBe('C');
  });

  it('创建的文件 redo：after 仍有内容则写回；undo 已删除（before=null → 文件已不存在）', () => {
    const dir = tmpDir();
    const file = join(dir, 'created.txt');
    const store = snap(dir);
    store.capture({ seq: 2, file, before: null });
    store.commitAfter({ seq: 2, after: 'data' });

    const result = store.restoreAfter(1);
    expect(result.items[0]).toMatchObject({ target: 'data', current: null, externallyModified: false, restored: true });
    expect(readFileSync(file, 'utf8')).toBe('data');
  });

  it('dryRun 列出计划但不写盘', () => {
    const dir = tmpDir();
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'A', 'utf8');
    const store = snap(dir);
    store.capture({ seq: 5, file, before: 'A' });
    store.commitAfter({ seq: 5, after: 'B' });

    const result = store.restoreAfter(4, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.items[0]).toMatchObject({ target: 'B', restored: false });
    expect(readFileSync(file, 'utf8')).toBe('A');
  });
});

describe('崩溃残行容错与多文件', () => {
  it('末尾无换行的撕裂行与非法 JSON 行跳过，合法条目保留', () => {
    const dir = tmpDir();
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'x', 'utf8');
    const good = JSON.stringify({ v: 1, seq: 3, file, before: 'b1', after: 'a1' });
    const torn = JSON.stringify({ v: 1, seq: 4, file, before: 'b2' }).slice(0, 20); // 半行
    appendFileSync(join(dir, REWIND_POINTS_FILE), `${good}\n${torn}`, 'utf8'); // 无结尾 \n

    const store = snap(dir);
    const entries = store.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.seq).toBe(3);

    const result = store.restore(1);
    expect(result.items[0]).toMatchObject({ target: 'b1', restored: true });
  });

  it('多文件恢复：各自独立恢复并保持稳定顺序', () => {
    const dir = tmpDir();
    const f1 = join(dir, 'a.txt');
    const f2 = join(dir, 'b.txt');
    writeFileSync(f1, 'a2', 'utf8');
    writeFileSync(f2, 'b2', 'utf8');
    const store = snap(dir);
    store.capture({ seq: 2, file: f1, before: 'a1' });
    store.commitAfter({ seq: 2, after: 'a2' });
    store.capture({ seq: 3, file: f2, before: 'b1' });
    store.commitAfter({ seq: 3, after: 'b2' });

    const result = store.restore(1);
    expect(result.items.map((i) => i.target)).toEqual(['a1', 'b1']);
    expect(readFileSync(f1, 'utf8')).toBe('a1');
    expect(readFileSync(f2, 'utf8')).toBe('b1');
  });

  it('单文件恢复失败转 item.error，不中断其余文件', () => {
    const dir = tmpDir();
    const f1 = join(dir, 'ok.txt');
    const f2 = join(dir, 'bad', 'nested.txt');
    mkdirSync(join(dir, 'bad'), { recursive: true });
    writeFileSync(f1, 'a2', 'utf8');
    writeFileSync(f2, 'b2', 'utf8');
    const store = snap(dir);
    store.capture({ seq: 2, file: f1, before: 'a1' });
    store.commitAfter({ seq: 2, after: 'a2' });
    store.capture({ seq: 3, file: f2, before: null });
    store.commitAfter({ seq: 3, after: 'b2' });

    // 制造单文件写入失败：把 f2 的父目录替换成同名普通文件（writeAtomic 的 mkdir 会失败）
    rmSync(f2);
    rmSync(join(dir, 'bad'), { recursive: true });
    writeFileSync(join(dir, 'bad'), 'not-a-dir', 'utf8');

    // restoreAfter(1)：两文件目标均为内容写回（after）→ f1 成功、f2 失败
    const result = store.restoreAfter(1);
    const okItem = result.items.find((i) => i.file === f1)!;
    const badItem = result.items.find((i) => i.file === f2)!;
    expect(okItem.restored).toBe(true);
    expect(badItem.restored).toBe(false);
    expect(badItem.error).toBeTruthy();
  });
});

describe('snapshotTargetFile / readTextOrNull（loop 钩子助手）', () => {
  it('write/edit 从 file_path 解析绝对路径；其它工具返回 null', () => {
    const cwd = tmpDir();
    expect(snapshotTargetFile('write', { file_path: 'a.txt' }, cwd)).toBe(join(cwd, 'a.txt'));
    expect(snapshotTargetFile('edit', { file_path: 'a.txt' }, cwd)).toBe(join(cwd, 'a.txt'));
    expect(snapshotTargetFile('bash', { file_path: 'a.txt' }, cwd)).toBeNull();
    expect(snapshotTargetFile('read', { file_path: 'a.txt' }, cwd)).toBeNull();
  });

  it('参数形态异常返回 null；绝对路径原样', () => {
    const cwd = tmpDir();
    expect(snapshotTargetFile('write', null, cwd)).toBeNull();
    expect(snapshotTargetFile('write', { file_path: 42 }, cwd)).toBeNull();
    expect(snapshotTargetFile('write', { file_path: '' }, cwd)).toBeNull();
    const abs = join(cwd, 'x.txt');
    expect(snapshotTargetFile('edit', { file_path: abs }, cwd)).toBe(abs);
  });

  it('readTextOrNull：存在返回内容，不存在返回 null', () => {
    const dir = tmpDir();
    const file = join(dir, 'a.txt');
    expect(readTextOrNull(file)).toBeNull();
    writeFileSync(file, '内容', 'utf8');
    expect(readTextOrNull(file)).toBe('内容');
  });
});
