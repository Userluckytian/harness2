// chat 分叉集成测试（piped stdin 非交互，阶段 6 Task 5）：
//   --fork <id> 启动即分叉（banner 标血缘、复制事件数）；REPL /fork 从当前会话分叉并切换；
//   /fork 非法参数报错。依赖根脚本 `pnpm -r build`。mock provider 全程零 API key。
import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSessionsRoot, loadSession, SessionManager } from '@harness2/core';

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

interface ChatProc {
  out(): string;
  wait(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
  send(line: string): void;
  exit(timeoutMs?: number): Promise<number>;
}

function startChat(args: string[]): ChatProc {
  const proc: ChildProcess = spawn('node', [cliEntry, 'chat', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout!.on('data', (c: Buffer) => {
    stdout += c.toString('utf8');
  });
  proc.stderr!.on('data', (c: Buffer) => {
    stderr += c.toString('utf8');
  });
  return {
    out: () => stdout,
    async wait(pattern, timeoutMs = 15000) {
      const test = typeof pattern === 'string' ? () => stdout.includes(pattern) : () => pattern.test(stdout);
      const start = Date.now();
      while (!test()) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `waitFor timeout (${String(pattern)});\n--- stdout ---\n${stdout.slice(-2000)}\n--- stderr ---\n${stderr}`,
          );
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      return stdout;
    },
    send(line: string) {
      proc.stdin!.write(line + '\n');
    },
    async exit(timeoutMs = 10000) {
      if (proc.stdin!.writable && !proc.stdin!.destroyed) {
        this.send('/exit');
        proc.stdin!.end();
      }
      const code = await new Promise<number | null>((resolve) => {
        const t = setTimeout(() => {
          proc.kill();
          resolve(null);
        }, timeoutMs);
        proc.on('close', (c) => {
          clearTimeout(t);
          resolve(c);
        });
      });
      return code ?? -1;
    },
  };
}

/** 预置一个含一轮对话的原始会话（进程内写，与 CLI 共享 --home 会话根） */
function seedSession(home: string, work: string): string {
  const manager = new SessionManager(defaultSessionsRoot(home));
  const created = manager.create(work);
  created.writer.append('user/message', { text: '原始会话第一句', turnId: 't1' });
  created.writer.append('assistant/message', { text: '原始会话回复', turnId: 't1' });
  created.writer.close();
  return created.id;
}

describe('harness2 chat 会话分叉', () => {
  it('--fork <id>：启动即分叉，banner 标血缘；继续对话落在分叉会话', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-fork-home-'));
    const work = mkdtempSync(join(tmpdir(), 'h2-fork-work-'));
    try {
      const parentId = seedSession(home, work);
      const chat = startChat(['--provider', 'mock', '--fork', parentId, '--home', home, '--root', work]);
      await chat.wait(/分叉/);
      expect(chat.out()).toContain(`自 ${parentId} 分叉`);
      expect(chat.out()).toContain('复制 2 个活动事件');
      // 分叉会话继续对话（mock 演示脚本第一轮）
      chat.send('分叉后的第一句');
      await chat.wait('好的，');
      await chat.exit();

      // 从 banner 提取分叉会话 id，经内核 loadSession 校验血缘与内容
      const match = /会话: (\S+)（自 \S+ 分叉/.exec(chat.out());
      expect(match).not.toBeNull();
      const forkedId = match![1]!;
      const manager = new SessionManager(defaultSessionsRoot(home));
      const forkedDir = manager.locate(forkedId);
      const forked = loadSession(forkedDir);
      expect(forked.header).toMatchObject({ parentSession: parentId, isSeeded: true });
      const texts = forked.events.map((x) =>
        x.event.type === 'user/message' || x.event.type === 'assistant/message' ? x.event.payload.text : '',
      );
      expect(texts).toContain('原始会话第一句'); // 复制的活动事件
      expect(texts).toContain('分叉后的第一句'); // 分叉后的新对话
      expect(forked.events.some((x) => x.event.type === 'memory/snapshot')).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  }, 30000);

  it('REPL /fork：从当前会话分叉并切换；/fork abc 报错', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-fork-repl-home-'));
    const work = mkdtempSync(join(tmpdir(), 'h2-fork-repl-work-'));
    try {
      const chat = startChat(['--provider', 'mock', '--home', home, '--root', work]);
      await chat.wait(/会话: \S+（新建）/);
      chat.send('第一句');
      await chat.wait('好的，');
      chat.send('/fork abc');
      await chat.wait(/无效的事件序号/);
      chat.send('/fork');
      await chat.wait(/分叉，复制/);
      // /sessions 列表把分叉会话标记为当前
      chat.send('/sessions');
      await chat.wait(/\* /);
      await chat.exit();
      expect(chat.out()).toContain('自 ');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  }, 30000);
});
