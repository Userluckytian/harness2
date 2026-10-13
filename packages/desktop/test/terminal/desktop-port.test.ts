// @vitest-environment jsdom
// Z9-3：桌面 `TerminalPort` 实现单测（渲染端）。
//
// jsdom 夹具无 preload → 覆盖**两条**路径：
//   ① 注入假 `window.harness2` 终端通道：open/write/resize/close 转调参数正确、
//      data/exit 事件按 id 分流到订阅者、退订后不再收到；
//   ② 通道缺失：`available === false`（红线⑩，不摆假终端），且方法不抛崩调用方。
// 单例 `desktopTerminalPort` 引用稳定（组件 effect 依赖 port 身份）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalPort } from '@harness2/ui-shared/renderer/terminal/port.js';
import type { Harness2Api, TerminalEventFrame } from '../../src/shared/protocol.js';
import { createDesktopTerminalPort, desktopTerminalPort } from '../../src/renderer/terminal/desktop-port.js';

interface FakeHost {
  listeners: Set<(frame: TerminalEventFrame) => void>;
  opened: Array<{ cols: number; rows: number; cwd?: string }>;
  writes: Array<[string, string]>;
  resizes: Array<[string, number, number]>;
  closed: string[];
  emit(frame: TerminalEventFrame): void;
}

/** 装上带完整终端通道的假宿主；返回记录容器 */
function installFakeHost(): FakeHost {
  const host: FakeHost = {
    listeners: new Set(),
    opened: [],
    writes: [],
    resizes: [],
    closed: [],
    emit(frame) {
      for (const cb of [...host.listeners]) cb(frame);
    },
  };
  const api: Partial<Harness2Api> = {
    terminalOpen: vi.fn(async (opts: { cols: number; rows: number; cwd?: string }) => {
      host.opened.push(opts);
      return { id: 't-1' };
    }),
    terminalWrite: vi.fn(async (id: string, data: string) => {
      host.writes.push([id, data]);
    }),
    terminalResize: vi.fn(async (id: string, cols: number, rows: number) => {
      host.resizes.push([id, cols, rows]);
    }),
    terminalClose: vi.fn(async (id: string) => {
      host.closed.push(id);
    }),
    onTerminalEvent: vi.fn((cb: (frame: TerminalEventFrame) => void) => {
      host.listeners.add(cb);
      return () => {
        host.listeners.delete(cb);
      };
    }),
  };
  (window as unknown as { harness2: Partial<Harness2Api> }).harness2 = api;
  return host;
}

beforeEach(() => {
  delete (window as unknown as { harness2?: Partial<Harness2Api> }).harness2;
});

afterEach(() => {
  delete (window as unknown as { harness2?: Partial<Harness2Api> }).harness2;
  vi.restoreAllMocks();
});

describe('桌面 TerminalPort：通道可用', () => {
  it('available=true；open 透传参数并回 id', async () => {
    installFakeHost();
    const port = createDesktopTerminalPort();
    expect(port.available).toBe(true);
    const opened = await port.open({ cols: 80, rows: 24, cwd: 'C:\\work' });
    expect(opened).toEqual({ id: 't-1' });
  });

  it('write / resize / close 经 IPC 转调（参数与 id 原样）', async () => {
    const host = installFakeHost();
    const port = createDesktopTerminalPort();
    port.write('t-1', 'ls\r');
    port.resize('t-1', 120, 40);
    await port.close('t-1');
    expect(host.writes).toEqual([['t-1', 'ls\r']]);
    expect(host.resizes).toEqual([['t-1', 120, 40]]);
    expect(host.closed).toEqual(['t-1']);
  });

  it('onData / onExit 按帧类型分流，退订后不再收到', () => {
    const host = installFakeHost();
    const port = createDesktopTerminalPort();
    const data: Array<[string, string]> = [];
    const exits: Array<[string, number | undefined]> = [];
    const offData = port.onData((id, d) => data.push([id, d]));
    const offExit = port.onExit((id, code) => exits.push([id, code]));

    host.emit({ type: 'terminal:data', id: 't-1', data: 'hello' });
    host.emit({ type: 'terminal:exit', id: 't-1', exitCode: 0 });
    host.emit({ type: 'terminal:exit', id: 't-2', exitCode: undefined });
    expect(data).toEqual([['t-1', 'hello']]);
    expect(exits).toEqual([
      ['t-1', 0],
      ['t-2', undefined],
    ]);

    offData();
    offExit();
    host.emit({ type: 'terminal:data', id: 't-1', data: 'after-off' });
    host.emit({ type: 'terminal:exit', id: 't-1', exitCode: 1 });
    expect(data).toEqual([['t-1', 'hello']]); // 未再增长
    expect(exits).toHaveLength(2);
    expect(host.listeners.size).toBe(0);
  });

  it('单例引用稳定（组件 port 依赖）', () => {
    const a: TerminalPort = desktopTerminalPort;
    const b: TerminalPort = desktopTerminalPort;
    expect(a).toBe(b);
  });
});

describe('桌面 TerminalPort：IPC 通道缺失（jsdom 夹具 / 非桌面宿主）', () => {
  it('available=false，且 open/write/resize/close/订阅 不抛崩', async () => {
    const port = createDesktopTerminalPort();
    expect(port.available).toBe(false);
    expect(() => port.write('t-1', 'x')).not.toThrow();
    expect(() => port.resize('t-1', 80, 24)).not.toThrow();
    await expect(port.close('t-1')).resolves.toBeUndefined();
    await expect(port.open({ cols: 80, rows: 24 })).rejects.toThrow(/终端通道不可用/);
    expect(typeof port.onData(() => {})).toBe('function');
    expect(typeof port.onExit(() => {})).toBe('function');
  });

  it('通道只缺一项（旧夹具）→ 同样视为不可用，不半可用', () => {
    (window as unknown as { harness2: Partial<Harness2Api> }).harness2 = {
      terminalOpen: vi.fn(async () => ({ id: 't-1' })),
      // 缺 terminalWrite/terminalResize/terminalClose/onTerminalEvent
    };
    expect(createDesktopTerminalPort().available).toBe(false);
  });
});
