// G-47/G-48/G-49 执行层单测（spawn 注入式 fake）：stdin 契约、超时即杀、64KiB 截断停脚本、
// 退出码失败、启动失败、直接执行 vs shell 解释判定、unified 日志路径与追加（G-48）。
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import {
  appendStatusLineFailureLog,
  isExecutablePath,
  runStatusLineCommand,
  unifiedLogPath,
  type SpawnLike,
} from '../../../src/tui/status-line/runner.js';
import { STATUS_LINE_MAX_STDOUT_BYTES } from '../../../src/tui/status-line/config.js';

/** fake 子进程：EventEmitter + stdin 捕获 + kill 计数（避免 any：显式形状后断言） */
interface FakeChild {
  proc: ChildProcess;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdinWrites: Array<{ data: string | Uint8Array; enc?: string }>;
  stdinEnds: number;
  kills: number;
  emitClose: (code: number | null) => void;
  emitError: (err: Error) => void;
  emitStdout: (chunk: Buffer) => void;
}

function fakeChild(): FakeChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinWrites: Array<{ data: string | Uint8Array; enc?: string }> = [];
  let stdinEnds = 0;
  let kills = 0;
  // EventEmitter 打上子进程所需的成员后一次性断言为 ChildProcess（避免 Writable 交集冲突）
  const proc = Object.assign(new EventEmitter(), {
    stdin: {
      on: () => undefined,
      end: (data: string | Uint8Array, enc?: string) => {
        stdinWrites.push({ data, ...(enc !== undefined ? { enc } : {}) });
        stdinEnds += 1;
      },
    },
    stdout,
    stderr,
    kill: () => {
      kills += 1;
      return true;
    },
  }) as unknown as ChildProcess;
  return {
    proc,
    stdout,
    stderr,
    stdinWrites,
    get stdinEnds() {
      return stdinEnds;
    },
    get kills() {
      return kills;
    },
    emitClose: (code) => proc.emit('close', code),
    emitError: (err) => proc.emit('error', err),
    emitStdout: (chunk) => stdout.emit('data', chunk),
  };
}

/** 装一个 spawnImpl：记录 (command, options) 并返回受控 fake */
function installFake() {
  const calls: Array<{ command: string; options: { shell?: boolean; cwd?: string; env?: NodeJS.ProcessEnv } }> = [];
  const fakes: FakeChild[] = [];
  const spawnImpl = ((command: string, options: { shell?: boolean; cwd?: string; env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, options });
    const child = fakeChild();
    fakes.push(child);
    return child.proc;
  }) as unknown as SpawnLike;
  return { spawnImpl, calls, fakes };
}

const baseOpts = {
  command: 'echo hi',
  payloadText: '{"cwd":"x"}\n',
  cwd: '/repo',
  size: { cols: 80, rows: 1 },
};

describe('G-45 stdin 契约与 G-49 env 传递', () => {
  it('payload 原样写入 stdin（含尾随换行）并关闭；env/cwd 透传给子进程', async () => {
    const { spawnImpl, calls, fakes } = installFake();
    const env = { COLUMNS: '80', LINES: '1', GIT_OPTIONAL_LOCKS: '0' };
    const p = runStatusLineCommand({ ...baseOpts, env, spawnImpl });
    const child = fakes[0];
    expect(child).toBeDefined();
    child?.emitClose(0);
    const result = await p;
    expect(result).toEqual({ ok: true, stdout: '', truncated: false });
    expect(child?.stdinEnds).toBe(1);
    expect(child?.stdinWrites[0]?.data).toBe('{"cwd":"x"}\n');
    expect(child?.stdinWrites[0]?.enc).toBe('utf8');
    expect(calls[0]?.options.cwd).toBe('/repo');
    expect(calls[0]?.options.env).toBe(env);
  });

  it('存在的可执行路径直接执行（shell:false）；裸命令/不存在路径走 shell 解释（shell:true）', async () => {
    const exe = join(tmpdir(), `h2-sl-exe-${process.pid}-${Date.now()}`);
    writeFileSync(exe, '#!/bin/sh\n');
    try {
      expect(isExecutablePath(exe)).toBe(true);
      expect(isExecutablePath('jq -r .cwd')).toBe(false); // 裸命令
      expect(isExecutablePath(join(tmpdir(), 'definitely-missing-sl'))).toBe(false);
      const { spawnImpl, calls, fakes } = installFake();
      const p1 = runStatusLineCommand({ ...baseOpts, command: exe, spawnImpl });
      fakes[0]?.emitClose(0);
      await p1;
      expect(calls[0]?.options.shell).toBe(false);
      const p2 = runStatusLineCommand({ ...baseOpts, spawnImpl });
      fakes[1]?.emitClose(0);
      await p2;
      expect(calls[1]?.options.shell).toBe(true);
    } finally {
      rmSync(exe, { force: true });
    }
  });
});

