// 宿主能力端口（HostBridge）：**可选**的壳侧能力，由各壳注入真实实现，缺失即如实降级。
//
// 为什么需要它：共享呈现层里少数组件（diff 卡片要读 rewind 快照、文件预览要读文本）需要
// 宿主提供的能力，而各壳能力面不同（桌面 = preload 桥；web = serve HTTP）。共享包**不得**
// import 桌面桥，也不得假设某个壳一定有该能力，因此：
//   - 端口是**尽力而为**的：方法可缺省（`?`），组件遇到缺失就显示「此壳未提供该通道」，
//     绝不伪造内容、也不摆假入口；
//   - 注入方式两条并用：React 上下文（`HostBridgeProvider`，推荐，测试友好）优先，
//     否则回落到壳在 `globalThis.harness2` 上挂的桥对象（桌面 preload 的既有形状）。
//
// 边界：本文件只声明端口与读取，不含任何壳的具体实现。
import { createContext, useContext, type ReactNode } from 'react';
import type { FileRefReadResultShape, SnapshotForCallShape } from '../shared/protocol.js';

/** 壳侧可选能力集合（全部尽力而为，缺失 = 该功能如实不可用） */
export interface HostBridge {
  /** 读 `@file` 引用内容（壳侧边界校验 + 截断；失败如实返回 { ok: false, error }） */
  readFileForRef?(path: string, cwd: string): Promise<FileRefReadResultShape>;
  /** 读指定 tool/call 事件 seq 对应的文件快照（rewind_points 单条；只读） */
  getSnapshotForCall?(sessionId: string, seq: number): Promise<SnapshotForCallShape>;
}

/** `globalThis.harness2` 上的壳桥对象（桌面 preload 的既有形状；web 也可挂自己的实现） */
export function ambientHostBridge(): HostBridge | undefined {
  const holder = globalThis as { harness2?: HostBridge } | undefined;
  return holder?.harness2;
}

const HostBridgeContext = createContext<HostBridge | undefined>(undefined);

export interface HostBridgeProviderProps {
  readonly value: HostBridge | undefined;
  /** 子节点（JSX 直接嵌套；经 createElement 传第三个参数亦可） */
  readonly children?: ReactNode;
}

/** 注入宿主能力端口（壳的组装根使用；测试可直接包一层假实现，不必动全局） */
export function HostBridgeProvider(props: HostBridgeProviderProps): ReactNode {
  return <HostBridgeContext.Provider value={props.value}>{props.children}</HostBridgeContext.Provider>;
}

/** 读宿主能力端口：上下文优先，其次壳挂在 `globalThis.harness2` 上的桥；都没有 = undefined */
export function useHostBridge(): HostBridge | undefined {
  const injected = useContext(HostBridgeContext);
  return injected ?? ambientHostBridge();
}
