import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRouter, routeKey } from '../src/router.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-gw-router-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('SessionRouter', () => {
  it('resolve 无映射时建新会话并持久化；再次 resolve 复用同一会话', async () => {
    const home = tmpDir();
    let created = 0;
    const router = new SessionRouter(
      home,
      async () => {
        created += 1;
        return { id: `s${created}` };
      },
      '/repo',
    );

    const first = await router.resolve('qq', 'chat-1');
    expect(first).toBe('s1');
    const again = await router.resolve('qq', 'chat-1');
    expect(again).toBe('s1');
    expect(created).toBe(1);

    // 持久化：新路由器实例读同一文件
    const reloaded = new SessionRouter(
      home,
      async () => {
        throw new Error('不应再建会话');
      },
      '/repo',
    );
    expect(await reloaded.resolve('qq', 'chat-1')).toBe('s1');
    expect(
      JSON.parse(readFileSync(join(home, '.harness2', 'gateway', 'routes.json'), 'utf8')).map['qq:chat-1'].sessionId,
    ).toBe('s1');
  });

  it('不同平台/chatId 路由独立', async () => {
    const home = tmpDir();
    let n = 0;
    const router = new SessionRouter(home, async () => ({ id: `s${++n}` }), '/repo');
    expect(await router.resolve('qq', 'c1')).toBe('s1');
    expect(await router.resolve('feishu', 'c1')).toBe('s2');
    expect(await router.resolve('qq', 'c2')).toBe('s3');
  });

  it('损坏的 routes.json 重置并告警（不抛错）', async () => {
    const home = tmpDir();
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(home, '.harness2', 'gateway'), { recursive: true });
    writeFileSync(join(home, '.harness2', 'gateway', 'routes.json'), '{broken');
    const errors: string[] = [];
    const router = new SessionRouter(
      home,
      async () => ({ id: 'fresh' }),
      '/repo',
      (m) => errors.push(m),
    );
    expect(await router.resolve('qq', 'c1')).toBe('fresh');
    expect(errors[0]).toMatch(/损坏/);
  });

  it('routeKey 格式', () => {
    expect(routeKey('qq', 'ABC')).toBe('qq:ABC');
  });
});
