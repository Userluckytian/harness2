// @vitest-environment jsdom
// Z9-4 终端面板单测（mock port）。
//
// jsdom 限制：真实 @xterm/xterm 需要 canvas / 元素测量，jsdom 下不可用；故这里用
// vi.mock 的**受控替身**（记录 write / dispose / onData 调用）——这是 jsdom 限制下的
// 替身测法，不是对真实渲染管线的验证（真实渲染由浏览器复核批次 Z9-5 负责）。被测的
// 是**面板与端口的接线契约**：可用性如实、open 参数、数据分发、键入回传、多标签、
// 关闭回收、退出/失败如实显示。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TerminalPort } from '../src/renderer/terminal/port.js';
import { TerminalPanel } from '../src/renderer/terminal/TerminalPanel.js';

// —— 受控替身（vi.hoisted 使 vi.mock 工厂可引用同一批可变记录） ——

interface FakeTerminalInstance {
  cols: number;
  rows: number;
  options: Record<string, unknown>;
  writes: string[];
  disposed: boolean;
  handlers: Array<(data: string) => void>;
  /** 测试驱动：模拟用户在终端里键入 */
  emitData(data: string): void;
}

const xtermMock = vi.hoisted(() => {
  const instances: FakeTerminalInstance[] = [];
  class FakeTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    writes: string[] = [];
    disposed = false;
    handlers: Array<(data: string) => void> = [];
    constructor(options: Record<string, unknown>) {
      this.options = options;
      instances.push(this as unknown as FakeTerminalInstance);
    }
    loadAddon(addon: { term?: FakeTerminal }): void {
      // 让替身 FitAddon 能反向改写本终端的 cols/rows（模拟真实 FitAddon 依容器尺寸重算）。
      addon.term = this;
    }
    open(): void {
      /* DOM 挂载由容器负责；替身不渲染 */
    }
    write(data: string): void {
      this.writes.push(data);
    }
    onData(cb: (data: string) => void): { dispose(): void } {
      this.handlers.push(cb);
      return {
        dispose: () => {
          this.handlers = this.handlers.filter((h) => h !== cb);
        },
      };
    }
    dispose(): void {
      this.disposed = true;
    }
    /** 测试驱动：模拟用户在终端里键入 */
    emitData(data: string): void {
      for (const h of [...this.handlers]) h(data);
    }
  }
  interface FakeFitInstance {
    fitCount: number;
    disposed: boolean;
    /** 由 FakeTerminal.loadAddon 注入：fit() 时把 fitSize 写到该终端 */
    term: FakeTerminal | null;
  }
  const fits: FakeFitInstance[] = [];
  // 受控 fit 尺寸：非 null 时 `fit()` 把该 cols/rows 写入关联终端（模拟真实 fit 依容器尺寸重算）。
  // 默认 null → 现有用例里 fit() 不改变 cols/rows（保持既有替身语义，零回归）。
  const fitSize: { cols: number | null; rows: number | null } = { cols: null, rows: null };
  class FakeFitAddon {
    fitCount = 0;
    disposed = false;
    term: FakeTerminal | null = null;
    constructor() {
      fits.push(this as unknown as FakeFitInstance);
    }
    fit(): void {
      this.fitCount += 1;
      if (this.term !== null && fitSize.cols !== null && fitSize.rows !== null) {
        this.term.cols = fitSize.cols;
        this.term.rows = fitSize.rows;
      }
    }
    dispose(): void {
      this.disposed = true;
    }
  }
  return { instances, fits, fitSize, FakeTerminal, FakeFitAddon };
});

vi.mock('@xterm/xterm', () => ({ Terminal: xtermMock.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: xtermMock.FakeFitAddon }));

// ResizeObserver 在 jsdom 不存在；受控替身便于手动触发尺寸变化回调。
const roMock = vi.hoisted(() => {
  interface FakeObserverInstance {
    cb: ResizeObserverCallback;
    trigger(): void;
  }
  const observers: FakeObserverInstance[] = [];
  class FakeResizeObserver {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      observers.push(this as unknown as FakeObserverInstance);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    trigger(): void {
      this.cb([], this as unknown as ResizeObserver);
    }
  }
  return { observers, FakeResizeObserver };
});

