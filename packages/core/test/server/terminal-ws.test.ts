// Z9-2（2026-10-13）serve WS 终端帧用例：八帧的客户端 4 + 服务端 4 全链。
//   用**假 PTY** 注入（不依赖真 shell/平台 PTY）；覆盖 open→opened、input→write 转调、
//   resize→resize 转调、data→回推、exit→回推 + id 失效、close→kill、未知 id→error、
//   跨连接 id→error（连接归属）、连接断开→自动 kill、spawn 不可用→terminal/error（不假装 opened）。
// 冻结契约见 docs/ai-framework/plans/2026-10-13-phase-Z9-terminal-and-web-settings.md §1.2。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTerminalManager,
  MockProvider,
  startServe,
  TerminalUnavailableError,
  type PtyLike,
  type ServeHandle,
  type WsServerMessage,
} from '../../src/index.js';

const dirs: string[] = [];
const handles: ServeHandle[] = [];
function tmpDir(prefix = 'h2-term-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, description: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`等待超时: ${description}`);
}

/** 假 PTY：记录 write/resize/kill 调用，测试可手动 emitData/emitExit（不真起 shell） */
class FakePty implements PtyLike {
  readonly spawnOpts: Record<string, unknown> | undefined;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killCount = 0;
  private dataCb: ((data: string) => void) | undefined;
  private exitCb: ((e: { exitCode?: number }) => void) | undefined;

  constructor(spawnOpts?: Record<string, unknown>) {
    this.spawnOpts = spawnOpts;
  }
  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode?: number }) => void): void {
    this.exitCb = cb;
  }
  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    this.killCount += 1;
  }
  emitData(data: string): void {
    this.dataCb?.(data);
  }
  emitExit(exitCode?: number): void {
    if (exitCode === undefined) this.exitCb?.({});
    else this.exitCb?.({ exitCode });
  }
}

/** 收集 WS 帧的客户端（Node 全局 WebSocket） */
class WsClient {
  readonly frames: WsServerMessage[] = [];
  readonly ws: WebSocket;
  private readonly waiters: Array<() => void> = [];
  readonly open: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.open = new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('ws 连接失败')));
    });
    this.ws.addEventListener('message', (ev) => {
      this.frames.push(JSON.parse(String(ev.data)) as WsServerMessage);
      for (const w of this.waiters.splice(0)) w();
    });
  }
  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }
  close(): void {
    this.ws.close();
  }
  async waitFor(pred: (f: WsServerMessage) => boolean, description: string): Promise<WsServerMessage> {
    for (let i = 0; i < 500; i++) {
      const hit = this.frames.find(pred);
      if (hit !== undefined) return hit;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 10);
      });
    }
    throw new Error(`等待帧超时: ${description}（已收到 ${this.frames.length} 帧）`);
  }
}

interface Harness {
  handle: ServeHandle;
  spawned: FakePty[];
}

async function startWithPty(
  opts: { spawnPty?: (file: string, args: string[], o: Record<string, unknown>) => PtyLike } = {},
): Promise<Harness> {
  const spawned: FakePty[] = [];
  const manager = createTerminalManager({
    spawnPty:
      opts.spawnPty ??
      ((_file, _args, spawnOpts) => {
        const p = new FakePty(spawnOpts);
        spawned.push(p);
        return p;
      }),
    defaultShell: 'fake-shell',
  });
  const handle = await startServe({
    requireToken: false,
    port: 0,
    home: tmpDir('h2-term-home-'),
    root: tmpDir('h2-term-root-'),
    provider: new MockProvider([{ textChunks: ['回复。'] }]),
    terminal: manager,
  });
  handles.push(handle);
  return { handle, spawned };
}

async function connect(handle: ServeHandle): Promise<WsClient> {
  const c = new WsClient(`ws://127.0.0.1:${handle.port}/ws`);
  await c.open;
  return c;
}

