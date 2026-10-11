import { useCallback, useSyncExternalStore } from 'react';
// D-46 壳的义务契约：composer 作为**浮层**置于全高转录之上，并预留其实时高度。
//
// 分工（本棒不做装配）：
//   * **壳**（ConversationSeat）：把 composer 渲染成浮层（`position: sticky/absolute`），并用
//     `createComposerOverlayHost()` 实时测量其高度，把结果写到会话容器的 CSS 变量上；
//   * **转录**（`.messages` 滚动叶容器）：只消费「预留内边距」——缺省读 CSS 变量
//     `--composer-inset`，无变量时退回 0px（= 壳没接浮层，如实不预留，也不冒充）。
//
// Z2-05 起该机制只服务 **chat 主视图**（Z-16：主区事实单一 chat）；trajectory 已迁右栏 tab，
// 记录表不再浮在 composer 之下，故变量从 `--trajectory-composer-inset` 更名为 `--composer-inset`，
// 轨迹侧的预留消费方已随迁移拆除。

/** 壳写、转录滚动叶容器读的 CSS 变量名（预留高度，px；Z2-05 起只服务 chat 主视图） */
export const COMPOSER_INSET_VAR = '--composer-inset';
/** 浮层与最后一条记录之间保留的间距（避免内容贴住 composer 上沿） */
export const COMPOSER_OVERLAY_GAP_PX = 12;
/** 缺省（未接入浮层）的预留高度 */
export const DEFAULT_COMPOSER_INSET_PX = 0;

/** composer 浮层测量状态（壳持有；视图只读预留高度） */
export interface ComposerOverlayState {
  /** composer 实测高度（px）；null = 尚未测量（不猜测，预留 0） */
  readonly heightPx: number | null;
  /** 是否浮层形态（D-46 要求 true；false = 仍占文档流，视图无需预留） */
  readonly overlay: boolean;
  /** 预留内边距（px，含间距） */
  readonly insetPx: number;
}

export function initialComposerOverlayState(): ComposerOverlayState {
  return { heightPx: null, overlay: true, insetPx: DEFAULT_COMPOSER_INSET_PX };
}

/** 实测高度 → 预留内边距（含间距）。未测量/非法/非正高度 → 0（不虚构预留） */
export function composerOverlayInsetPx(heightPx: number | null, gapPx: number = COMPOSER_OVERLAY_GAP_PX): number {
  if (heightPx === null || !Number.isFinite(heightPx) || heightPx <= 0) return DEFAULT_COMPOSER_INSET_PX;
  return Math.round(heightPx + Math.max(0, gapPx));
}

/** 预留内边距的 CSS 值（视图容器 `padding-bottom` 直接用） */
export function composerOverlayInsetCss(heightPx: number | null, gapPx: number = COMPOSER_OVERLAY_GAP_PX): string {
  return `${composerOverlayInsetPx(heightPx, gapPx)}px`;
}

/** 壳挂到会话容器上的内联样式（值就是 CSS 变量） */
export function composerOverlayStyle(
  heightPx: number | null,
  gapPx: number = COMPOSER_OVERLAY_GAP_PX,
): Record<string, string> {
  return { [COMPOSER_INSET_VAR]: composerOverlayInsetCss(heightPx, gapPx) };
}

/** 从 CSS 变量读回预留高度（测试断言用）；非法 → 0 */
export function parseComposerInsetPx(value: string | null | undefined): number {
  if (typeof value !== 'string') return DEFAULT_COMPOSER_INSET_PX;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_COMPOSER_INSET_PX;
}

/** 消费侧读 CSS 变量的兜底表达式（样式表/内联样式同用） */
export const composerInsetCssValue = `var(${COMPOSER_INSET_VAR}, 0px)`;

/**
 * 壳持有的浮层测量宿主：`setHeightPx` 由壳（ResizeObserver / 布局回调）驱动，
 * 视图侧可用 `subscribe + getState` 订阅（见 `useComposerOverlayInset`）。
 */
export interface ComposerOverlayHost {
  setHeightPx(heightPx: number | null): void;
  getState(): ComposerOverlayState;
  subscribe(listener: () => void): () => void;
  /** 观察元素真实高度（无 ResizeObserver 的环境静默降级，等待显式 setHeightPx） */
  observe(element: Element | null): void;
  dispose(): void;
}

export function createComposerOverlayHost(): ComposerOverlayHost {
  let state = initialComposerOverlayState();
  const listeners = new Set<() => void>();
  let observer: ResizeObserver | null = null;

  const apply = (heightPx: number | null): void => {
    const next: ComposerOverlayState = {
      heightPx,
      overlay: true,
      insetPx: composerOverlayInsetPx(heightPx),
    };
    state = next;
    for (const listener of [...listeners]) listener();
  };

  return {
    setHeightPx(heightPx) {
      if (state.heightPx === heightPx) return;
      apply(heightPx);
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    observe(element) {
      if (observer !== null) {
        observer.disconnect();
        observer = null;
      }
      if (element === null) return;
      if (typeof ResizeObserver === 'undefined') return; // 环境无 RO：退回显式 setHeightPx
      observer = new ResizeObserver((entries) => {
        const entry = entries.at(-1);
        if (entry === undefined) return;
        const height = Math.round(entry.contentRect.height);
        apply(height > 0 ? height : null);
      });
      observer.observe(element);
    },
    dispose() {
      observer?.disconnect();
      observer = null;
      listeners.clear();
    },
  };
}

/**
 * 记录表内容容器的内边距契约（D-46 的「预留实时高度」）。
 * 视图把 `paddingBottomPx` 加到滚动内容底部 —— 保证最后一条记录不被浮层遮住。
 */
export interface TrajectoryOverlayInset {
  readonly paddingBottomPx: number;
  /** 来源：'composer-host'（壳实测）/ 'css-var'（壳写了变量）/ 'none'（无浮层） */
  readonly source: 'composer-host' | 'css-var' | 'none';
}

export function overlayInsetFromHost(state: ComposerOverlayState | undefined): TrajectoryOverlayInset {
  if (state === undefined || !state.overlay || state.insetPx <= 0) {
    return { paddingBottomPx: DEFAULT_COMPOSER_INSET_PX, source: 'none' };
  }
  return { paddingBottomPx: state.insetPx, source: 'composer-host' };
}

/**
 * D-46 消费端 Hook：订阅壳持有的 composer 浮层实测高度。
 * 壳未接（undefined）或未测量 → undefined（调用方据此走 CSS 变量兜底，不虚构预留）。
 *
 * 归属说明：本 Hook 原先长在桌面轨迹模块里，但它只依赖壳注入的 host 端口（与轨迹无关），
 * P8 起随契约一起下沉共享包；desktop 轨迹模块改为再导出（行为零改动）。
 */
export function useComposerOverlayInset(host: ComposerOverlayHost | undefined): number | undefined {
  const subscribe = useCallback(
    (listener: () => void) => (host === undefined ? () => undefined : host.subscribe(listener)),
    [host],
  );
  const getSnapshot = useCallback(() => (host === undefined ? undefined : host.getState()), [host]);
  const state = useSyncExternalStore(subscribe, getSnapshot, () => undefined);
  const inset = overlayInsetFromHost(state);
  return inset.paddingBottomPx > 0 ? inset.paddingBottomPx : undefined;
}
