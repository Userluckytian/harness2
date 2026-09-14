// composer-chain.ts — `conversation.composer` 链与 takeover 选举（D-38）。
//
// 规格依据：docs/refs/refs-deepseek-harness.md D-38 与上游
// `packages/client/ui-conversation/README.zh.md`「临时 composer entry」节：
//   - owner currency = `ComposerChainProps{sessionId, session, pendingInteraction}`；
//   - `ChainSelect` 是 owner currency 的**纯函数**：返回非 null 即接管，返回值作为 `matched`
//     传给接管组件；
//   - 链顺序：**priority 升序 → 注册顺序**；首个返回非 null 的 selector 获选；无人接管 = null；
//   - shell 在 takeover 下**保持默认 composer 挂载**（本模块只负责选举与渲染闭包，
//     保持挂载由 Composer 组件落实）。
//
// 与 slots 注册表同构（同样的类型擦除技法），但只服务于一条链，不引入席位系统依赖。
import { createElement } from 'react';
import type { ComponentType, ReactNode } from 'react';

/** 链名（与上游 `ctx.slots.register({ name: 'conversation.composer' })` 同名） */
export const COMPOSER_CHAIN_NAME = 'conversation.composer' as const;

/** 当前会话的生命周期快照（owner currency 的 `session` 位；无选中会话 = undefined） */
export interface ComposerSessionSnapshot {
  readonly id: string;
  readonly running: boolean;
  /** 运行中回合的 turnId（steer 需绑定它；未知 = undefined，绝不猜） */
  readonly activeTurnId?: string;
  readonly title?: string;
}

/** 该会话中等待用户的业务交互（owner currency 的 `pendingInteraction` 位） */
export interface PendingInteraction {
  readonly id: string;
  readonly kind: string;
  /** 业务包名（request-specific 状态归它，不进 SessionSnapshot） */
  readonly owner?: string;
  readonly payload?: unknown;
}

/** composer 链的 owner currency（D-38 逐字形状） */
export interface ComposerChainProps {
  readonly sessionId: string | undefined;
  readonly session: ComposerSessionSnapshot | undefined;
  readonly pendingInteraction: PendingInteraction | undefined;
}

/** 纯 selector：返回非 null = 接管该会话的 composer */
export type ChainSelect<TMatched> = (owner: ComposerChainProps) => TMatched | null;

/** 带匹配结果的接管（`matched` 传给接管组件） */
export interface ComposerChainTakeover {
  readonly entry: ComposerChainEntry;
  readonly matched: unknown;
}

/** 类型擦除后的链登记项 */
export interface ComposerChainEntry {
  readonly owner: string;
  readonly priority: number;
  /** 注册序号（同 priority 时的稳定次序依据） */
  readonly seq: number;
  readonly select: ChainSelect<unknown>;
  readonly component: ComponentType<Record<string, unknown>>;
}

export interface ComposerChainRegistration<TMatched> {
  readonly owner: string;
  /** 升序：数值小者先被询问（= 抢先） */
  readonly priority?: number;
  readonly select: ChainSelect<TMatched>;
  readonly component: ComponentType<ComposerChainProps & { matched: TMatched }>;
}

/** 链顺序：priority 升序 → 注册顺序（同 priority 保注册先后） */
export function sortComposerChain(entries: readonly ComposerChainEntry[]): readonly ComposerChainEntry[] {
  return [...entries].sort((a, b) => (a.priority === b.priority ? a.seq - b.seq : a.priority - b.priority));
}

/**
 * 选举 takeover（纯函数）：按链顺序逐个询问 selector，**首个返回非 null 者获选**；
 * 全部返回 null = 无人接管（null）。
 */
export function selectComposerTakeover(
  entries: readonly ComposerChainEntry[],
  props: ComposerChainProps,
): ComposerChainTakeover | null {
  for (const entry of sortComposerChain(entries)) {
    const matched = entry.select(props);
    if (matched !== null) return { entry, matched };
  }
  return null;
}

/** 渲染取选的接管组件（`matched` 与标准 props 合并交给组件） */
export function renderComposerTakeover(takeover: ComposerChainTakeover, props: ComposerChainProps): ReactNode {
  return createElement(takeover.entry.component, { ...props, matched: takeover.matched });
}

/** 登记项擦除（全链唯一一处类型擦除，对外 API 仍类型安全） */
function erase<TMatched>(registration: ComposerChainRegistration<TMatched>, seq: number): ComposerChainEntry {
  const component = registration.component as unknown as ComponentType<Record<string, unknown>>;
  const select = registration.select as unknown as ChainSelect<unknown>;
  return { owner: registration.owner, priority: registration.priority ?? 0, seq, select, component };
}

/** composer 链注册表（可订阅；接线棒在壳里持有一个实例，Composer 读它做 takeover） */
export class ComposerChain {
  private readonly entriesList: ComposerChainEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private seq = 0;
  /** 版本号：注册/卸载/清空都 +1（`useSyncExternalStore` 的快照位，P2-2） */
  private version = 0;

  /** 快照读取器（稳定引用；与 subscribe 成对交给 useSyncExternalStore） */
  readonly getVersion = (): number => this.version;

  /** 注册一条链项；返回幂等 disposer（重复调用只卸载一次） */
  register<TMatched>(registration: ComposerChainRegistration<TMatched>): () => void {
    const entry = erase(registration, this.seq++);
    this.entriesList.push(entry);
    this.emit();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const index = this.entriesList.indexOf(entry);
      if (index < 0) return;
      this.entriesList.splice(index, 1);
      this.emit();
    };
  }

  entries(): readonly ComposerChainEntry[] {
    return sortComposerChain(this.entriesList);
  }

  select(props: ComposerChainProps): ComposerChainTakeover | null {
    return selectComposerTakeover(this.entriesList, props);
  }

  /**
   * 订阅链变化（**箭头属性**：可脱离实例传递 —— `useSyncExternalStore(chain.subscribe, chain.getVersion)`），
   * 与 `getVersion` 成对；注册/卸载/清空都会通知（P2-2）。
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 清空链（壳重挂载 / 测试重置用） */
  clear(): void {
    if (this.entriesList.length === 0) return;
    this.entriesList.splice(0, this.entriesList.length);
    this.emit();
  }

  private emit(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}
