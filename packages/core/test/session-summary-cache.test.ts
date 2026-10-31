// 会话列表摘要派生缓存（性能修复）：缓存命中不重新解析日志；日志变化或缓存损坏时回落重算。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/session/manager.js';

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-sumcache-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('会话列表摘要缓存', () => {
  it('首次列表写入派生缓存；命中时直接采用缓存；日志变化后重算', () => {
    const root = tmpRoot();
    const sessionsRoot = join(root, 'sessions');
    const mgr = new SessionManager(sessionsRoot);
    const cwd = root;

    const { id, writer } = mgr.create(cwd, { fsync: false });
    writer.append('user/message', { text: 'hello cache', turnId: 't1' });
    writer.close();

    const first = mgr.list(cwd).find((s) => s.id === id);
    expect(first?.firstUserText).toBe('hello cache');
    expect(first?.messageCount).toBe(1);

    const cacheDir = join(sessionsRoot, '.summary-cache');
    const cacheFiles = readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
    expect(cacheFiles.length).toBe(1);

    // 命中：篡改缓存内容后仍应被采用（证明列表没有重新解析日志）
    const cachePath = join(cacheDir, cacheFiles[0]!);
    const raw = JSON.parse(readFileSync(cachePath, 'utf8')) as { v: number; core: Record<string, unknown> };
    raw.core.firstUserText = 'FROM-CACHE';
    writeFileSync(cachePath, JSON.stringify(raw));
    expect(mgr.list(cwd).find((s) => s.id === id)?.firstUserText).toBe('FROM-CACHE');

    // 日志变化（大小/mtime 改变）→ 缓存失效，重新解析得到真实摘要
    const resumed = mgr.resume(id, { cwd, fsync: false });
    resumed.writer.append('user/message', { text: 'second', turnId: 't2' });
    resumed.writer.close();
    const after = mgr.list(cwd).find((s) => s.id === id);
    expect(after?.firstUserText).toBe('hello cache');
    expect(after?.messageCount).toBe(2);
  });

  it('缓存文件损坏时不抛错，回落为重新解析', () => {
    const root = tmpRoot();
    const sessionsRoot = join(root, 'sessions');
    const mgr = new SessionManager(sessionsRoot);
    const { id, writer } = mgr.create(root, { fsync: false });
    writer.append('user/message', { text: 'ok', turnId: 't1' });
    writer.close();

    mgr.list(root);
    const cacheDir = join(sessionsRoot, '.summary-cache');
    for (const f of readdirSync(cacheDir)) writeFileSync(join(cacheDir, f), '{not json');

    const got = mgr.list(root).find((s) => s.id === id);
    expect(got?.firstUserText).toBe('ok');
  });
});
