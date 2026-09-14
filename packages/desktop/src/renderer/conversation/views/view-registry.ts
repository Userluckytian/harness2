// 对话视图注册表（D-30）：`UiConversation.views` 的等价物。
//
// 与 slot 注册表（renderer/slots）是**两层不同的注册表**，不要混淆：
//   slot 注册表 —— 壳级席位（sidebar / main 的 conversation key / rightbar / shell.overlay）；
//   视图注册表 —— **会话内**视图环的标签页（Chat / Trajectory / …），key 只在会话内唯一。
//
// 语义（D-30）：对话装配层不绑定具体渲染目标；本注册表是视图的唯一来源 ——
//   拒重复 key、保注册顺序（注册顺序即标签顺序）、幂等 disposer、可订阅（快照引用稳定）。
// 组件 → ReactNode 的绑定只发生在本文件的 render 闭包（与 slots/registry.ts 同一手法），
// 其余逻辑（顺序 / 去重 / 订阅）与框架无关。
import { createElement } from 'react';
import type { ComponentType, ReactNode } from 'react';
import type { SessionImageUrlResolver } from './image-url-cache.js';

/** 视图注册表契约错误（重复 key / 空 key / 非法定义） */
export class ConversationViewRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationViewRegistryError';
  }
}

/** 视图组件收到的 props（D-30：装配层给视图的全部上下文，视图不自己去翻全局单例） */
export interface ConversationViewProps<S = unknown> {
  /** 当前会话 id（视图环不跨会话） */
  readonly sessionId: string;
  /**
   * 会话对象（身份稳定）。D-32：切换视图**不重建会话** ——
   * 同一会话内本对象始终是同一个引用；换会话才换引用。
   */
  readonly session: S;
  /** D-39：取当前会话内某附件的**已缓存**图片 URL（无缓存返回 null；授权读取由缓存 API 触发） */
  readonly imageUrl: SessionImageUrlResolver;
}

/** 视图定义（注册入参）：一眼可读的标签标题 + 归属包名 + 组件 */
export interface ConversationViewDefinition<S = unknown> {
  /** 会话内唯一 key（如 'chat' / 'trajectory'） */
  readonly key: string;
  /** 标签标题（视图环显示） */
  readonly title: string;
  /** 归属包名（D-02 口径：每个 UI 能力一个包名，便于审查「哪份内容属于哪个能力」） */
  readonly owner: string;
  readonly component: ComponentType<ConversationViewProps<S>>;
}

/** 视图登记项：定义 + 注册序号 + 渲染闭包 */
export interface ConversationViewEntry<S = unknown> {
  readonly key: string;
  readonly title: string;
  readonly owner: string;
  /** 注册序号（注册顺序的稳定依据） */
  readonly seq: number;
  readonly component: ComponentType<ConversationViewProps<S>>;
  /** 用当前视图上下文渲染本视图（React 绑定只此一处） */
  readonly render: (ctx: ConversationViewProps<S>) => ReactNode;
}

const EMPTY: readonly never[] = Object.freeze([]);

export class ConversationViewRegistry<S = unknown> {
  private readonly entries: ConversationViewEntry<S>[] = [];
  private readonly listeners = new Set<() => void>();
  private cache: readonly ConversationViewEntry<S>[] | null = null;
  private seq = 0;

  /**
   * 注册一个视图；返回**幂等 disposer**（重复调用只卸载一次）。
   * 拒重复 key（活跃视图 key 冲突即抛错）；保注册顺序。
   */
  register(definition: ConversationViewDefinition<S>): () => void {
    if (definition.key.length === 0) {
      throw new ConversationViewRegistryError('视图 key 不能为空');
    }
    if (this.find(definition.key) !== undefined) {
      throw new ConversationViewRegistryError(`视图 key 重复注册: ${definition.key}`);
    }
    const entry: ConversationViewEntry<S> = {
      key: definition.key,
      title: definition.title,
      owner: definition.owner,
      seq: this.seq++,
      component: definition.component,
      render: (ctx) => createElement(definition.component, ctx),
    };
    this.entries.push(entry);
    this.invalidate();
    let disposed = false;
    return () => {
      if (disposed) return; // 幂等 disposer
      disposed = true;
      const index = this.entries.indexOf(entry);
      if (index < 0) return;
      this.entries.splice(index, 1);
      this.invalidate();
    };
  }

  /** 已注册视图快照（注册顺序；无变化时返回同一引用，供 useSyncExternalStore 使用） */
  views(): readonly ConversationViewEntry<S>[] {
    if (this.cache === null) this.cache = Object.freeze([...this.entries]);
    return this.cache;
  }

  /** 已注册 key（注册顺序）—— D-31 选择规则的输入 */
  keys(): readonly string[] {
    return this.views().map((entry) => entry.key);
  }

  has(key: string): boolean {
    return this.find(key) !== undefined;
  }

  get(key: string): ConversationViewEntry<S> | undefined {
    return this.find(key);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 清空全部视图（壳重挂载 / 测试重置用）；disposer 之后调用也安全（幂等） */
  clear(): void {
    if (this.entries.length === 0) return;
    this.entries.length = 0;
    this.invalidate();
  }

  private find(key: string): ConversationViewEntry<S> | undefined {
    return this.entries.find((entry) => entry.key === key);
  }

  /** 集合变化才通知（快照引用稳定 → 无意义重渲染被挡在订阅侧） */
  private invalidate(): void {
    this.cache = null;
    for (const listener of [...this.listeners]) listener();
  }
}

/** 便捷工厂（便于测试与壳装配） */
export function createConversationViewRegistry<S = unknown>(): ConversationViewRegistry<S> {
  return new ConversationViewRegistry<S>();
}

/** 空快照常量（不依赖泛型的 getServerSnapshot 兜底） */
export function emptyViewEntries<S>(): readonly ConversationViewEntry<S>[] {
  return EMPTY as readonly ConversationViewEntry<S>[];
}
