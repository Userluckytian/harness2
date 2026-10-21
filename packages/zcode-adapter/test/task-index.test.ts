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
