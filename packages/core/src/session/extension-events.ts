// 扩展事件类型注册表（D02 内核可扩展性第一开放：事件类型开放化）。
// 语义参照 refs-deepseek-harness D-30（注册表：拒重复 key、保注册顺序、幂等注销）——
// 只取注册表语义，不引 Cordis 运行时。
//
// 生命周期立场（与 D02 报告同步）：**进程级单例**。事件类型 schema 是进程级契约
// （与会话日志格式代际同源），同进程的多会话/多 writer/reader 共享同一注册表是正确语义；
// 测试隔离经 reset()（清空全部扩展注册，内建 11 种白名单不受影响）。
// 内建事件（11 种）不在本注册表管理范围：types.ts 的 KNOWN_EVENT_TYPES 白名单与
// parseEventLine 行为零变化；本模块只负责「注册 → writer 接受 → reader 解析 →
// 投影 opaque 通道」这条加性链路。
import { KNOWN_EVENT_TYPES, SESSION_FORMAT_VERSION } from './types.js';

/** 扩展事件 payload 的最低校验器（与内建 PAYLOAD_VALIDATORS 同口径：非法即拒） */
export type ExtensionPayloadValidator = (payload: Record<string, unknown>) => boolean;

/** 扩展事件类型定义（注册的最小单元） */
export interface ExtensionEventTypeDefinition {
  /** 事件类型名（不得与内建 11 种重名，不得与本注册表已注册类型重名；不得含空白） */
  type: string;
  /** payload 最低校验；返回 false 的行在写入口（appendExtension）与解析层都被拒（fail-closed） */
  validator: ExtensionPayloadValidator;
  /** 投影语义：当前仅支持 'opaque'——不进消息投影、不进模型上下文，参与 rewind 遮蔽窗口 */
  projection?: 'opaque';
}

/** 扩展事件信封（与内建事件同构：v/seq/ts/type/payload；payload 形状由注册的 validator 保证） */
export interface ExtensionSessionEvent {
  /** 格式代际（与内建事件一致，日志仍是 session.v1.jsonl） */
  v: 1;
  /** 会话内单调递增序号（与内建事件共用同一 seq 空间） */
  seq: number;
  /** ISO8601 UTC 时间戳 */
  ts: string;
  /** 注册过的扩展类型名（不在 SessionEventType 联合内） */
  type: string;
  payload: Record<string, unknown>;
}

/** 读取层的扩展事件条目（active 由 computeProjection 就地回填，与 LoadedEvent 同构） */
export interface LoadedExtensionEvent {
  event: ExtensionSessionEvent;
  /** 是否在当前活动投影内（被 rewind 遮蔽为 false；影子事件保留可全量导出） */
  active: boolean;
}

/** 类型名约束：非空、不含空白字符（避免与行解析/日志工具冲突） */
const TYPE_RE = /^\S+$/;

/** 扩展事件类型注册表（进程级单例见 extensionEventTypes；也可独立实例化做协程级隔离） */
export class ExtensionEventTypeRegistry {
  private readonly builtin: ReadonlySet<string>;
  private readonly defs = new Map<string, ExtensionEventTypeDefinition>();

  constructor(builtinTypes: readonly string[] = KNOWN_EVENT_TYPES) {
    this.builtin = new Set(builtinTypes);
  }

  /** 注册扩展事件类型；重名（内建或已注册）与非法定义一律抛错（fail-closed） */
  register(def: ExtensionEventTypeDefinition): void {
    if (typeof def?.type !== 'string' || def.type.length === 0 || !TYPE_RE.test(def.type)) {
      throw new Error(`invalid extension event type name: ${String(def?.type)}`);
    }
    if (this.builtin.has(def.type)) {
      throw new Error(`extension event type "${def.type}" collides with builtin event type`);
    }
    if (this.defs.has(def.type)) {
      throw new Error(`extension event type already registered: ${def.type}`);
    }
    if (typeof def.validator !== 'function') {
      throw new Error(`extension event type "${def.type}": validator must be a function`);
    }
    if (def.projection !== undefined && def.projection !== 'opaque') {
      throw new Error(`extension event type "${def.type}": projection must be 'opaque'`);
    }
    // 只保留受控字段，防止后续在定义对象上挂可变状态
    this.defs.set(def.type, {
      type: def.type,
      validator: def.validator,
      ...(def.projection !== undefined ? { projection: def.projection } : {}),
    });
  }

  /**
   * 注销扩展事件类型（幂等：未注册返回 false）。
   * 已落盘的事件行随注销退回「未知类型」：读侧告警跳过（与未注册未知 type 同现状）；
   * writer open 的恢复路径按既有坏行策略把该行及其后内容视为未提交撕裂区截断——
   * 跨进程打开含扩展事件的会话前，必须保证注册表一致。
   */
  unregister(type: string): boolean {
    return this.defs.delete(type);
  }

  /** 按类型名取定义（未注册返回 undefined） */
  get(type: string): ExtensionEventTypeDefinition | undefined {
    return this.defs.get(type);
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  /** 已注册类型名（注册顺序，与内建 KNOWN_EVENT_TYPES 的「声明序即展示序」同口径） */
  types(): readonly string[] {
    return [...this.defs.keys()];
  }

  /** 测试隔离：清空全部扩展注册（内建白名单不受影响） */
  reset(): void {
    this.defs.clear();
  }
}

/** 进程级单例：同进程全部 SessionWriter / loadSession 共享（立场见文件头） */
export const extensionEventTypes = new ExtensionEventTypeRegistry();

/**
 * 解析一行扩展事件（只查注册表：内建类型、未注册类型、非法行一律返回 null——
 * 调用方负责跳过并告警，与 parseEventLine 的未注册未知 type 现状一致）。
 * 信封校验（v/seq/ts）与内建同口径：代际不对、seq/ts 缺失或类型错即拒。
 */
export function parseExtensionEventLine(
  line: string,
  registry: ExtensionEventTypeRegistry = extensionEventTypes,
): ExtensionSessionEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const e = obj as Record<string, unknown>;
  if (e.v !== SESSION_FORMAT_VERSION) return null;
  if (typeof e.seq !== 'number' || typeof e.ts !== 'string') return null;
  if (typeof e.type !== 'string') return null;
  const def = registry.get(e.type);
  if (def === undefined) return null;
  if (typeof e.payload !== 'object' || e.payload === null) return null;
  if (!def.validator(e.payload as Record<string, unknown>)) return null;
  return obj as ExtensionSessionEvent;
}
