// slot ↔ React 绑定（D-01）：把注册表里的席位数据渲染成 React 树。
// 壳只渲染「装配好的树」：AppFrame 渲染 root 槽，席位内容由各功能包 inject 进来。
import { useCallback, useSyncExternalStore } from 'react';
import type { SlotRegistry } from './registry.js';
import type { SlotEntry } from './types.js';

const EMPTY: readonly SlotEntry[] = Object.freeze([]);

/** 订阅某席位的解析结果（注册表内部按需缓存，引用稳定 → 无变化不重渲染） */
export function useSeatEntries(registry: SlotRegistry, seat: string): readonly SlotEntry[] {
  const subscribe = useCallback((cb: () => void) => registry.subscribe(cb), [registry]);
  const getSnapshot = useCallback(() => registry.entries(seat), [registry, seat]);
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

export interface SlotHostProps {
  registry: SlotRegistry;
  /** 目标席位 id */
  seat: string;
  /** keyed 席位当前激活的 key（未提供 = 全部渲染；提供但没有对应条目 = 不渲染，绝不取「第一个」） */
  activeKey?: string;
  /**
   * 席位宿主当帧补传给占用方的 props（覆盖注入时的同名静态 props）：
   * 上游 `renderSlot('rightbar', { width, viewportWidth, canShow })` 的等价物 —— 几何/事实由帧算，
   * props 由占用方消费（如空间不足时的自行关闭）。
   */
  ownerProps?: Readonly<Record<string, unknown>>;
  /** 席位为空时的兜底内容 */
  fallback?: React.ReactNode;
}

/**
 * 渲染某席位的全部激活贡献。
 * 每个贡献包一层 display:contents 的容器（不参与布局，仅供断言/调试看归属）。
 */
export function SlotHost({ registry, seat, activeKey, ownerProps, fallback }: SlotHostProps): React.ReactNode {
  const all = useSeatEntries(registry, seat);
  const entries = activeKey === undefined ? all : all.filter((e) => e.key === activeKey);
  if (entries.length === 0) return <>{fallback ?? null}</>;
  return (
    <>
      {entries.map((e) => (
        <div
          key={`${e.owner}:${e.key ?? ''}#${e.seq}`}
          className="slot-entry"
          data-slot={e.seat}
          data-slot-owner={e.owner}
          data-slot-key={e.key ?? undefined}
        >
          {e.render(ownerProps)}
        </div>
      ))}
    </>
  );
}
