// Z-47 关窗裁决决策表全覆盖（纯函数，零 Electron）：
// 平台(win32/linux/darwin) × closeToTray(true/false) × 托盘成败(true/false) × explicitQuit(true/false)
// = 24 组合逐条断言 hide-to-tray / proceed-close；另覆盖平台默认（win 开 / linux 关）、
// resolveCloseToTray 缺省回落、QuitIntent 置位/回滚。
import { describe, expect, it } from 'vitest';
import {
  createQuitIntent,
  decideWindowClose,
  defaultCloseToTray,
  isTrayPlatform,
  resolveCloseToTray,
} from '../src/main/window-lifecycle.js';

describe('isTrayPlatform（平台门：win32 + linux）', () => {
  it('win32 / linux 过门；darwin 及未知平台不过', () => {
    expect(isTrayPlatform('win32')).toBe(true);
    expect(isTrayPlatform('linux')).toBe(true);
    expect(isTrayPlatform('darwin')).toBe(false);
    expect(isTrayPlatform('freebsd')).toBe(false);
    expect(isTrayPlatform('')).toBe(false);
  });
});

describe('平台默认与有效值（Z-47：win 默认开 / linux 默认关）', () => {
  it('defaultCloseToTray：win32 true，linux false，darwin false', () => {
    expect(defaultCloseToTray('win32')).toBe(true);
    expect(defaultCloseToTray('linux')).toBe(false);
    expect(defaultCloseToTray('darwin')).toBe(false);
  });

  it('resolveCloseToTray：显式存储优先；缺省回落平台默认', () => {
    expect(resolveCloseToTray(true, 'linux')).toBe(true); // 用户显式打开
    expect(resolveCloseToTray(false, 'win32')).toBe(false); // 用户显式关闭
    expect(resolveCloseToTray(undefined, 'win32')).toBe(true); // 缺省 = 平台默认
    expect(resolveCloseToTray(undefined, 'linux')).toBe(false);
    expect(resolveCloseToTray(undefined, 'darwin')).toBe(false);
  });
});

describe('decideWindowClose 决策表（24 组合全覆盖）', () => {
  const platforms = ['win32', 'linux', 'darwin'] as const;
  for (const platform of platforms) {
    for (const closeToTrayEnabled of [true, false]) {
      for (const trayCreated of [true, false]) {
        for (const explicitQuit of [true, false]) {
          // 期望：三重门全过且非显式退出才 hide；其余一律放行关闭
          const shouldHide = platform !== 'darwin' && closeToTrayEnabled && trayCreated && !explicitQuit;
          it(`${platform} × closeToTray=${closeToTrayEnabled} × tray=${trayCreated} × explicitQuit=${explicitQuit} → ${
            shouldHide ? 'hide-to-tray' : 'proceed-close'
          }`, () => {
            expect(decideWindowClose({ platform, closeToTrayEnabled, trayCreated, explicitQuit })).toBe(
              shouldHide ? 'hide-to-tray' : 'proceed-close',
            );
          });
        }
      }
    }
  }
});

describe('关窗裁决语义要点（对照 Z-47 条目）', () => {
  it('mac 任何组合都 proceed（关窗语义维持现状，不改 darwin 分支）', () => {
    for (const enabled of [true, false]) {
      for (const tray of [true, false]) {
        expect(
          decideWindowClose({
            platform: 'darwin',
            closeToTrayEnabled: enabled,
            trayCreated: tray,
            explicitQuit: false,
          }),
        ).toBe('proceed-close');
      }
    }
  });

  it('托盘创建失败（能力门不过）→ 即使设置开也 proceed（回落确认退出路径）', () => {
    expect(
      decideWindowClose({ platform: 'win32', closeToTrayEnabled: true, trayCreated: false, explicitQuit: false }),
    ).toBe('proceed-close');
  });

  it('explicitQuit（托盘退出）→ proceed，不被 hide 吞掉', () => {
    expect(
      decideWindowClose({ platform: 'win32', closeToTrayEnabled: true, trayCreated: true, explicitQuit: true }),
    ).toBe('proceed-close');
  });
});

describe('createQuitIntent（markExplicitQuit / before-quit 取消回滚）', () => {
  it('初始非显式；mark 后显式并带原因；rollback 回滚', () => {
    const q = createQuitIntent();
    expect(q.isExplicit()).toBe(false);
    expect(q.reason()).toBeNull();
    q.mark('tray-quit');
    expect(q.isExplicit()).toBe(true);
    expect(q.reason()).toBe('tray-quit');
    q.rollback();
    expect(q.isExplicit()).toBe(false);
    expect(q.reason()).toBeNull();
  });

  it('重复 mark 保持显式；回滚后可再 mark', () => {
    const q = createQuitIntent();
    q.mark('tray-quit');
    q.mark('tray-quit');
    expect(q.isExplicit()).toBe(true);
    q.rollback();
    q.mark('menu-quit');
    expect(q.reason()).toBe('menu-quit');
  });
});
