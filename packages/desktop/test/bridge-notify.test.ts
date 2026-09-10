// B7 notify case（主进程）：mock electron 的 Notification/BrowserWindow/dialog，
// 验证：isSupported 时 show()；点击 → focus 窗口 + 回传 notify/click 帧（含 sessionId）；
// 不支持时回退 dialog.showMessageBox；sessionId 缺失时点击不回传帧。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeDeps } from '../src/main/bridge.js';

// ---- electron mock（vi.mock 提升到文件顶部，先于 bridge 导入）----
const electronMock = vi.hoisted(() => {
  const clickHandlers = new Set<() => void>();
  const listeners = new Map<string, Set<(...a: never[]) => void>>();
  class MockNotification {
    static _clickHandlers = clickHandlers;
    static lastOptions: { title?: string; body?: string; silent?: boolean } = {};
    static _isSupported = true;
    static _lastShowCalls = 0;
    static _lastDialogCalls: unknown[] = [];
    static _window: {
      isMinimized: () => boolean;
      restore: () => void;
      show: () => void;
      focus: () => void;
    } | null = null;
    constructor(opts: { title?: string; body?: string; silent?: boolean }) {
      MockNotification.lastOptions = opts;
    }
    on(_event: string, cb: () => void): void {
      clickHandlers.add(cb);
    }
    show(): void {
      MockNotification._lastShowCalls += 1;
    }
    static isSupported(): boolean {
      return MockNotification._isSupported;
    }
    static _fireClick(): void {
      for (const cb of [...clickHandlers]) cb();
    }
  }
  return {
    Notification: MockNotification,
    BrowserWindow: {
      getAllWindows: vi.fn(() => []),
    },
    dialog: {
      showMessageBox: vi.fn(async () => ({ response: 0 })),
    },
    ipcMain: {
      handle: vi.fn(),
    },
    listeners,
  };
});

vi.mock('electron', () => ({
  Notification: electronMock.Notification,
  BrowserWindow: electronMock.BrowserWindow,
  dialog: electronMock.dialog,
  ipcMain: electronMock.ipcMain,
}));

// bridge 依赖 node:fs 等真实模块；测试只调 handleInvoke('notify')，不触发文件读写。
import { createBridge } from '../src/main/bridge.js';

function makeDeps(overrides: Partial<BridgeDeps> = {}): BridgeDeps & { sent: unknown[] } {
  const sent: unknown[] = [];
  const deps: BridgeDeps = {
    serve: {
      baseUrl: 'http://127.0.0.1:1',
      wsUrl: 'ws://127.0.0.1:1',
      status: 'online',
      getStatus: () => ({ status: 'connected' }),
    } as never,
    root: 'C:\\work',
    home: 'C:\\Users\\test\\.harness2',
    sendEvent: (f) => sent.push(f),
    sendStatus: () => {},
    ...overrides,
  };
  return { ...deps, sent };
}

beforeEach(() => {
  electronMock.Notification._lastShowCalls = 0;
  electronMock.Notification._lastDialogCalls = [];
  electronMock.Notification._clickHandlers.clear();
  electronMock.Notification.lastOptions = {};
  electronMock.Notification._isSupported = true;
  electronMock.Notification._window = null;
  electronMock.BrowserWindow.getAllWindows.mockClear();
  electronMock.BrowserWindow.getAllWindows.mockReturnValue([]);
  electronMock.dialog.showMessageBox.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bridge notify case', () => {
  it('isSupported 时创建 Notification 并 show', async () => {
    const deps = makeDeps();
    const { handleInvoke } = createBridge(deps);
    const ret = await handleInvoke({} as never, { cmd: 'notify', title: '会话标题', body: '摘要', sessionId: 's1' });
    expect(ret).toBeNull();
    expect(electronMock.Notification.lastOptions).toEqual({ title: '会话标题', body: '摘要', silent: false });
    expect(electronMock.Notification._lastShowCalls).toBe(1);
    expect(electronMock.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('标题为空时主进程兜底为 harness2', async () => {
    const deps = makeDeps();
    const { handleInvoke } = createBridge(deps);
    await handleInvoke({} as never, { cmd: 'notify', title: '', body: '', sessionId: 's1' });
    expect(electronMock.Notification.lastOptions.title).toBe('harness2');
  });

  it('不支持时回退 dialog（仍带查看会话按钮）', async () => {
    electronMock.Notification._isSupported = false;
    const deps = makeDeps();
    const { handleInvoke } = createBridge(deps);
    await handleInvoke({} as never, { cmd: 'notify', title: 't', body: 'b', sessionId: 's1' });
    expect(electronMock.Notification._lastShowCalls).toBe(0);
    expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ title: 't', message: 't', detail: 'b', buttons: ['查看会话'] }),
    );
  });

  it('不支持且无 sessionId → dialog 按钮为「好」', async () => {
    electronMock.Notification._isSupported = false;
    const deps = makeDeps();
    const { handleInvoke } = createBridge(deps);
    await handleInvoke({} as never, { cmd: 'notify', title: 't', body: 'b' });
    expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['好'] }));
  });

  it('点击通知 → 聚焦窗口 + 回传 notify/click 帧', async () => {
    const win = {
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    electronMock.BrowserWindow.getAllWindows.mockReturnValue([win as never]);
    const deps = makeDeps();
    const { handleInvoke } = createBridge(deps);
    await handleInvoke({} as never, { cmd: 'notify', title: 't', body: 'b', sessionId: 's1' });
    expect(deps.sent).toHaveLength(0);
    electronMock.Notification._fireClick();
    expect(win.restore).toHaveBeenCalled(); // 最小化 → 先 restore
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(deps.sent).toEqual([{ type: 'notify/click', sessionId: 's1' }]);
  });

  it('点击但不带 sessionId → 聚焦窗口但不回传帧', async () => {
    const win = { isMinimized: vi.fn(() => false), restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
    electronMock.BrowserWindow.getAllWindows.mockReturnValue([win as never]);
    const deps = makeDeps();
    const { handleInvoke } = createBridge(deps);
    await handleInvoke({} as never, { cmd: 'notify', title: 't', body: 'b' });
    electronMock.Notification._fireClick();
    expect(win.focus).toHaveBeenCalled();
    expect(deps.sent).toHaveLength(0);
  });

  it('点击且无窗口实例 → 仍回传帧（不抛错）', async () => {
    const deps = makeDeps();
    const { handleInvoke } = createBridge(deps);
    await handleInvoke({} as never, { cmd: 'notify', title: 't', body: 'b', sessionId: 's1' });
    expect(() => electronMock.Notification._fireClick()).not.toThrow();
    expect(deps.sent).toEqual([{ type: 'notify/click', sessionId: 's1' }]);
  });
});
