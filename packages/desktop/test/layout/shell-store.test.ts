// @vitest-environment jsdom
// 壳级内存仓库测试（布局/覆层开合的数据源，D-14 口径：只存内存、不落盘）。
import { describe, expect, it, vi } from 'vitest';
import { createShellStore } from '../../src/renderer/layout/shell-store.js';
import {
  closeAllOverlays,
  setOverlay,
  shellOverlayStore,
  toggleOverlay,
} from '../../src/renderer/layout/shell-overlays.js';

describe('createShellStore', () => {
  it('patch 浅合并；值全等时不改快照也不通知（避免无意义重渲染）', () => {
    const store = createShellStore({ a: 1, b: 2 });
    const listener = vi.fn();
    store.subscribe(listener);
    const first = store.getSnapshot();
    expect(first).toEqual({ a: 1, b: 2 });

    store.patch({ a: 1 });
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(first);

    store.patch({ a: 3 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual({ a: 3, b: 2 });
    expect(store.getSnapshot()).not.toBe(first); // 新快照引用

    store.reset();
    expect(store.getSnapshot()).toEqual({ a: 1, b: 2 });
  });

  it('退订后不再收到通知；快照不可变（外部改不动）', () => {
    const store = createShellStore({ a: 1 });
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    unsub();
    store.patch({ a: 2 });
    expect(listener).not.toHaveBeenCalled();
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
  });
});

describe('覆层开关仓库（shell.overlay 席位数据源）', () => {
  it('默认全关；set/toggle/closeAll 语义正确且不落盘', () => {
    closeAllOverlays();
    expect(shellOverlayStore.getSnapshot()).toEqual({ settings: false, palette: false });
    setOverlay('settings', true);
    expect(shellOverlayStore.getSnapshot().settings).toBe(true);
    toggleOverlay('palette');
    expect(shellOverlayStore.getSnapshot().palette).toBe(true);
    toggleOverlay('palette');
    expect(shellOverlayStore.getSnapshot().palette).toBe(false);
    setOverlay('palette', true);
    closeAllOverlays();
    expect(shellOverlayStore.getSnapshot()).toEqual({ settings: false, palette: false });
    // 覆层状态同样只存内存：没有任何浏览器存储键
    expect(window.localStorage.length).toBe(0);
  });
});