// —— mock 端口 ——

interface MockPort {
  port: TerminalPort;
  opened: Array<{ id: string; cols: number; rows: number; cwd?: string }>;
  writes: Array<{ id: string; data: string }>;
  resizes: Array<{ id: string; cols: number; rows: number }>;
  closed: string[];
  emitData: (id: string, data: string) => void;
  emitExit: (id: string, exitCode: number | undefined) => void;
  /** 仅 `manualOpen` 时可用：放行一次挂起的 open（resolve 对应 Promise） */
  releaseOpen: () => void;
}

function createMockPort(opts: { available?: boolean; manualOpen?: boolean } = {}): MockPort {
  const dataListeners = new Set<(id: string, data: string) => void>();
  const exitListeners = new Set<(id: string, exitCode: number | undefined) => void>();
  let nextId = 1;
  const opened: MockPort['opened'] = [];
  const writes: MockPort['writes'] = [];
  const resizes: MockPort['resizes'] = [];
  const closed: string[] = [];
  const openReleases: Array<() => void> = [];

  const open = vi.fn((o: { cols: number; rows: number; cwd?: string }): Promise<{ id: string }> => {
    const id = `t${nextId}`;
    nextId += 1;
    opened.push({ id, cols: o.cols, rows: o.rows, cwd: o.cwd });
    if (opts.manualOpen === true) {
      // 手动放行：用于精确模拟「open 尚未 resolve 时容器尺寸已变化」的时序。
      return new Promise<{ id: string }>((resolve) => {
        openReleases.push(() => resolve({ id }));
      });
    }
    return Promise.resolve({ id });
  });
  const port: TerminalPort = {
    available: opts.available ?? true,
    open,
    write: vi.fn((id: string, data: string) => {
      writes.push({ id, data });
    }),
    resize: vi.fn((id: string, cols: number, rows: number) => {
      resizes.push({ id, cols, rows });
    }),
    close: vi.fn(async (id: string) => {
      closed.push(id);
    }),
    onData: (cb) => {
      dataListeners.add(cb);
      return () => {
        dataListeners.delete(cb);
      };
    },
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => {
        exitListeners.delete(cb);
      };
    },
  };
  return {
    port,
    opened,
    writes,
    resizes,
    closed,
    emitData: (id, data) => {
      for (const cb of [...dataListeners]) cb(id, data);
    },
    emitExit: (id, exitCode) => {
      for (const cb of [...exitListeners]) cb(id, exitCode);
    },
    releaseOpen: () => {
      openReleases.shift()?.();
    },
  };
}

beforeEach(() => {
  xtermMock.instances.length = 0;
  xtermMock.fits.length = 0;
  xtermMock.fitSize.cols = null;
  xtermMock.fitSize.rows = null;
  roMock.observers.length = 0;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = roMock.FakeResizeObserver;
});

afterEach(() => {
  cleanup();
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  document.documentElement.style.removeProperty('--color-terminal-green');
  document.documentElement.style.removeProperty('--color-background');
});

describe('TerminalPanel · 可用性如实（红线⑩）', () => {
  it('available:false → 显示不可用文案 + 原因；不创建 xterm、不调 open', () => {
    const m = createMockPort({ available: false });
    render(<TerminalPanel port={m.port} unavailableReason="web 壳未提供终端通道" />);

    expect(screen.getByTestId('terminal-unavailable')).toBeTruthy();
    expect(screen.getByText('终端不可用')).toBeTruthy();
    expect(screen.getByText('web 壳未提供终端通道')).toBeTruthy();
    expect(screen.queryByTestId('terminal-xterm')).toBeNull();
    expect(screen.queryByTestId('terminal-tabstrip')).toBeNull();
    expect(m.port.open).not.toHaveBeenCalled();
    expect(xtermMock.instances).toHaveLength(0);
  });

  it('available:true → 调 port.open（cols/rows 为整数且 > 0）', async () => {
    const m = createMockPort();
    render(<TerminalPanel port={m.port} />);

    await waitFor(() => expect(m.port.open).toHaveBeenCalledTimes(1));
    const arg = m.opened[0];
    expect(arg).toBeDefined();
    expect(Number.isInteger(arg?.cols)).toBe(true);
    expect(Number.isInteger(arg?.rows)).toBe(true);
    expect(arg?.cols ?? 0).toBeGreaterThan(0);
    expect(arg?.rows ?? 0).toBeGreaterThan(0);
    expect(screen.getAllByTestId('terminal-tab')).toHaveLength(1);
    expect(screen.getByTestId('terminal-xterm')).toBeTruthy();
  });
});

