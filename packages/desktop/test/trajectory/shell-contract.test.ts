// D-46 契约测试：composer 浮层高度测量 → 记录表预留内边距。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMPOSER_OVERLAY_GAP_PX,
  DEFAULT_COMPOSER_INSET_PX,
  TRAJECTORY_COMPOSER_INSET_VAR,
  composerInsetCssValue,
  composerOverlayInsetCss,
  composerOverlayInsetPx,
  composerOverlayStyle,
  createComposerOverlayHost,
  initialComposerOverlayState,
  overlayInsetFromHost,
  parseComposerInsetPx,
} from '@harness2/ui-shared/renderer/trajectory/shell-contract.js';

/** 最小 ResizeObserver 替身（记录 observe/disconnect，手动触发回调） */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(element: Element): void {
    this.observed.push(element);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  unobserve(): void {
    // 本契约不使用
  }
  emit(height: number): void {
    this.callback([{ contentRect: { height } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

afterEach(() => {
  FakeResizeObserver.instances = [];
  vi.unstubAllGlobals();
});

describe('预留内边距计算', () => {
  it('未测量/非法/非正高度 → 0（不虚构预留）', () => {
    expect(composerOverlayInsetPx(null)).toBe(DEFAULT_COMPOSER_INSET_PX);
    expect(composerOverlayInsetPx(Number.NaN)).toBe(0);
    expect(composerOverlayInsetPx(0)).toBe(0);
    expect(composerOverlayInsetPx(-10)).toBe(0);
    expect(initialComposerOverlayState()).toEqual({ heightPx: null, overlay: true, insetPx: 0 });
  });

  it('实测高度 + 间距（默认 12px）；间距可覆盖', () => {
    expect(COMPOSER_OVERLAY_GAP_PX).toBe(12);
    expect(composerOverlayInsetPx(100)).toBe(112);
    expect(composerOverlayInsetPx(100, 0)).toBe(100);
    expect(composerOverlayInsetCss(100)).toBe('112px');
  });

  it('CSS 变量名与样式对象（壳挂到会话容器上）', () => {
    expect(TRAJECTORY_COMPOSER_INSET_VAR).toBe('--trajectory-composer-inset');
    expect(composerOverlayStyle(100)).toEqual({ '--trajectory-composer-inset': '112px' });
    expect(composerInsetCssValue).toBe('var(--trajectory-composer-inset, 0px)');
  });

  it('parseComposerInsetPx 读回 CSS 值（非法 → 0）', () => {
    expect(parseComposerInsetPx('112px')).toBe(112);
    expect(parseComposerInsetPx('0px')).toBe(0);
    expect(parseComposerInsetPx(null)).toBe(0);
    expect(parseComposerInsetPx('abc')).toBe(0);
  });
});

describe('ComposerOverlayHost（壳的测量宿主）', () => {
  it('setHeightPx 更新状态并通知；同值不重复通知', () => {
    const host = createComposerOverlayHost();
    const listener = vi.fn();
    host.subscribe(listener);
    host.setHeightPx(80);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(host.getState()).toEqual({ heightPx: 80, overlay: true, insetPx: 92 });
    host.setHeightPx(80);
    expect(listener).toHaveBeenCalledTimes(1);
    host.setHeightPx(null);
    expect(host.getState().insetPx).toBe(0);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('退订后不再收到通知', () => {
    const host = createComposerOverlayHost();
    const listener = vi.fn();
    const unsubscribe = host.subscribe(listener);
    unsubscribe();
    host.setHeightPx(10);
    expect(listener).not.toHaveBeenCalled();
  });

  it('observe 用 ResizeObserver 跟踪真实高度；高度归零 → 视作未测量', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const host = createComposerOverlayHost();
    const element = { tagName: 'DIV' } as unknown as Element;
    host.observe(element);
    const observer = FakeResizeObserver.instances[0];
    expect(observer?.observed).toEqual([element]);
    observer?.emit(64.4);
    expect(host.getState()).toMatchObject({ heightPx: 64, insetPx: 76 });
    observer?.emit(0);
    expect(host.getState()).toMatchObject({ heightPx: null, insetPx: 0 });
    host.dispose();
    expect(observer?.disconnected).toBe(true);
  });

  it('无 ResizeObserver 环境静默降级（等待显式 setHeightPx）', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const host = createComposerOverlayHost();
    expect(() => host.observe({} as Element)).not.toThrow();
    host.setHeightPx(30);
    expect(host.getState().insetPx).toBe(42);
  });
});

describe('overlayInsetFromHost（视图侧读取）', () => {
  it('未注入宿主 → 0px / none（不冒充浮层）', () => {
    expect(overlayInsetFromHost(undefined)).toEqual({ paddingBottomPx: 0, source: 'none' });
  });

  it('非浮层或未测量 → 0px；有实测 → composer-host', () => {
    expect(overlayInsetFromHost({ heightPx: null, overlay: true, insetPx: 0 })).toEqual({
      paddingBottomPx: 0,
      source: 'none',
    });
    expect(overlayInsetFromHost({ heightPx: 50, overlay: false, insetPx: 62 })).toEqual({
      paddingBottomPx: 0,
      source: 'none',
    });
    expect(overlayInsetFromHost({ heightPx: 50, overlay: true, insetPx: 62 })).toEqual({
      paddingBottomPx: 62,
      source: 'composer-host',
    });
  });
});
