// 帧上下文：把「四席位容器的几何与派发」交给各席位容器组件（root 槽里的贡献）。
import { createContext, useContext } from 'react';
import type { SlotRegistry } from '../slots/index.js';
import type { FrameGeometry } from './geometry.js';
import type { FrameAction, FrameState } from './frame-state.js';

export interface FrameController {
  readonly state: FrameState;
  readonly geometry: FrameGeometry;
  readonly registry: SlotRegistry;
  /** 最近一次视口测量宽度（帧状态自带；D-13 自动收起/右栏上限据此判定） */
  readonly viewportWidth: number;
  /** 降动效偏好（D-16；CSS media query 之外的可观测标记） */
  readonly reducedMotion: boolean;
  dispatch(action: FrameAction): void;
}

const FrameContext = createContext<FrameController | null>(null);

export const FrameProvider = FrameContext.Provider;

/** 取帧控制器（只在帧席位容器内可用） */
export function useFrame(): FrameController {
  const value = useContext(FrameContext);
  if (value === null) throw new Error('useFrame 必须在 AppFrame 内使用');
  return value;
}