describe('Z9-2 终端帧：open/input/resize/close 与 opened/data/exit/error', () => {
  it('terminal/open → terminal/opened（requestId 回带）；spawn 收到 cols/rows/cwd', async () => {
    const { handle, spawned } = await startWithPty();
    const client = await connect(handle);
    client.send({ op: 'terminal/open', requestId: 'r-1', cols: 100, rows: 30, cwd: tmpDir('h2-term-cwd-') });

    const opened = await client.waitFor((f) => f.type === 'terminal/opened', 'terminal/opened');
    expect(opened.type === 'terminal/opened' && opened.requestId).toBe('r-1');
    const id = opened.type === 'terminal/opened' ? opened.id : '';
    expect(id).toBeTruthy();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.spawnOpts?.['cols']).toBe(100);
    expect(spawned[0]!.spawnOpts?.['rows']).toBe(30);
    expect(spawned[0]!.spawnOpts?.['cwd']).toBeTruthy();
    // 服务端已登记该 id（归属本连接）
    expect(handle.terminal.list()).toContain(id);
    client.close();
  });

  it('terminal/input → 转调 PTY.write；terminal/resize → 转调 PTY.resize', async () => {
    const { handle, spawned } = await startWithPty();
    const client = await connect(handle);
    client.send({ op: 'terminal/open', requestId: 'r', cols: 80, rows: 24 });
    const opened = await client.waitFor((f) => f.type === 'terminal/opened', 'opened');
    const id = opened.type === 'terminal/opened' ? opened.id : '';

    client.send({ op: 'terminal/input', id, data: 'ls -la\n' });
    await waitUntil(() => spawned[0]!.writes.length === 1, 'write 转调');
    expect(spawned[0]!.writes).toEqual(['ls -la\n']);

    client.send({ op: 'terminal/resize', id, cols: 120, rows: 40 });
    await waitUntil(() => spawned[0]!.resizes.length === 1, 'resize 转调');
    expect(spawned[0]!.resizes).toEqual([[120, 40]]);
    // 正常转调不应回 terminal/error
    expect(client.frames.filter((f) => f.type === 'terminal/error')).toHaveLength(0);
    client.close();
  });

  it('PTY data 事件 → terminal/data 回推给创建连接', async () => {
    const { handle, spawned } = await startWithPty();
    const client = await connect(handle);
    client.send({ op: 'terminal/open', requestId: 'r', cols: 80, rows: 24 });
    const opened = await client.waitFor((f) => f.type === 'terminal/opened', 'opened');
    const id = opened.type === 'terminal/opened' ? opened.id : '';

    spawned[0]!.emitData('\u001b[32mhello\u001b[0m');
    const data = await client.waitFor((f) => f.type === 'terminal/data', 'terminal/data');
    expect(data.type === 'terminal/data' && data.id).toBe(id);
    expect(data.type === 'terminal/data' && data.data).toBe('\u001b[32mhello\u001b[0m');
    client.close();
  });

  it('PTY exit 事件 → terminal/exit 回推 + id 此后失效（再 input → terminal/error）', async () => {
    const { handle, spawned } = await startWithPty();
    const client = await connect(handle);
    client.send({ op: 'terminal/open', requestId: 'r', cols: 80, rows: 24 });
    const opened = await client.waitFor((f) => f.type === 'terminal/opened', 'opened');
    const id = opened.type === 'terminal/opened' ? opened.id : '';
    expect(handle.terminal.list()).toContain(id);

    spawned[0]!.emitExit(0);
    const exit = await client.waitFor((f) => f.type === 'terminal/exit', 'terminal/exit');
    expect(exit.type === 'terminal/exit' && exit.id).toBe(id);
    expect(exit.type === 'terminal/exit' && exit.exitCode).toBe(0);
    // 管理器已摘除该 id
    await waitUntil(() => !handle.terminal.list().includes(id), 'exit 后 id 失效');

    client.send({ op: 'terminal/input', id, data: 'x' });
    const err = await client.waitFor((f) => f.type === 'terminal/error', 'exit 后 input error');
    expect(err.type === 'terminal/error' && err.id).toBe(id);
    client.close();
  });

  it('exitCode 缺省时 terminal/exit 不带 exitCode 字段', async () => {
    const { handle, spawned } = await startWithPty();
    const client = await connect(handle);
    client.send({ op: 'terminal/open', requestId: 'r', cols: 80, rows: 24 });
    await client.waitFor((f) => f.type === 'terminal/opened', 'opened');
    spawned[0]!.emitExit(undefined);
    const exit = await client.waitFor((f) => f.type === 'terminal/exit', 'terminal/exit');
    expect('exitCode' in exit).toBe(false);
    client.close();
  });

  it('terminal/close → kill 归属 PTY 并从管理器摘除', async () => {
    const { handle, spawned } = await startWithPty();
    const client = await connect(handle);
    client.send({ op: 'terminal/open', requestId: 'r', cols: 80, rows: 24 });
    const opened = await client.waitFor((f) => f.type === 'terminal/opened', 'opened');
    const id = opened.type === 'terminal/opened' ? opened.id : '';

    client.send({ op: 'terminal/close', id });
    await waitUntil(() => spawned[0]!.killCount === 1, 'close → kill');
    expect(handle.terminal.list()).not.toContain(id);
    expect(client.frames.filter((f) => f.type === 'terminal/error')).toHaveLength(0);
    client.close();
  });
});

