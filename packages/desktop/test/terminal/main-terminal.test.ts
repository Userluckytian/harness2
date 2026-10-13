// Z9-3：桌面主进程终端传输 + bridge `terminal:*` 分发单测（node 环境）。
//
// 假 PTY 注入（core `createTerminalManager({ spawnPty })`）下验证：
//   - open 拿 id、write/resize/close 转调到假 PTY；
//   - core 事件映射为 `terminal:data` / `terminal:exit` 并经 sendEvent 回推；
//   - close 后 id 失效（list 摘除、write 返回 false）；
//   - cwd 边界校验（照抄 workspace-fs `listWorkspaceDir` 口径）拒绝越界/非目录；
//   - 单例 start/get/stop 语义；
//   - bridge 四个 `terminal:*` case 端到端（IPC 命令名 → 传输函数）。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminalManager, type PtyLike } from '@harness2/core';
import {
  createTerminalTransport,
  getTerminalTransport,
  resolveTerminalCwd,
  startTerminal,
  stopTerminal,
  type TerminalOutboundFrame,
} from '../../src/main/terminal.js';

// bridge 依赖 electron；本文件同时覆盖 bridge 分发，故需 mock（同 bridge-notify.test.ts 口径）。
vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
    on(): void {}
    show(): void {}
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  ipcMain: { handle: () => {} },
  nativeTheme: { themeSource: 'system' },
}));
import type { BridgeDeps } from '../../src/main/bridge.js';
import { createBridge } from '../../src/main/bridge.js';

// —— 假 PTY（可控触发器 + 调用记录） ——
class FakePty implements PtyLike {
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;
  private readonly dataCbs: Array<(data: string) => void> = [];
  private readonly exitCbs: Array<(e: { exitCode?: number }) => void> = [];
  constructor(readonly opts: Record<string, unknown>) {}
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
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
  }
  emitData(data: string): void {
    for (const cb of [...this.dataCbs]) cb(data);
  }
  emitExit(exitCode: number | undefined): void {
    for (const cb of [...this.exitCbs]) cb({ exitCode });
  }
}

const dirs: string[] = [];
afterEach(() => {
  stopTerminal();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return realpathSync(d);
}

interface Harness {
  frames: TerminalOutboundFrame[];
  spawned: Array<{ file: string; args: string[]; pty: FakePty }>;
}

function makeHarness(root: string): Harness {
  const frames: TerminalOutboundFrame[] = [];
  const spawned: Array<{ file: string; args: string[]; pty: FakePty }> = [];
  startTerminal({
    root,
    sendEvent: (f) => frames.push(f),
    createManager: () =>
      createTerminalManager({
        spawnPty: (file, args, opts) => {
          const pty = new FakePty(opts);
          spawned.push({ file, args, pty });
          return pty;
        },
      }),
  });
  return { frames, spawned };
}

describe('createTerminalTransport：假 PTY 往返', () => {
  it('open 返回 id，spawn 的 cwd 落在工作区根；write/resize 转调假 PTY', () => {
    const root = makeDir('h2-term-root-');
    const { spawned } = makeHarness(root);
    const sub = join(root, 'pkg');
    mkdirSync(sub);

    const opened = getTerminalTransport().open({ cols: 100, rows: 30, cwd: sub });
    expect(opened.id).toBe('t-1');
    expect(getTerminalTransport().list()).toEqual(['t-1']);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.pty.opts['cwd']).toBe(sub);
    expect(spawned[0]?.pty.opts['cols']).toBe(100);

    expect(getTerminalTransport().write('t-1', 'echo hi\r')).toBe(true);
    expect(getTerminalTransport().resize('t-1', 120, 40)).toBe(true);
    expect(spawned[0]?.pty.writes).toEqual(['echo hi\r']);
    expect(spawned[0]?.pty.resizes).toEqual([[120, 40]]);
  });

  it('open 省略 cwd → 用工作区根', () => {
    const root = makeDir('h2-term-root-');
    const { spawned } = makeHarness(root);
    getTerminalTransport().open({ cols: 80, rows: 24 });
    expect(spawned[0]?.pty.opts['cwd']).toBe(root);
  });

  it('data/exit 事件映射为 terminal:data / terminal:exit 并回推订阅者', () => {
    const root = makeDir('h2-term-root-');
    const { frames, spawned } = makeHarness(root);
    getTerminalTransport().open({ cols: 80, rows: 24 });
    const pty = spawned[0]?.pty;
    expect(pty).toBeDefined();
    if (pty === undefined) return;

    pty.emitData('HARNESS2-PTY-OK\r\n');
    pty.emitExit(0);
    expect(frames).toEqual([
      { type: 'terminal:data', id: 't-1', data: 'HARNESS2-PTY-OK\r\n' },
      { type: 'terminal:exit', id: 't-1', exitCode: 0 },
    ]);
  });

  it('close 杀 PTY；关闭后 id 失效（list 摘除、write 返回 false）', () => {
    const root = makeDir('h2-term-root-');
    const { spawned } = makeHarness(root);
    getTerminalTransport().open({ cols: 80, rows: 24 });
    const pty = spawned[0]?.pty;
    expect(getTerminalTransport().close('t-1')).toBe(true);
    expect(pty?.killed).toBe(true);
    expect(getTerminalTransport().list()).toEqual([]);
    expect(getTerminalTransport().write('t-1', 'x')).toBe(false);
    expect(getTerminalTransport().resize('t-1', 80, 24)).toBe(false);
    expect(getTerminalTransport().close('t-1')).toBe(false); // 幂等：未知 id → false
  });

  it('非法 cols/rows / 越界 cwd → 抛可读错误，不 spawn', () => {
    const root = makeDir('h2-term-root-');
    const { spawned } = makeHarness(root);
    expect(() => getTerminalTransport().open({ cols: 0, rows: 24 })).toThrow(/cols\/rows 非法/);
    expect(() => getTerminalTransport().open({ cols: 80, rows: 24, cwd: '..' })).toThrow(/越界|不存在/);
    expect(spawned).toHaveLength(0);
  });

  it('dispose 杀全部并摘监听（后续事件不再回推）', () => {
    const root = makeDir('h2-term-root-');
    const frames: TerminalOutboundFrame[] = [];
    const spawned: FakePty[] = [];
    const transport = createTerminalTransport({
      root,
      sendEvent: (f) => frames.push(f),
      createManager: () =>
        createTerminalManager({
          spawnPty: (_file, _args, opts) => {
            const pty = new FakePty(opts);
            spawned.push(pty);
            return pty;
          },
        }),
    });
    transport.open({ cols: 80, rows: 24 });
    transport.open({ cols: 80, rows: 24 });
    transport.dispose();
    expect(spawned.every((p) => p.killed)).toBe(true);
    spawned[0]?.emitData('late');
    expect(frames).toEqual([]); // 摘监听后不再回推
  });
});

