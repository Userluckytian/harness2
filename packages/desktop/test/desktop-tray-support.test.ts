// 复审 P1-2：Linux 托盘 DBus 能力探测 probeTraySupport（纯函数，零 Electron 运行时）。
// 手法照 ZCode desktopTraySupport.ts（gdbus → busctl → qdbus 三级回退，探测
// org.kde.StatusNotifierWatcher）。execFile 经 deps 注入 fake，不起真实子进程：
// 五例覆盖——非 linux 恒 true（且不调 execFile）、gdbus 首路命中、gdbus ENOENT→busctl 回退、
// 三路执行成功但都无 watcher=false、三路全 ENOENT=false（安全默认，绝不隐藏后失联）。
import { describe, expect, it, vi } from 'vitest';
import { probeTraySupport, type TraySupportDeps } from '../src/main/tray-support.js';

/** 造一个 ENOENT 错误（命令缺失），与真实 execFile 失败形态一致 */
function enoent(): Error {
  const e = new Error('spawn gdbus ENOENT') as NodeJS.ErrnoException;
  e.code = 'ENOENT';
  return e;
}

/** WATCHER 服务名（与 tray-support.ts 探测目标一致） */
const WATCHER = 'org.kde.StatusNotifierWatcher';

/**
 * fake execFile：按 cmd 分派预置结果。
 * results[cmd] = string（stdout 成功）| 'ENOENT'（reject 命令缺失）| 'FAIL'（reject 其他错误）
 */
function fakeExecFile(results: Record<string, string | 'ENOENT' | 'FAIL'>): TraySupportDeps['execFile'] {
  return vi.fn(async (cmd: string) => {
    const r = results[cmd];
    if (r === undefined) throw enoent();
    if (r === 'ENOENT') throw enoent();
    if (r === 'FAIL') throw new Error('exec failed');
    return r; // 成功返回：probeTraySupport 接受 string 或 { stdout }
  });
}

describe('probeTraySupport（复审 P1-2：linux 双条件门之二）', () => {
  it('非 linux（win32 / darwin）恒 true，且不调用 execFile', async () => {
    for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
      const execFile = fakeExecFile({});
      await expect(probeTraySupport({ platform, execFile })).resolves.toBe(true);
      expect(execFile).not.toHaveBeenCalled();
    }
  });

  it('linux gdbus 首路命中 watcher → true（不再试 busctl / qdbus）', async () => {
    const execFile = fakeExecFile({ gdbus: `(true,) ${WATCHER}\n`, busctl: 'ENOENT', qdbus: 'ENOENT' });
    await expect(probeTraySupport({ platform: 'linux', execFile })).resolves.toBe(true);
    // 首路给出明确结果即返回：仅 gdbus 被调用
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execFile).mock.calls[0]?.[0]).toBe('gdbus');
  });

  it('linux gdbus ENOENT → busctl 回退命中 → true', async () => {
    const execFile = fakeExecFile({ busctl: `NAME\n${WATCHER}\n` });
    await expect(probeTraySupport({ platform: 'linux', execFile })).resolves.toBe(true);
    // gdbus（缺失）+ busctl（命中）两次；qdbus 不再试
    expect(execFile).toHaveBeenCalledTimes(2);
    const cmds = vi.mocked(execFile).mock.calls.map((c) => c[0]);
    expect(cmds).toEqual(['gdbus', 'busctl']);
  });

  it('linux 三路执行成功但都无 watcher → false（GNOME 无 AppIndicator 扩展典型态）', async () => {
    const execFile = fakeExecFile({
      gdbus: '(true,)\n', // ListNames 成功但输出不含 watcher 名
      busctl: 'NAME\norg.freedesktop.DBus\n',
      qdbus: 'org.freedesktop.DBus\n',
    });
    await expect(probeTraySupport({ platform: 'linux', execFile })).resolves.toBe(false);
  });

  it('linux 三路全 ENOENT（无探测工具）→ false（安全默认：不可用，绝不隐藏后失联）', async () => {
    const execFile = fakeExecFile({ gdbus: 'ENOENT', busctl: 'ENOENT', qdbus: 'ENOENT' });
    await expect(probeTraySupport({ platform: 'linux', execFile })).resolves.toBe(false);
    expect(execFile).toHaveBeenCalledTimes(3);
  });
});
