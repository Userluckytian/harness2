// Z-47 `tray:status` / `tray:setCloseToTray` invoke（node 环境，electron 整体 mock，
// 照 desktop-r0-3-budget.test.ts 先例）：断言 fake 环境返回
// {created, platform, closeToTray}——created 来自 deps.isTrayCreated（缺省 false）、
// platform 为 process.platform 快照、closeToTray 按偏好文件/平台默认（win 开 linux 关）。
// 持久化用 mkdtemp 临时 home（preferences-file 走真实 json-file 通道）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readPreferences } from '../src/main/preferences-file.js';
import { resolveCloseToTray } from '../src/main/window-lifecycle.js';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
    on(): void {}
    show(): void {}
  },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
  ipcMain: { handle: vi.fn() },
  nativeTheme: { themeSource: 'system' },
}));

import { createBridge, type BridgeDeps } from '../src/main/bridge.js';

const homes: string[] = [];
function tempHome(): string {
  const h = mkdtempSync(join(tmpdir(), 'h2-tray-status-'));
  homes.push(h);
  return h;
}
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function makeDeps(home: string, isTrayCreated?: () => boolean): BridgeDeps {
  return {
    serve: {
      baseUrl: 'http://127.0.0.1:1',
      wsUrl: 'ws://127.0.0.1:1',
      status: 'online',
      getStatus: () => ({ status: 'connected' }),
    } as never,
    root: home,
    home,
    sendEvent: () => {},
    sendStatus: () => {},
    ...(isTrayCreated !== undefined ? { isTrayCreated } : {}),
  };
}

interface TrayStatus {
  created: boolean;
  platform: string;
  closeToTray: boolean;
}

describe('invoke tray:status（调试 / smoke 断言面）', () => {
  it('返回 {created, platform, closeToTray}；created 如实来自 isTrayCreated', async () => {
    const home = tempHome();
    const bridge = createBridge(makeDeps(home, () => true));
    const res = (await bridge.handleInvoke({} as never, { cmd: 'tray:status' })) as TrayStatus;
    expect(res.created).toBe(true);
    expect(res.platform).toBe(process.platform);
    expect(typeof res.closeToTray).toBe('boolean');
    // 缺省偏好下 = 平台默认（win 开 / 其余关）
    expect(res.closeToTray).toBe(resolveCloseToTray(undefined, process.platform));
  });

  it('未接 isTrayCreated（smoke 不建托盘）→ created=false，不抛错', async () => {
    const home = tempHome();
    const bridge = createBridge(makeDeps(home));
    const res = (await bridge.handleInvoke({} as never, { cmd: 'tray:status' })) as TrayStatus;
    expect(res.created).toBe(false);
  });
});

describe('invoke tray:setCloseToTray（偏好持久化到 desktop-preferences.json，加性写入）', () => {
  it('写入后落盘；tray:status 反映显式值（覆盖平台默认）', async () => {
    const home = tempHome();
    const deps = makeDeps(home, () => true);
    const bridge = createBridge(deps);
    const set = (enabled: boolean) => bridge.handleInvoke({} as never, { cmd: 'tray:setCloseToTray', enabled });

    const first = (await set(false)) as TrayStatus;
    expect(first).toEqual({ created: true, platform: process.platform, closeToTray: false });
    expect(readPreferences(home).closeToTray).toBe(false);

    const again = (await set(true)) as TrayStatus;
    expect(again.closeToTray).toBe(true);
    expect(readPreferences(home).closeToTray).toBe(true);

    const status = (await bridge.handleInvoke({} as never, { cmd: 'tray:status' })) as TrayStatus;
    expect(status.closeToTray).toBe(true);
  });

  it('不动其余偏好字段（读-改-写合并）', async () => {
    const home = tempHome();
    const bridge = createBridge(makeDeps(home));
    await bridge.handleInvoke({} as never, {
      cmd: 'settings:setPreferences',
      preferences: { ...readPreferences(home), theme: 'zai-dark' },
    });
    await bridge.handleInvoke({} as never, { cmd: 'tray:setCloseToTray', enabled: false });
    const prefs = readPreferences(home);
    expect(prefs.theme).toBe('zai-dark');
    expect(prefs.closeToTray).toBe(false);
  });

  it('enabled 非布尔 → 明确报错（不静默吞）', async () => {
    const home = tempHome();
    const bridge = createBridge(makeDeps(home));
    await expect(bridge.handleInvoke({} as never, { cmd: 'tray:setCloseToTray', enabled: 'yes' })).rejects.toThrow(
      /布尔/,
    );
  });
});