describe('TerminalPanel · 数据流接线', () => {
  it('port.onData 数据进入对应 xterm 实例', async () => {
    const m = createMockPort();
    render(<TerminalPanel port={m.port} />);
    await waitFor(() => expect(xtermMock.instances).toHaveLength(1));
    await waitFor(() => expect(m.opened).toHaveLength(1));

    act(() => m.emitData('t1', 'HARNESS2-TTY-OK\r\n'));
    expect(xtermMock.instances[0]?.writes).toContain('HARNESS2-TTY-OK\r\n');
  });

  it('键入（term.onData）→ port.write(id, data)', async () => {
    const m = createMockPort();
    render(<TerminalPanel port={m.port} />);
    await waitFor(() => expect(xtermMock.instances).toHaveLength(1));
    await waitFor(() => expect(m.opened).toHaveLength(1));

    act(() => xtermMock.instances[0]?.emitData('ls\r'));
    expect(m.port.write).toHaveBeenCalledWith('t1', 'ls\r');
  });

  it('容器尺寸变化（ResizeObserver）→ fit 后 port.resize(id, cols, rows)', async () => {
    const m = createMockPort();
    render(<TerminalPanel port={m.port} />);
    await waitFor(() => expect(xtermMock.instances).toHaveLength(1));
    await waitFor(() => expect(m.opened).toHaveLength(1));

    const ro = roMock.observers.at(-1);
    expect(ro).toBeDefined();
    // 模拟真实 xterm：fit() 改写了终端的列/行
    const inst = xtermMock.instances[0];
    if (inst) {
      inst.cols = 100;
      inst.rows = 40;
    }
    act(() => ro?.trigger());
    expect(m.port.resize).toHaveBeenCalledWith('t1', 100, 40);
  });
});

describe('TerminalPanel · 多标签生命周期', () => {
  it('新建第二个标签 → 第二次 port.open；关闭 → 对应 port.close + dispose', async () => {
    const m = createMockPort();
    render(<TerminalPanel port={m.port} />);
    await waitFor(() => expect(m.port.open).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('terminal-new-tab'));
    await waitFor(() => expect(m.port.open).toHaveBeenCalledTimes(2));
    expect(screen.getAllByTestId('terminal-tab')).toHaveLength(2);
    expect(m.opened.map((o) => o.id)).toEqual(['t1', 't2']);

    const secondInstance = xtermMock.instances[1];
    const closeButtons = screen.getAllByTestId('terminal-tab-close');
    fireEvent.click(closeButtons[1] as HTMLElement);

    await waitFor(() => expect(m.port.close).toHaveBeenCalledWith('t2'));
    expect(screen.getAllByTestId('terminal-tab')).toHaveLength(1);
    await waitFor(() => expect(secondInstance?.disposed).toBe(true));
  });

  it('卸载面板 → port.close + term.dispose（不泄漏真实 PTY）', async () => {
    const m = createMockPort();
    const { unmount } = render(<TerminalPanel port={m.port} />);
    await waitFor(() => expect(m.opened).toHaveLength(1));
    const inst = xtermMock.instances[0];

    unmount();
    await waitFor(() => expect(m.port.close).toHaveBeenCalledWith('t1'));
    expect(inst?.disposed).toBe(true);
  });
});

