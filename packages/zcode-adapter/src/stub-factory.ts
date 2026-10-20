/**
 * stub-factory —— ZS1 桩服务工厂
 *
 * 语义（ZS1 计划 Global Constraints 3 / 红线⑩）：
 * - C 类（云端绑定/专有）：静默空实现——读路径返回空值/空数组，`on*` 事件永不触发；
 *   不得让 UI 出现「可点但必炸」的假入口（读路径给空数据的入口会自然显示空列表）。
 * - B 类（v4 竖切/UI 支撑，ZS2/ZS3 补）：显式 `throw ZS1: not implemented`——
 *   调用即炸比静默假成功安全；空态启动路径不应触达（触达点由 T3 实测定位并登记）。
 * - A 类（core 已有，ZS2+ 映射）：读路径返回空态形状（显式 impl），写路径 throw。
 *
 * 事件语义与 @zcode/rpc ProxyChannel.fromService 对齐：
 * - `onXxx`（静态事件）→ Event.None（永不触发）
 * - `onDynamicXxx`（动态事件方法）→ 返回 Event.None
 * - 其余方法 → RPC call。
 *
 * ZCode 自家先例：conversationShare.ts 的 createUnsupportedConversationShareService
 * （动作 reject / 事件 None / 只读查询 null）——本工厂是同一语义的泛化。
 */
import { Event } from "@zcode/rpc";

/** A: 映射 core（ZS2+）· B: v4 竖切/UI 支撑（ZS2/ZS3）· C: 云端绑定/专有（静默或 ZS6 隐藏） */
export type StubClassification = "A" | "B" | "C";

export interface StubSpec {
  /** 频道名（ServiceChannels 值），用于报错定位 */
  readonly channelName: string;
  readonly classification: StubClassification;
  /**
   * 显式实现（空态路径实证触达的方法，形状经 TS 类型对齐）。
   * 未列出的方法按分类走默认行为。
   */
  readonly impl?: Record<string, unknown>;
  /** 显式 throw 的方法名（覆盖分类默认；写路径/支付动作等「假成功不可接受」的入口） */
  readonly throws?: readonly string[];
  /** 显式返回 null 的方法名（覆盖分类默认；C 类读路径形状无法安全构造时的兜底） */
  readonly nulls?: readonly string[];
}

export function notImplementedError(channelName: string, method: string): Error {
  const error = new Error(`ZS1: not implemented (channel=${channelName}, method=${method})`);
  (error as Error & { code?: string }).code = "ZS1_NOT_IMPLEMENTED";
  return error;
}

function isEventName(name: string): boolean {
  return (
    name.length >= 3 && name[0] === "o" && name[1] === "n" && name.charCodeAt(2) >= 65 &&
    name.charCodeAt(2) <= 90
  );
}

function isDynamicEventName(name: string): boolean {
  return name.length >= 10 && name.startsWith("onDynamic") && name.charCodeAt(9) >= 65 &&
    name.charCodeAt(9) <= 90;
}

/**
 * 生成一个满足服务接口形状的桩对象。
 *
 * 类型对齐方式：`impl` 的键值在调用侧以 `Record<string, unknown>` 传入前，
 * 显式方法在 stubs/*.ts 中先以接口类型标注的局部常量实现（编译期校验形状），
 * 再交给本工厂补默认行为；本函数返回值经 `satisfies`/赋值给接口类型变量完成整体对齐。
 */
export function createStubService<T extends object>(spec: StubSpec): T {
  const impl = (spec.impl ?? {}) as Record<string, unknown>;
  return new Proxy(impl as T, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      // thenable 探测（React/日志工具会读 then；返回 undefined 避免被误判为 Promise）
      if (prop === "then") return undefined;
      if (Object.prototype.hasOwnProperty.call(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      if (isDynamicEventName(prop)) {
        return () => Event.None;
      }
      if (isEventName(prop)) {
        return Event.None;
      }
      if (spec.throws?.includes(prop)) {
        // async throw：RPC 语义下远端错误总是 rejected promise（ProxyChannel.call 会把
        // 同步 throw 直接炸出调用点，破坏 expect().rejects 与 UI 侧错误处理）
        return async (): Promise<never> => {
          throw notImplementedError(spec.channelName, prop);
        };
      }
      if (spec.nulls?.includes(prop)) {
        return async () => null;
      }
      if (spec.classification === "B") {
        return async (): Promise<never> => {
          throw notImplementedError(spec.channelName, prop);
        };
      }
      // A/C 默认：读路径返回 null（空态实证触达的方法已在 impl 显式给形状）
      return async () => null;
    },
  });
}
