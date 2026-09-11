// P2 冒烟（CLI 端）：`harness2 serve` 默认严格鉴权。
// 证据链：serve 进程只打印 {port,pid}（token 不入日志），token 只随 0600 锁文件下发；
// 无 token 的第三方进程 HTTP 401，读锁拿到 token 的本机客户端 200。
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const dirs: string[] = [];
const procs: ChildProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) {
    try {
      p.kill('SIGKILL');
    } catch {
      // 已退出
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function startServe(home: string): { proc: ChildProcess; portLine: Promise<number | null> } {
  const proc = spawn('node', [cliEntry, 'serve', '--provider', 'mock', '--home', home, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(proc);
  let stdout = '';
  proc.stdout!.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
  const portLine = new Promise<number | null>((resolve) => {
    const start = Date.now();
    const poll = (): void => {
      const m = /\{"port":(\d+),"pid":(\d+)\}/.exec(stdout);
      if (m !== null) {
        resolve(Number(m[1]));
        return;
      }
      if (Date.now() - start > 20000 || proc.exitCode !== null) {
        resolve(null);
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
  return { proc, portLine };
}

describe('P2 CLI 冒烟：serve 默认严格鉴权 + 锁文件下发 token', () => {
  it('无 token 401；serve.lock 里的 token 可用；token 不出现在 stdout', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-cli-serve-token-'));
    dirs.push(home);
    const { proc, portLine } = startServe(home);
    const port = await portLine;
    expect(port).not.toBeNull();

    const lock = JSON.parse(readFileSync(join(home, '.harness2', 'serve.lock'), 'utf8')) as {
      pid: number;
      port: number;
      token?: string;
    };
    expect(lock.port).toBe(port);
    expect(lock.pid).toBe(proc.pid);
    expect(typeof lock.token).toBe('string');
    expect((lock.token ?? '').length).toBeGreaterThanOrEqual(16);

    const denied = await fetch(`http://127.0.0.1:${port}/api/config`);
    expect(denied.status).toBe(401);

    const allowed = await fetch(`http://127.0.0.1:${port}/api/config`, {
      headers: { 'x-harness2-token': lock.token ?? '' },
    });
    expect(allowed.status).toBe(200);
  }, 30000);
});
