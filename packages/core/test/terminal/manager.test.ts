// Z9-1（2026-10-13）core 终端管理器（PTY）测试。冻结契约见
// docs/ai-framework/plans/2026-10-13-phase-Z9-terminal-and-web-settings.md §1.1。
//   1) 假 PTY（注入 spawnPty）：签名/转调/未知 id/data·exit 带 id 转发/去重/dispose/反订阅；
//   2) 真 PTY 冒烟（平台支持时）：默认 shell 回显标记串；不可用则如实 skip，不假通过。
import { describe, expect, it } from 'vitest';
import {
  createTerminalManager,
  TerminalUnavailableError,
  type PtyLike,
  type TerminalEvent,
} from '../../src/terminal/index.js';

/** 可控假 PTY：手动触发 data/exit，记录转调。 */
class FakePty implements PtyLike {
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killCount = 0;
  private readonly dataCbs: Array<(data: string) => void> = [];
  private readonly exitCbs: Array<(e: { exitCode?: number }) => void> = [];

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb);
  }

  onExit(cb: (e: { exitCode?: number }) => void): void {
    this.exitCbs.push(cb);
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killCount += 1;
  }

  emitData(data: string): void {
    for (const cb of [...this.dataCbs]) cb(data);
  }

  emitExit(exitCode?: number): void {
    for (const cb of [...this.exitCbs]) cb({ exitCode });
  }
}

interface SpawnCall {
  file: string;
  args: string[];
  opts: Record<string, unknown>;
}

function harness(deps: { defaultShell?: string } = {}) {
  const calls: SpawnCall[] = [];
  const fakes: FakePty[] = [];
  const manager = createTerminalManager({
    defaultShell: deps.defaultShell,
    spawnPty: (file, args, opts) => {
      const pty = new FakePty();
      calls.push({ file, args, opts });
      fakes.push(pty);
      return pty;
    },
  });
  return { manager, calls, fakes };
}

