// T5 退出无残留（shell 级 + 进程级）：
//  - in-process：InkShell 真实装配跑一轮 → /exit → createShutdown 单例门（finish/exit 各一次，code 0）
//    → 无 unhandled rejection → vi.getTimerCount()===0（无残留 timer）。
//  - process 级：真实 CLI 走 legacy（piped stdin）路径，跑一轮后 /exit → 退出码 0、进程真正结束。
//    ink 路径无 PTY 无法在 CI 驱动，其退出码契约由 T0 控制器单测覆盖（见 docs 手工验收项）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { createDialogController, InkShell } from '../../src/tui/runInkChat.js';
import { createShutdown } from '../../src/tui/shutdown.js';
import { emptyTranscript, type TranscriptState } from '../../src/tui/transcript.js';
import { mountTui } from './harness.js';
import { createTestRuntime, waitFor, type TestRuntime } from './shell-runtime.js';

const runtimes: TestRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.cleanup();
});

describe('T5 shell 退出无残留（in-process）', () => {
  it('跑一轮 → /exit：单例 finish/exit、code 0、无 unhandled rejection、无残留 timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rejections: unknown[] = [];
    const onRejection = (e: unknown): void => {
      rejections.push(e);
    };
    process.on('unhandledRejection', onRejection);
    const tr = await createTestRuntime();
    runtimes.push(tr);
    let latest: TranscriptState = emptyTranscript();
    const onTranscriptChange = (s: TranscriptState): void => {
      latest = s;
    };
    let unmount: () => void = () => undefined;
    let finishCalls = 0;
    const exitCodes: number[] = [];
    const shutdown = createShutdown({
      finish: async () => {
        finishCalls += 1;
        unmount();
        await tr.runtime.finish({});
      },
      exit: (code) => exitCodes.push(code),
    });
    try {
      const t = mountTui(
        <InkShell
          runtime={tr.runtime}
          bootLines={[]}
          dialog={createDialogController()}
          onExit={(reason) => {
            shutdown.request(reason);
          }}
          onTranscriptChange={onTranscriptChange}
        />,
        { columns: 100, rows: 30 },
      );
      unmount = t.unmount;
      await t.flush();
      t.write('hi');
      await t.flush();
      t.write('\r');
      await waitFor(() => latest.items.some((i) => i.kind === 'assistant'), t.flush);

      t.write('/exit');
      await t.flush();
      t.write('\r');
      const code = await shutdown.awaitDone();
      expect(code).toBe(0);
      expect(exitCodes).toEqual([0]);
      expect(finishCalls).toBe(1);
      // 单例门：再次 request 被拒（finish/exit 不再执行）
      expect(shutdown.request('exit')).toBe(false);
      expect(finishCalls).toBe(1);
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toEqual([]);
      // 无残留 timer：先 drain ink 自身的渲染节流 tick（unmount 后 ~32ms 一次的瞬态；
      // ink 内部定时器，非本项目逻辑），随后必须为 0（调度器/输入/hint 定时器均已在 unmount 清理）。
      vi.advanceTimersByTime(64);
      expect(vi.getTimerCount()).toBe(0);
      await new Promise((r) => setTimeout(r, 20));
      expect(vi.getTimerCount()).toBe(0); // drain 后无新 timer 再生
    } finally {
      process.off('unhandledRejection', onRejection);
      vi.useRealTimers();
    }
  });
});

describe('T5 process 级退出（legacy piped 路径）', () => {
  const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js');

  it('真实 CLI chat --provider mock：跑一轮后 /exit，退出码 0 且无残留子进程', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-t5p-home-'));
    const root = mkdtempSync(join(tmpdir(), 'h2-t5p-root-'));
    let stdout = '';
    let stderr = '';
    const proc = spawn('node', [cliEntry, 'chat', '--provider', 'mock', '--home', home, '--root', root], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    const closed = new Promise<number>((resolve) => proc.on('close', (c) => resolve(c ?? -1)));
    try {
      const waitForText = async (needle: string): Promise<void> => {
        const start = Date.now();
        while (!stdout.includes(needle)) {
          if (Date.now() - start > 15000) {
            throw new Error(`timeout waiting ${needle}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
          }
          await new Promise((r) => setTimeout(r, 40));
        }
      };
      await waitForText('输入 /help 查看命令');
      proc.stdin.write('hi\n');
      await waitForText('[end_turn');
      proc.stdin.write('/exit\n');
      const code = await closed;
      expect(code).toBe(0);
      expect(proc.exitCode).toBe(0); // 进程已退出（无残留子进程）
      expect(`${stdout}${stderr}`).not.toContain('error:');
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
