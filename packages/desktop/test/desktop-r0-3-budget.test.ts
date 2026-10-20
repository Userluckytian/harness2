// U1 T1 / R0-3① 预算用例（B2/B3）—— 主进程，node 环境。
//
//  C1 serve 未就绪期间，免 serve 的 IPC 命令（window:minimize / window:close / getStatus）
//     照常成功返回、不抛错，且从调用到返回 <200ms（证明 invoke 不再连坐抛错、无隐藏阻塞）。
//  C2 projects:pickFolder 到进入原生目录选择器前 <50ms（此前 switch 前无条件读同步抛错 getter 是
//     唯一被怀疑的应用级慢点；R0-3 修复后这条链上应零 await / 零 HTTP）。
// （C3 两态断言见 test/desktop-workspace-root.test.ts）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// —— electron mock（vi.mock 提升，先于 bridge 导入）——
const electronMock = vi.hoisted(() => {
  const win = { minimize: vi.fn(), close: vi.fn() };
  const showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
  return {
    win,
    showOpenDialog,
    BrowserWindow: { getAllWindows: vi.fn(() => [win]) },
    Notification: class {
      static isSupported(): boolean {
        return false;
      }
      on(): void {}
      show(): void {}
    },
    dialog: {
      showMessageBox: vi.fn(async () => ({ response: 0 })),
      showOpenDialog,
    },
    ipcMain: { handle: vi.fn() },
    nativeTheme: { themeSource: 'system' as 'system' | 'light' | 'dark' },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: electronMock.BrowserWindow,
  Notification: electronMock.Notification,
  dialog: electronMock.dialog,
  ipcMain: electronMock.ipcMain,
  nativeTheme: electronMock.nativeTheme,
}));

import { createBridge, type BridgeDeps } from '../src/main/bridge.js';

/** serve 未就绪的假管理器：baseUrl 是同步抛错的 getter（复刻 serve-manager.ts:194-196 语义）。
 *  getStatus 仍可用（它不碰 baseUrl），authToken/wsUrl/status 供类型完整，本用例路径不会读到抛错。 */
function makeUnreadyServe(): BridgeDeps['serve'] {
  const serve = {
    get baseUrl(): string {
      throw new Error('serve 未就绪');
    },
    get wsUrl(): string {
      throw new Error('serve 未就绪');
    },
    status: 'connecting',
    authToken: null,
    getStatus: () => ({ status: 'connecting' }),
  };
  return serve as never;
}

function makeDeps(): BridgeDeps {
  return {
    serve: makeUnreadyServe(),
    root: 'D:\\work',
    home: 'D:\\Users\\test\\.harness2',
    sendEvent: () => {},
    sendStatus: () => {},
  };
}

beforeEach(() => {
  electronMock.win.minimize.mockClear();
  electronMock.win.close.mockClear();
  electronMock.BrowserWindow.getAllWindows.mockClear();
  electronMock.BrowserWindow.getAllWindows.mockReturnValue([electronMock.win as never]);
  electronMock.showOpenDialog.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('C1 serve 未就绪时免 serve 命令不连坐（R0-3①）', () => {
  it('window:minimize 成功返回 null 且 <200ms', async () => {
    const { handleInvoke } = createBridge(makeDeps());
    const t0 = Date.now();
    const ret = await handleInvoke({} as never, { cmd: 'window:minimize' });
    const dt = Date.now() - t0;
    expect(ret).toBeNull();
    expect(electronMock.win.minimize).toHaveBeenCalledTimes(1);
    expect(dt).toBeLessThan(200);
  });

  it('window:close 成功返回 null 且 <200ms', async () => {
    const { handleInvoke } = createBridge(makeDeps());
    const t0 = Date.now();
    const ret = await handleInvoke({} as never, { cmd: 'window:close' });
    const dt = Date.now() - t0;
    expect(ret).toBeNull();
    expect(electronMock.win.close).toHaveBeenCalledTimes(1);
    expect(dt).toBeLessThan(200);
  });

  it('getStatus 成功返回（serve 状态）且不抛错、<200ms', async () => {
    const { handleInvoke } = createBridge(makeDeps());
    const t0 = Date.now();
    const ret = (await handleInvoke({} as never, { cmd: 'getStatus' })) as { status: string };
    const dt = Date.now() - t0;
    expect(ret.status).toBe('connecting');
    expect(dt).toBeLessThan(200);
  });

  it('对照：真正需要 HTTP 的命令在未就绪时仍抛「serve 未就绪」（行为语义保持）', async () => {
    const { handleInvoke } = createBridge(makeDeps());
    await expect(handleInvoke({} as never, { cmd: 'listSessions' })).rejects.toThrow('serve 未就绪');
  });
});

describe('C2 projects:pickFolder 进对话框前 <50ms（无隐藏 await/HTTP）', () => {
  it('进入 showOpenDialog 的耗时远小于 50ms', async () => {
    let enteredAt = 0;
    electronMock.showOpenDialog.mockImplementationOnce(async () => {
      enteredAt = Date.now();
      return { canceled: true, filePaths: [] };
    });
    const { handleInvoke } = createBridge(makeDeps());
    const t0 = Date.now();
    const ret = await handleInvoke({} as never, { cmd: 'projects:pickFolder' });
    expect(ret).toBeNull(); // 取消 → null
    expect(enteredAt).toBeGreaterThan(0);
    expect(electronMock.showOpenDialog).toHaveBeenCalledTimes(1);
    expect(enteredAt - t0).toBeLessThan(50);
  });
});
