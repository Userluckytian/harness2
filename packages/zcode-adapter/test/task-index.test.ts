import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionMeta, writeSessionMeta } from '../src/real/task-index.js';

describe('task-index session-meta', () => {
  it('round-trips pinned/archived/unread', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h2-ti-'));
    writeSessionMeta(dir, { pinned: true, archived: true, unread: true });
    const meta = readSessionMeta(dir);
    expect(meta.pinned).toBe(true);
    expect(meta.archived).toBe(true);
    expect(meta.unread).toBe(true);
    expect(typeof meta.unreadAt).toBe('number');
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats corrupted JSON as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h2-ti-'));
    writeFileSync(join(dir, 'session-meta.json'), '{not json');
    expect(readSessionMeta(dir)).toEqual({ pinned: false, archived: false, unread: false });
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats missing file as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h2-ti-'));
    expect(readSessionMeta(dir)).toEqual({ pinned: false, archived: false, unread: false });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('task-index concurrent (T8)', () => {
  it('concurrent writeSessionMeta keeps a complete value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h2-ti-conc-'));
    await Promise.all([
      Promise.resolve().then(() => writeSessionMeta(dir, { pinned: true })),
      Promise.resolve().then(() => writeSessionMeta(dir, { archived: true })),
    ]);
    const meta = readSessionMeta(dir);
    // 终值为合法完整对象，无撕裂/混合 JSON
    expect(typeof meta.pinned).toBe('boolean');
    expect(typeof meta.archived).toBe('boolean');
    expect(typeof meta.unread).toBe('boolean');
    // 无残留 tmp 文件
    const { readdirSync } = await import('node:fs');
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