describe('resolveTerminalCwd：边界校验（照抄 listWorkspaceDir 口径）', () => {
  it('空 cwd = 根；相对子目录在界内；根外绝对路径/`..` 拒绝', () => {
    const root = makeDir('h2-term-root-');
    mkdirSync(join(root, 'src'));
    const outside = makeDir('h2-term-out-');

    expect(resolveTerminalCwd(root, undefined)).toEqual({ ok: true, cwd: root });
    expect(resolveTerminalCwd(root, '')).toEqual({ ok: true, cwd: root });
    const sub = resolveTerminalCwd(root, 'src');
    expect(sub).toEqual({ ok: true, cwd: join(root, 'src') });

    for (const bad of ['..', '../', '../outside', join(root, '..'), outside, join(outside, 'x')]) {
      const r = resolveTerminalCwd(root, bad);
      expect(r.ok, `应拒绝: ${bad}`).toBe(false);
    }
  });

  it('NUL 字节 / 不存在的目录 / 指向文件的 cwd 拒绝', () => {
    const root = makeDir('h2-term-root-');
    writeFileSync(join(root, 'a.txt'), 'x', 'utf8');
    expect(resolveTerminalCwd(root, 'a\0b').ok).toBe(false);
    expect(resolveTerminalCwd(root, 'does-not-exist').ok).toBe(false);
    const file = resolveTerminalCwd(root, 'a.txt');
    expect(file.ok).toBe(false);
    if (!file.ok) expect(file.error).toContain('不是目录');
  });
});

describe('终端传输单例', () => {
  it('start 建、get 取同一个、stop 后 get 抛可读错误', () => {
    const root = makeDir('h2-term-root-');
    const transport = startTerminal({
      root,
      sendEvent: () => {},
      createManager: () => createTerminalManager({ spawnPty: (_f, _a, opts) => new FakePty(opts) }),
    });
    expect(getTerminalTransport()).toBe(transport);
    stopTerminal();
    expect(() => getTerminalTransport()).toThrow(/未初始化/);
  });
});

describe('bridge terminal:* 分发（IPC 命令名 → 传输）', () => {
  function makeDeps(): BridgeDeps {
    return {
      serve: {
        baseUrl: 'http://127.0.0.1:1',
        wsUrl: 'ws://127.0.0.1:1',
        status: 'online',
        getStatus: () => ({ status: 'connected' }),
      } as never,
      root: 'C:\\work',
      home: 'C:\\Users\\test\\.harness2',
      sendEvent: () => {},
      sendStatus: () => {},
    };
  }

  let root: string;
  beforeEach(() => {
    root = makeDir('h2-term-bridge-');
  });

  it('terminal:open → {id}；terminal:write/resize/close 转调且返回 null', async () => {
    const { spawned } = makeHarness(root);
    const bridge = createBridge(makeDeps());
    const opened = (await bridge.handleInvoke({} as never, {
      cmd: 'terminal:open',
      cols: 80,
      rows: 24,
    })) as { id: string };
    expect(opened).toEqual({ id: 't-1' });
    await expect(bridge.handleInvoke({} as never, { cmd: 'terminal:write', id: 't-1', data: 'x' })).resolves.toBeNull();
    await expect(
      bridge.handleInvoke({} as never, { cmd: 'terminal:resize', id: 't-1', cols: 90, rows: 20 }),
    ).resolves.toBeNull();
    await expect(bridge.handleInvoke({} as never, { cmd: 'terminal:close', id: 't-1' })).resolves.toBeNull();
    expect(spawned[0]?.pty.writes).toEqual(['x']);
    expect(spawned[0]?.pty.resizes).toEqual([[90, 20]]);
    expect(spawned[0]?.pty.killed).toBe(true);
  });

  it('terminal:open 缺 cols/rows 或 cwd 越界 → reject，错误可读', async () => {
    makeHarness(root);
    const bridge = createBridge(makeDeps());
    await expect(bridge.handleInvoke({} as never, { cmd: 'terminal:open', cols: 80 })).rejects.toThrow(/cols/);
    await expect(
      bridge.handleInvoke({} as never, { cmd: 'terminal:open', cols: 80, rows: 24, cwd: '..' }),
    ).rejects.toThrow(/越界|不存在/);
  });
});
