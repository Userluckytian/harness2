// P0 自动化：桌面主进程 cron:add IPC（Core CronJobStore.add 单一实现）。
// 覆盖：合法创建 → 返回新任务并落盘 jobs.json；非法调度/缺参数 → 明确 reject（不静默、不假装成功）。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// electron 仅 bridge 顶层 import 需要；本用例只走 cron:add，不触窗口/通知。
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
    on(): void {}
    show(): void {}
  },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })), showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  nativeTheme: { themeSource: 'system' },
}));

import { createBridge, type BridgeDeps } from '../src/main/bridge.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-cron-add-'));
  dirs.push(d);
  return d;
}

function makeBridge(home: string): ReturnType<typeof createBridge> {
  const deps: BridgeDeps = {
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
  };
  return createBridge(deps);
}

describe('cron:add IPC', () => {
  it('合法 instruction+schedule → 返回新任务并原子落盘 jobs.json', async () => {
    const home = tmpHome();
    const { handleInvoke } = makeBridge(home);
    const job = (await handleInvoke({} as never, {
      cmd: 'cron:add',
      instruction: '每次问候',
      schedule: 'weekly 1,2,3,4,5 09:00',
    })) as { id: string; instruction: string; schedule: string; enabled: boolean; failCount: number };
    expect(job.instruction).toBe('每次问候');
    expect(job.schedule).toBe('weekly 1,2,3,4,5 09:00');
    expect(job.enabled).toBe(true);
    expect(job.failCount).toBe(0);
    expect(job.id.startsWith('cron-')).toBe(true);
    const file = JSON.parse(readFileSync(join(home, '.harness2', 'cron', 'jobs.json'), 'utf8')) as {
      jobs: Array<{ id: string }>;
    };
    expect(file.jobs).toHaveLength(1);
    expect(file.jobs[0]!.id).toBe(job.id);
  });

  it('非法调度 → reject（如实回传，不静默吞）', async () => {
    const home = tmpHome();
    const { handleInvoke } = makeBridge(home);
    await expect(
      handleInvoke({} as never, { cmd: 'cron:add', instruction: 'x', schedule: 'not a schedule' }),
    ).rejects.toThrow();
  });

  it('缺 instruction / schedule → reject', async () => {
    const home = tmpHome();
    const { handleInvoke } = makeBridge(home);
    await expect(
      handleInvoke({} as never, { cmd: 'cron:add', instruction: '  ', schedule: 'daily 09:00' }),
    ).rejects.toThrow();
    await expect(handleInvoke({} as never, { cmd: 'cron:add', instruction: 'x', schedule: '' })).rejects.toThrow();
  });
});