describe('G-47 限额与失败语义', () => {
  it('正常输出收集；非零退出码 = 失败（error 携带退出码与 stderr 尾巴）', async () => {
    const { spawnImpl, fakes } = installFake();
    const p = runStatusLineCommand({ ...baseOpts, spawnImpl });
    const child = fakes[0];
    child?.emitStdout(Buffer.from('line1\nline2\n'));
    child?.emitClose(0);
    expect(await p).toEqual({ ok: true, stdout: 'line1\nline2\n', truncated: false });

    const t = installFake();
    const p2 = runStatusLineCommand({ ...baseOpts, spawnImpl: t.spawnImpl });
    t.fakes[0]?.stderr.emit('data', Buffer.from('boom detail'));
    t.fakes[0]?.emitClose(3);
    const fail = await p2;
    expect(fail.ok).toBe(false);
    if (!fail.ok) {
      expect(fail.timedOut).toBe(false);
      expect(fail.error).toContain('3');
      expect(fail.error).toContain('boom detail');
    }
  });

  it('10s 超时：kill + timedOut=true（不留后台活口）；启动失败（error 事件）= 失败非超时', async () => {
    const { spawnImpl, fakes } = installFake();
    const p = runStatusLineCommand({ ...baseOpts, timeoutMs: 20, spawnImpl });
    await new Promise((r) => setTimeout(r, 40)); // 等真实 timer 触发
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.timedOut).toBe(true);
    expect(fakes[0]?.kills).toBeGreaterThan(0);

    const t = installFake();
    const p2 = runStatusLineCommand({ ...baseOpts, spawnImpl: t.spawnImpl });
    t.fakes[0]?.emitError(new Error('ENOENT'));
    const fail = await p2;
    expect(fail).toMatchObject({ ok: false, timedOut: false });
  });

  it('stdout 超 64KiB：截断保留 + kill（脚本停止）+ 按成功结算（truncated 标记）', async () => {
    const { spawnImpl, fakes } = installFake();
    const p = runStatusLineCommand({ ...baseOpts, maxStdoutBytes: 1024, spawnImpl });
    const child = fakes[0];
    child?.emitStdout(Buffer.alloc(600, 'a'));
    child?.emitStdout(Buffer.alloc(600, 'b')); // 累计 1200 > 1024 → 截断
    const result = await p;
    expect(result).toMatchObject({ ok: true, truncated: true });
    if (result.ok) expect(result.stdout.length).toBe(1024);
    expect(child?.kills).toBeGreaterThan(0);
    // 后续 close（被杀进程）不改变已结算结果
    child?.emitClose(null);
    expect(result).toMatchObject({ ok: true, truncated: true });
  });

  it('缺省 maxStdoutBytes = 64KiB（G-47 常量在 runner 生效）', () => {
    expect(STATUS_LINE_MAX_STDOUT_BYTES).toBe(65_536);
  });
});

describe('G-48 unified 日志（路径随 .harness2 家目录约定；JSONL 追加）', () => {
  it('unifiedLogPath = <home>/.harness2/logs/unified.jsonl', () => {
    expect(unifiedLogPath('/home/me')).toBe(join('/home/me', '.harness2', 'logs', 'unified.jsonl'));
  });

  it('追加失败日志：目录自动创建、单行 JSON、ts 补全；目录不可写返回 false 不上抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h2-sl-log-'));
    try {
      const path = unifiedLogPath(join(dir, 'home'));
      const ok = appendStatusLineFailureLog(
        path,
        { ts: 0, level: 'error', source: 'status_line', message: 'exit 1', timedOut: false },
        1234,
      );
      expect(ok).toBe(true);
      const lines = readFileSync(path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
      expect(entry).toMatchObject({
        ts: 1234,
        level: 'error',
        source: 'status_line',
        message: 'exit 1',
        timedOut: false,
      });
      // 第二条不覆盖（append）
      appendStatusLineFailureLog(
        path,
        { ts: 0, level: 'error', source: 'status_line', message: 'exit 2', timedOut: true },
        2345,
      );
      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
      // 目录不可创建（父路径被文件占用）→ 返回 false 不上抛（日志是诊断面，不阻塞降级）
      const occupied = join(dir, 'occupied');
      writeFileSync(occupied, 'x');
      expect(
        appendStatusLineFailureLog(
          join(occupied, 'logs', 'unified.jsonl'),
          { ts: 1, level: 'error', source: 'status_line', message: 'x', timedOut: false },
          1,
        ),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