describe('TerminalPanel · 退出 / 失败如实显示', () => {
  it('onExit 到达 → 该标签显示退出码（不伪装成正常输出）', async () => {
    const m = createMockPort();
    render(<TerminalPanel port={m.port} />);
    await waitFor(() => expect(m.opened).toHaveLength(1));

    act(() => m.emitExit('t1', 0));
    expect(await screen.findByText('终端已退出（退出码 0）')).toBeTruthy();
  });

  it('退出码未知 → 如实显示「未知」', async () => {
    const m = createMockPort();
    render(<TerminalPanel port={m.port} />);
    await waitFor(() => expect(m.opened).toHaveLength(1));

    act(() => m.emitExit('t1', undefined));
    expect(await screen.findByText('终端已退出（退出码 未知）')).toBeTruthy();
  });

  it('port.open 失败 → 该标签内如实显示错误', async () => {
    const m = createMockPort();
    (m.port.open as unknown as { mockRejectedValueOnce: (e: unknown) => void }).mockRejectedValueOnce(
      new Error('PTY 不可用'),
    );
    render(<TerminalPanel port={m.port} />);

    const status = await screen.findByText('终端打开失败：PTY 不可用');
    expect(status).toBeTruthy();
    expect(screen.getByTestId('terminal-tab-status').getAttribute('role')).toBe('alert');
    expect(screen.queryByText('正在打开终端…')).toBeNull();
  });
});

describe('TerminalPanel · 主题取色', () => {
  it('读壳语义 token 映射到 xterm theme（不硬编色值）', async () => {
    document.documentElement.style.setProperty('--color-terminal-green', '#123456');
    document.documentElement.style.setProperty('--color-background', '#0a0a0a');
    const m = createMockPort();
    render(<TerminalPanel port={m.port} />);
    await waitFor(() => expect(xtermMock.instances).toHaveLength(1));

    const theme = xtermMock.instances[0]?.options.theme as Record<string, unknown> | undefined;
    expect(theme?.green).toBe('#123456');
    expect(theme?.background).toBe('#0a0a0a');
  });
});