describe('terminal/manager（假 PTY 路径）', () => {
  it('spawn 返回 id，并转调 spawnPty（shell/cols/rows/cwd/env）', () => {
    const { manager, calls, fakes } = harness({ defaultShell: '/fake/shell' });
    const { id } = manager.spawn({ cols: 80, rows: 24, cwd: '/tmp/x', env: { FOO: 'bar' } });

    expect(id).toBe('t-1');
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.file).toBe('/fake/shell');
    expect(call.args).toEqual([]);
    expect(call.opts).toMatchObject({ name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp/x' });
    expect((call.opts.env as Record<string, string>).FOO).toBe('bar');
    expect(manager.list()).toEqual(['t-1']);
    expect(fakes[0]!.killCount).toBe(0);
  });

  it('opts.shell 覆盖 deps.defaultShell；deps.defaultShell 覆盖平台默认', () => {
    const a = harness({ defaultShell: 'shell-a' });
    a.manager.spawn({ cols: 1, rows: 1 });
    expect(a.calls[0]!.file).toBe('shell-a');

    const b = harness({ defaultShell: 'shell-b' });
    b.manager.spawn({ cols: 1, rows: 1, shell: 'shell-c' });
    expect(b.calls[0]!.file).toBe('shell-c');
  });

  it('无覆盖时默认 shell 按平台取值（Windows ComSpec/cmd.exe，其余 SHELL//bin/bash）', () => {
    const { manager, calls } = harness();
    manager.spawn({ cols: 1, rows: 1 });
    const expected =
      process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/bash');
    expect(calls[0]!.file).toBe(expected);
  });

  it('id 递增；write/resize/kill 转调假对象，未知 id 返回 false 且不抛', () => {
    const { manager, fakes } = harness({ defaultShell: 's' });
    const { id: id1 } = manager.spawn({ cols: 1, rows: 1 });
    const { id: id2 } = manager.spawn({ cols: 1, rows: 1 });
    expect([id1, id2]).toEqual(['t-1', 't-2']);

    expect(manager.write(id1, 'hi')).toBe(true);
    expect(fakes[0]!.writes).toEqual(['hi']);
    expect(manager.resize(id1, 120, 40)).toBe(true);
    expect(fakes[0]!.resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(manager.kill(id2)).toBe(true);
    expect(fakes[1]!.killCount).toBe(1);

    expect(manager.write('nope', 'x')).toBe(false);
    expect(manager.resize('nope', 1, 1)).toBe(false);
    expect(manager.kill('nope')).toBe(false);
  });

  it('data/exit 事件按 onEvent 回调转发且带 id；exit 后 id 不再可用', () => {
    const { manager, fakes } = harness({ defaultShell: 's' });
    const events: TerminalEvent[] = [];
    manager.onEvent((e) => events.push(e));
    const { id } = manager.spawn({ cols: 1, rows: 1 });

    fakes[0]!.emitData('chunk-1');
    fakes[0]!.emitData('chunk-2');
    expect(events).toEqual([
      { type: 'data', id, data: 'chunk-1' },
      { type: 'data', id, data: 'chunk-2' },
    ]);

    fakes[0]!.emitExit(0);
    expect(events[2]).toEqual({ type: 'exit', id, exitCode: 0 });
    expect(manager.list()).toEqual([]);
    expect(manager.write(id, 'x')).toBe(false);
    expect(manager.resize(id, 1, 1)).toBe(false);
    expect(manager.kill(id)).toBe(false);
  });

  it('kill 后从表摘除、停止转发 data，但 exit 仍至多一次', () => {
    const { manager, fakes } = harness({ defaultShell: 's' });
    const events: TerminalEvent[] = [];
    manager.onEvent((e) => events.push(e));
    const { id } = manager.spawn({ cols: 1, rows: 1 });

    expect(manager.kill(id)).toBe(true);
    expect(manager.list()).toEqual([]);
    fakes[0]!.emitData('after-kill');
    expect(events).toEqual([]);

    fakes[0]!.emitExit(3);
    fakes[0]!.emitExit(3); // 去重：exit 只回调一次
    expect(events).toEqual([{ type: 'exit', id, exitCode: 3 }]);
  });

  it('exit 去重：同一 id 重复 exit 只转发一次', () => {
    const { manager, fakes } = harness({ defaultShell: 's' });
    const exits: TerminalEvent[] = [];
    manager.onEvent((e) => {
      if (e.type === 'exit') exits.push(e);
    });
    const { id } = manager.spawn({ cols: 1, rows: 1 });
    fakes[0]!.emitExit(0);
    fakes[0]!.emitExit(0);
    fakes[0]!.emitExit(1);
    expect(exits).toEqual([{ type: 'exit', id, exitCode: 0 }]);
  });

  it('onEvent 反订阅生效（取消后不再收到）', () => {
    const { manager, fakes } = harness({ defaultShell: 's' });
    const got: string[] = [];
    const unsub = manager.onEvent((e) => got.push(e.type));
    const { id } = manager.spawn({ cols: 1, rows: 1 });
    fakes[0]!.emitData('a');
    unsub();
    fakes[0]!.emitData('b');
    fakes[0]!.emitExit(0);
    expect(got).toEqual(['data']);
    expect(manager.write(id, 'x')).toBe(false);
  });

  it('dispose() 杀掉全部、清空表、停止转发；幂等', () => {
    const { manager, fakes } = harness({ defaultShell: 's' });
    const events: TerminalEvent[] = [];
    manager.onEvent((e) => events.push(e));
    const a = manager.spawn({ cols: 1, rows: 1 });
    const b = manager.spawn({ cols: 1, rows: 1 });

    manager.dispose();
    expect(fakes[0]!.killCount).toBe(1);
    expect(fakes[1]!.killCount).toBe(1);
    expect(manager.list()).toEqual([]);

    fakes[0]!.emitData('after-dispose');
    fakes[0]!.emitExit(0);
    expect(events).toEqual([]);
    expect(manager.write(a.id, 'x')).toBe(false);
    expect(manager.write(b.id, 'x')).toBe(false);

    manager.dispose(); // 幂等：不重复 kill
    expect(fakes[0]!.killCount).toBe(1);
    expect(fakes[1]!.killCount).toBe(1);
  });

  it('TerminalUnavailableError 是可导出的错误类型（如实失败，不静默降级）', () => {
    const err = new TerminalUnavailableError('平台不支持');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TerminalUnavailableError');
    expect(err.message).toContain('平台不支持');
  });

  it('注入的 spawnPty 抛错时 spawn 原样上抛（不吞错）', () => {
    const manager = createTerminalManager({
      spawnPty: () => {
        throw new Error('boom');
      },
    });
    expect(() => manager.spawn({ cols: 1, rows: 1 })).toThrowError(/boom/);
    expect(manager.list()).toEqual([]);
  });
});

const REAL_PTY_PLATFORM = process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin';
const MARKER = 'HARNESS2-PTY-OK';

describe('terminal/manager（真 PTY 冒烟）', () => {
  it.skipIf(!REAL_PTY_PLATFORM)(
    `真 spawn 默认 shell → write('echo ${MARKER}') → 超时内收到含标记串的 data → kill`,
    async (ctx) => {
      const manager = createTerminalManager();
      const chunks: string[] = [];
      let exited: { exitCode: number | undefined } | null = null;
      const seen = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`超时未见到 ${MARKER}`)), 15000);
        manager.onEvent((e) => {
          if (e.type === 'data') {
            chunks.push(e.data);
            if (chunks.join('').includes(MARKER)) {
              clearTimeout(timer);
              resolve();
            }
          } else {
            exited = { exitCode: e.exitCode };
          }
        });
      });

      let id: string;
      try {
        ({ id } = manager.spawn({ cols: 80, rows: 24, cwd: process.cwd() }));
      } catch (err) {
        if (err instanceof TerminalUnavailableError) {
          ctx.skip(`真 PTY 不可用（如实跳过）：${err.message}`);
          return;
        }
        throw err;
      }

      try {
        manager.write(id, `echo ${MARKER}\r\n`);
        await seen;
        expect(chunks.join('')).toContain(MARKER);
      } finally {
        manager.kill(id);
        manager.dispose();
      }
      void exited;
    },
  );
});
