// P0（A5 P1-2）回归：同一新 chat 并发消息的在途去重。
// 缺陷：resolve 的 get-check 与 await createSession 之间无在途保护——两条并发消息双双 miss，
// 建出两个会话（首会话孤儿、routes.json 只留后者），破坏「每 chat 一个会话」。
// 本文件先红后绿：并发断言 created === 1。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRouter } from '../src/router.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-gw-inflight-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function readTable(home: string): Record<string, { sessionId: string }> {
  return JSON.parse(readFileSync(join(home, '.harness2', 'gateway', 'routes.json'), 'utf8')).map;
}

describe('SessionRouter 在途去重（同一 chat 并发）', () => {
  it('同一新 chat 并发两条消息 → 只建 1 个会话、同一 sessionId、routes.json 一致、无孤儿', async () => {
    const home = tmpDir();
    let created = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const router = new SessionRouter(
      home,
      async () => {
        created += 1;
        const id = `s${created}`;
        await gate; // 模拟 serve 建会话往返延时：放大 get-check 与 createSession 之间的并发窗口
        return { id };
      },
      '/repo',
    );

    const p1 = router.resolve('qq', 'chat-1');
    const p2 = router.resolve('qq', 'chat-1');
    release();
    const [a, b] = await Promise.all([p1, p2]);

    expect(created).toBe(1); // 核心断言：只建 1 个会话（修复前为 2）
    expect(a).toBe('s1');
    expect(b).toBe('s1');
    expect(readTable(home)).toEqual({ 'qq:chat-1': { sessionId: 's1', createdAt: expect.any(String) } });
  });

  it('并发三路 + 后续顺序 resolve 都命中同一会话（在途 promise 落定后落表复用）', async () => {
    const home = tmpDir();
    let created = 0;
    const router = new SessionRouter(
      home,
      async () => {
        created += 1;
        const id = `s${created}`;
        await new Promise((r) => setTimeout(r, 20));
        return { id };
      },
      '/repo',
    );

    const ids = await Promise.all([
      router.resolve('feishu', 'oc_1'),
      router.resolve('feishu', 'oc_1'),
      router.resolve('feishu', 'oc_1'),
    ]);
    expect(ids).toEqual(['s1', 's1', 's1']);
    expect(created).toBe(1);
    expect(await router.resolve('feishu', 'oc_1')).toBe('s1');
    expect(created).toBe(1);
  });

  it('不同 chat 的并发互不串键（各自建 1 个会话）', async () => {
    const home = tmpDir();
    let created = 0;
    const router = new SessionRouter(
      home,
      async () => {
        created += 1;
        const id = `s${created}`;
        await new Promise((r) => setTimeout(r, 10));
        return { id };
      },
      '/repo',
    );
    const [a, b] = await Promise.all([router.resolve('qq', 'c1'), router.resolve('qq', 'c2')]);
    expect(created).toBe(2);
    expect(new Set([a, b]).size).toBe(2);
    expect(Object.keys(readTable(home)).sort()).toEqual(['qq:c1', 'qq:c2']);
  });

  it('建会话失败不毒化在途表：失败后重试可重新建会话并正常落表', async () => {
    const home = tmpDir();
    let attempts = 0;
    const router = new SessionRouter(
      home,
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('serve 不可用');
        return { id: 's-ok' };
      },
      '/repo',
    );

    await expect(router.resolve('qq', 'c1')).rejects.toThrow('serve 不可用');
    expect(await router.resolve('qq', 'c1')).toBe('s-ok');
    expect(attempts).toBe(2);
    expect(readTable(home)['qq:c1']?.sessionId).toBe('s-ok');
  });
});