describe('Z9-2 终端错误与连接归属', () => {
  it('未知 id 的 input/resize/close → terminal/error（带 id），不崩连接', async () => {
    const { handle } = await startWithPty();
    const client = await connect(handle);
    client.send({ op: 'terminal/input', id: 't-nope', data: 'x' });
    const e1 = await client.waitFor((f) => f.type === 'terminal/error', 'input error');
    expect(e1.type === 'terminal/error' && e1.id).toBe('t-nope');
    expect(e1.type === 'terminal/error' && e1.error).toContain('不属于');

    client.send({ op: 'terminal/resize', id: 't-nope', cols: 10, rows: 10 });
    const e2 = await client.waitFor(
      (f) => f.type === 'terminal/error' && client.frames.indexOf(f) > client.frames.indexOf(e1),
      'resize error',
    );
    expect(e2.type === 'terminal/error' && e2.id).toBe('t-nope');

    client.send({ op: 'terminal/close', id: 't-nope' });
    await client.waitFor(
      (f) => f.type === 'terminal/error' && client.frames.indexOf(f) > client.frames.indexOf(e2),
      'close error',
    );
    // 连接仍可用（未崩）：合法 open 仍成功
    client.send({ op: 'terminal/open', requestId: 'r-ok', cols: 80, rows: 24 });
    const ok = await client.waitFor((f) => f.type === 'terminal/opened', 'opened after errors');
    expect(ok.type === 'terminal/opened' && ok.requestId).toBe('r-ok');
    client.close();
  });

  it('跨连接访问他人终端 id → terminal/error（拒绝），原连接不受影响', async () => {
    const { handle, spawned } = await startWithPty();
    const a = await connect(handle);
    const b = await connect(handle);
    a.send({ op: 'terminal/open', requestId: 'ra', cols: 80, rows: 24 });
    const opened = await a.waitFor((f) => f.type === 'terminal/opened', 'opened');
    const id = opened.type === 'terminal/opened' ? opened.id : '';

    // B 试图写 A 的终端 → 拒绝（如实，不静默）
    b.send({ op: 'terminal/input', id, data: 'hijack' });
    const errB = await b.waitFor((f) => f.type === 'terminal/error', 'B error');
    expect(errB.type === 'terminal/error' && errB.id).toBe(id);
    await sleep(20);
    expect(spawned[0]!.writes).toHaveLength(0); // 写入未发生

    // A 自己仍可写；data 只回 A，不泄漏给 B
    a.send({ op: 'terminal/input', id, data: 'ok\n' });
    await waitUntil(() => spawned[0]!.writes.length === 1, 'A write');
    expect(spawned[0]!.writes).toEqual(['ok\n']);
    spawned[0]!.emitData('out');
    await a.waitFor((f) => f.type === 'terminal/data', 'A data');
    expect(b.frames.filter((f) => f.type === 'terminal/data')).toHaveLength(0);

    // B 也不能 close 他人终端
    b.send({ op: 'terminal/close', id });
    await b.waitFor((f) => f.type === 'terminal/error' && f.error.includes('不属于'), 'B close error');
    expect(handle.terminal.list()).toContain(id); // 未被 B 杀
    a.close();
    b.close();
  });

  it('spawn 不可用（TerminalUnavailableError）→ terminal/error（带 requestId），不假装 opened', async () => {
    const { handle } = await startWithPty({
      spawnPty: () => {
        throw new TerminalUnavailableError('平台无 PTY');
      },
    });
    const client = await connect(handle);
    client.send({ op: 'terminal/open', requestId: 'r-fail', cols: 80, rows: 24 });
    const err = await client.waitFor((f) => f.type === 'terminal/error', 'terminal/error');
    expect(err.type === 'terminal/error' && err.requestId).toBe('r-fail');
    expect(err.type === 'terminal/error' && err.error).toContain('终端不可用');
    expect(client.frames.filter((f) => f.type === 'terminal/opened')).toHaveLength(0);
    client.close();
  });

  it('连接断开 → 该连接创建的终端全部自动 kill', async () => {
    const { handle, spawned } = await startWithPty();
    const client = await connect(handle);
    client.send({ op: 'terminal/open', requestId: 'r1', cols: 80, rows: 24 });
    client.send({ op: 'terminal/open', requestId: 'r2', cols: 80, rows: 24 });
    await client.waitFor((f) => f.type === 'terminal/opened' && f.requestId === 'r2', 'opened x2');
    expect(handle.terminal.list()).toHaveLength(2);

    client.close();
    await waitUntil(() => spawned.every((p) => p.killCount === 1), '断开自动 kill');
    await waitUntil(() => handle.terminal.list().length === 0, '管理表清空');
    expect(spawned.map((p) => p.killCount)).toEqual([1, 1]);
  });
});

describe('Z9-2 终端帧协议校验', () => {
  it('非法 cols/rows / 缺 requestId → error 帧（协议级，不创建 PTY）', async () => {
    const { handle, spawned } = await startWithPty();
    const client = await connect(handle);
    client.send({ op: 'terminal/open', requestId: 'r', cols: 0, rows: 24 });
    const err = await client.waitFor((f) => f.type === 'error', '协议 error');
    expect(err.type === 'error' && err.error).toContain('cols');
    expect(spawned).toHaveLength(0);
    client.close();
  });
});