// Z9-4 回归：多实例按 **id 精确分发**（面板级注册表 + 单一订阅）。防「数据写进别的实例 /
// StrictMode 双调用后订阅失效 / close 后幽灵写入」三类错位。
describe('TerminalPanel · 多实例 id 精确分发（回归）', () => {
  it('两个标签：id A 的 data 只进 A 的实例，id B 只进 B', async () => {
    const m = createMockPort();
    render(<TerminalPanel port={m.port} />);
    await waitFor(() => expect(m.opened).toHaveLength(1));
    fireEvent.click(screen.getByTestId('terminal-new-tab'));
    await waitFor(() => expect(m.opened).toHaveLength(2));

    const [instA, instB] = xtermMock.instances;
    act(() => m.emitData('t1', 'A-DATA'));
    act(() => m.emitData('t2', 'B-DATA'));

    expect(instA?.writes).toEqual(['A-DATA']);
    expect(instB?.writes).toEqual(['B-DATA']);
  });

  it('effect 重复执行（StrictMode 双调用）后，存活实例仍能收到 data（订阅不失效）', async () => {
    const m = createMockPort();
    render(
      <StrictMode>
        <TerminalPanel port={m.port} />
      </StrictMode>,
    );
    // StrictMode 双调用：收到两次 open（t1 被 cleanup 关掉、t2 存活）
    await waitFor(() => expect(m.opened.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(m.closed).toContain('t1'));
    await act(async () => {
      await Promise.resolve(); // 让存活 open 的续体完成登记（registry.set 在 await 之后）
    });
    const liveInst = xtermMock.instances.find((i) => !i.disposed);
    expect(liveInst).toBeDefined();
    const liveId = m.opened[m.opened.length - 1]?.id as string;

    act(() => m.emitData(liveId, 'STILL-ALIVE'));
    expect(liveInst?.writes).toContain('STILL-ALIVE');
    // 被关掉的那个实例绝不能收到数据
    expect(xtermMock.instances[0]?.writes).toEqual([]);
  });

  it('关闭标签后再来该 id 的 data → 不写进任何实例（含仍存的激活实例）', async () => {
    const m = createMockPort();
    render(<TerminalPanel port={m.port} />);
    await waitFor(() => expect(m.opened).toHaveLength(1));
    fireEvent.click(screen.getByTestId('terminal-new-tab'));
    await waitFor(() => expect(m.opened).toHaveLength(2));

    const closeButtons = screen.getAllByTestId('terminal-tab-close');
    fireEvent.click(closeButtons[1] as HTMLElement);
    await waitFor(() => expect(m.port.close).toHaveBeenCalledWith('t2'));

    act(() => m.emitData('t2', 'GHOST-AFTER-CLOSE'));
    expect(xtermMock.instances.every((i) => !i.writes.includes('GHOST-AFTER-CLOSE'))).toBe(true);
  });

  it('未知 id 的 data 如实丢弃 —— 不回落到第一个 / 激活实例', async () => {
    const m = createMockPort();
    render(<TerminalPanel port={m.port} />);
    await waitFor(() => expect(m.opened).toHaveLength(1));

    act(() => m.emitData('no-such-id', 'ORPHAN'));
    expect(xtermMock.instances.every((i) => i.writes.length === 0)).toBe(true);
  });
});

// 缺陷回归（dock 收起时挂载 → xterm 永远停在 1 行）：
// 挂载时容器零尺寸 → fit 只能得 rows=1，PTY 以 rows=1 创建；挂载期 ResizeObserver 回调在
// `await port.open` 未 resolve（idRef 仍为 null）时空跑，此后若容器不再变化就再无 fit。
// 修复：open resolve 且 id/登记就绪后补一次 fitAndResize。
describe('TerminalPanel · dock 收起时挂载 → 展开后尺寸正确（回归）', () => {
  it('open 期间容器展开（RO 在 id 就绪前空跑）→ open 后补 fit，port.resize 收到非 1 行', async () => {
    const m = createMockPort({ manualOpen: true });
    // 挂载时容器零尺寸：fit 只能得到 1x1
    xtermMock.fitSize.cols = 1;
    xtermMock.fitSize.rows = 1;
    render(<TerminalPanel port={m.port} />);

    // PTY 先以 rows=1 创建（根因现象：多行输出看不见）
    expect(m.opened).toHaveLength(1);
    expect(m.opened[0]?.rows).toBe(1);

    const fit = xtermMock.fits.at(-1);
    const fitCountBeforeRelease = fit?.fitCount ?? 0;

    // dock 在 open resolve 之前展开：容器变为真实尺寸 → ResizeObserver 回调触发；
    // 但此刻 id 尚未就绪，回调空跑（不 fit）。
    xtermMock.fitSize.cols = 140;
    xtermMock.fitSize.rows = 12;
    act(() => roMock.observers.at(-1)?.trigger());
    expect(fit?.fitCount ?? 0).toBe(fitCountBeforeRelease);

    // open resolve（容器此时已展开）
    await act(async () => {
      m.releaseOpen();
      await Promise.resolve();
    });

    // 修复：open 后补一次 fit → 重算为 140x12 并经 port.resize 通知 PTY
    expect(fit?.fitCount ?? 0).toBeGreaterThan(fitCountBeforeRelease);
    expect(m.port.resize).toHaveBeenCalledWith('t1', 140, 12);
    expect(m.resizes.some((r) => r.rows !== 1)).toBe(true);
  });

  it('挂载零尺寸 → open resolve 后容器变非零 → fit 再次调用且 resize 非 1 行', async () => {
    const m = createMockPort();
    xtermMock.fitSize.cols = 1;
    xtermMock.fitSize.rows = 1;
    render(<TerminalPanel port={m.port} />);
    await waitFor(() => expect(m.opened).toHaveLength(1));
    expect(m.opened[0]?.rows).toBe(1);

    const fit = xtermMock.fits.at(-1);
    const fitCountAfterOpen = fit?.fitCount ?? 0;

    // dock 展开后容器变为真实尺寸
    xtermMock.fitSize.cols = 140;
    xtermMock.fitSize.rows = 12;
    act(() => roMock.observers.at(-1)?.trigger());

    expect(fit?.fitCount ?? 0).toBeGreaterThan(fitCountAfterOpen);
    expect(m.resizes.some((r) => r.cols === 140 && r.rows === 12)).toBe(true);
  });

  it('尺寸未变时不重复 port.resize（lastSizeRef 去重仍生效）', async () => {
    const m = createMockPort();
    render(<TerminalPanel port={m.port} />);
    await waitFor(() => expect(m.opened).toHaveLength(1));

    // 替身 fit 不改 cols/rows（80x24，与 open 时一致）→ 多次触发也不应发 resize
    const ro = roMock.observers.at(-1);
    act(() => ro?.trigger());
    act(() => ro?.trigger());
    expect(m.port.resize).not.toHaveBeenCalled();
  });
});
