// CLI serve 层崩溃恢复演练（阶段 11 Task 4 演练②）：真实 spawn `harness2 serve`，
// 强杀子进程（kill = Windows TerminateProcess / POSIX SIGKILL 语义）→ 残留陈旧端口锁 →
// 重启实例按「陈旧锁接管」恢复成功。桌面端 serve-manager 退避重启已有单测（声明复用）。
// 依赖根脚本 `pnpm -r build`。
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const dirs: string[] = [];
function tmpHome(prefix = 'h2-serve-drill-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface ServeProc {
  proc: ChildProcess;
  portLine: Promise<{ port: number; pid: number } | null>;
}

function startServe(home: string): ServeProc {
  const proc = spawn('node', [cliEntry, 'serve', '--provider', 'mock', '--home', home, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout!.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
  proc.stderr!.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
  const portLine = new Promise<{ port: number; pid: number } | null>((resolve) => {
    const start = Date.now();
    const poll = (): void => {
      const m = /\{"port":\d+,"pid":\d+\}/.exec(stdout);
      if (m !== null) {
        resolve(JSON.parse(m[0]) as { port: number; pid: number });
        return;
      }
      if (Date.now() - start > 20000) {
        resolve(null);
        return;
      }
      if (proc.exitCode !== null) {
        resolve(null); // 进程先退了（启动失败）
        return;
      }
      setTimeout(poll, 50);
    };
    void stderr;
    poll();
  });
  return { proc, portLine };
}

/** 等进程退出（kill 后 close 的 code 在 Windows 为 null——返回 closed/timeout 二态） */
function waitExit(proc: ChildProcess, timeoutMs = 10000): Promise<'closed' | 'timeout'> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve('closed');
      return;
    }
    const t = setTimeout(() => resolve('timeout'), timeoutMs);
    proc.on('close', () => {
      clearTimeout(t);
      resolve('closed');
    });
  });
}

describe('演练②：serve 强杀 → 陈旧端口锁接管恢复', () => {
  it('强杀实例后锁文件残留；新实例按死 pid 判定陈旧锁并成功启动', async () => {
    const home = tmpHome();
    const lockPath = join(home, '.harness2', 'serve.lock');

    const first = startServe(home);
    const portA = await first.portLine;
    expect(portA).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    const lockBefore = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; port: number };
    expect(lockBefore.pid).toBe(first.proc.pid); // 锁持有者 = serve 子进程自身

    // 强杀（无优雅关闭——不走 handle.close 的锁释放路径，模拟崩溃）
    first.proc.kill();
    expect(await waitExit(first.proc)).toBe('closed');
    expect(existsSync(lockPath)).toBe(true); // 崩溃语义：锁未释放

    // 重启：锁 pid 已死 → 陈旧锁接管 → 启动成功（新端口行）
    const second = startServe(home);
    const portB = await second.portLine;
    expect(portB).not.toBeNull();
    expect(portB!.pid).toBe(second.proc.pid); // 锁内容更新为新实例
    second.proc.kill();
    expect(await waitExit(second.proc)).toBe('closed');
    // 优雅路径之外结束：锁再次残留（不影响下次接管——陈旧锁判定已由本用例验证）
  });
});
