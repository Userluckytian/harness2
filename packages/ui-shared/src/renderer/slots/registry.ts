// slot 注册表（D-01）：声明式席位 + 注入 + 解析。
// 纯逻辑、不碰 DOM / store；只借用 React 的 createElement 把贡献适配成渲染闭包，便于单测与跨壳复用。
import { createElement } from 'react';
import type { ComponentType } from 'react';
import type { SeatDeclaration, SeatKind, SlotContribution, SlotEntry } from './types.js';

/** 注册表契约错误（重复声明 / 未声明席位 / keyed 缺 key 或重复 key） */
export class SlotRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotRegistryError';
  }
}

const EMPTY: readonly SlotEntry[] = Object.freeze([]);

/** 把「带类型化 props 的贡献」擦成渲染闭包 —— 全仓唯一一处类型擦除，对外 API 仍全链类型安全 */
function erase<P extends object>(c: SlotContribution<P>, seq: number): SlotEntry {
  const Comp = c.component as unknown as ComponentType<Record<string, unknown>>;
  const props = (c.props ?? {}) as Record<string, unknown>;
  return {
    seat: c.seat,
    owner: c.owner,
    key: c.key ?? null,
    priority: c.priority ?? 0,
    order: c.order ?? 0,
    seq,
    render: (ownerProps) => createElement(Comp, ownerProps === undefined ? props : { ...props, ...ownerProps }),
  };
}

export class SlotRegistry {
  private readonly declarations = new Map<string, SeatDeclaration>();
  private readonly contributions: SlotEntry[] = [];
  private readonly cache = new Map<string, readonly SlotEntry[]>();
  private readonly listeners = new Set<() => void>();
  private seq = 0;

  constructor(declarations: readonly SeatDeclaration[] = []) {
    for (const d of declarations) this.declare(d);
  }

  /** 声明席位（重复 id 抛错；keyed 的保留 key 必须在 keys 内 —— 声明自洽性） */
  declare(seat: SeatDeclaration): void {
    if (this.declarations.has(seat.id)) {
      throw new SlotRegistryError(`席位重复声明: ${seat.id}`);
    }
    if (seat.kind !== 'single' && seat.kind !== 'keyed' && seat.kind !== 'list') {
      throw new SlotRegistryError(`未知席位类型: ${String(seat.kind)}`);
    }
    for (const reserved of seat.reservedKeys ?? []) {
      if (seat.keys !== undefined && !seat.keys.includes(reserved)) {
        throw new SlotRegistryError(`保留 key 未在 keys 内声明: ${seat.id}.${reserved}`);
      }
    }
    this.declarations.set(seat.id, seat);
  }

  seats(): readonly SeatDeclaration[] {
    return [...this.declarations.values()];
  }

  hasSeat(id: string): boolean {
    return this.declarations.has(id);
  }

  /** 某席位当前解析出的贡献（只读快照；无变化时返回同一引用，供 useSyncExternalStore 使用） */
  entries(seatId: string): readonly SlotEntry[] {
    const cached = this.cache.get(seatId);
    if (cached !== undefined) return cached;
    const computed = this.resolve(seatId);
    this.cache.set(seatId, computed);
    return computed;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 注入一份席位内容；返回幂等 disposer（重复调用只卸载一次）。
   * 语义：single 抢占（优先级 → 后注册）、keyed 拒重复 key、list 按 order 排序；
   * 保留 key 只接受**声明者 owner** 注入（types.ts 的 SeatDeclaration.owner 契约）。
   */
  inject<P extends object>(contribution: SlotContribution<P>): () => void {
    const seat = this.declarations.get(contribution.seat);
    if (seat === undefined) {
      throw new SlotRegistryError(`席位未声明: ${contribution.seat}（先 declare 再 inject）`);
    }
    if (seat.kind === 'keyed') {
      const key = contribution.key;
      if (key === undefined || key.length === 0) {
        throw new SlotRegistryError(`keyed 席位必须带 key: ${seat.id}`);
      }
      if (seat.keys !== undefined && !seat.keys.includes(key)) {
        throw new SlotRegistryError(`keyed 席位 ${seat.id} 不接受 key=${key}`);
      }
      if (seat.reservedKeys?.includes(key) === true && contribution.owner !== seat.owner) {
        throw new SlotRegistryError(
          `保留 key 只接受声明者注入: ${seat.id}.${key}（声明者 ${seat.owner}，注入方 ${contribution.owner}）`,
        );
      }
      if (this.findByKey(seat.id, key) !== undefined) {
        throw new SlotRegistryError(`keyed 席位重复 key: ${seat.id}.${key}`);
      }
    }
    const entry: SlotEntry = erase(contribution, this.seq++);
    this.contributions.push(entry);
    this.invalidate(seat.id);
    let disposed = false;
    return () => {
      if (disposed) return; // 幂等 disposer
      disposed = true;
      const idx = this.contributions.indexOf(entry);
      if (idx < 0) return;
      this.contributions.splice(idx, 1);
      this.invalidate(seat.id);
    };
  }

  /**
   * 清空某席位（或全部）已注入的贡献 —— 壳重挂载 / 测试重置用；声明保留。
   * 保留 key（如 main.conversation）的贡献不被清除：它是席位的默认占用者，只能被替换语义接管。
   */
  clear(seatId?: string): void {
    const reservedOf = (seat: string | undefined): readonly string[] =>
      seat !== undefined ? (this.declarations.get(seat)?.reservedKeys ?? []) : [];
    const isReserved = (c: SlotEntry): boolean => c.key !== null && reservedOf(c.seat).includes(c.key);
    if (seatId === undefined) {
      const touched = new Set(this.contributions.map((c) => c.seat));
      for (let i = this.contributions.length - 1; i >= 0; i--) {
        if (!isReserved(this.contributions[i]!)) this.contributions.splice(i, 1);
      }
      for (const id of touched) this.invalidate(id);
      return;
    }
    for (let i = this.contributions.length - 1; i >= 0; i--) {
      const c = this.contributions[i]!;
      if (c.seat === seatId && !isReserved(c)) this.contributions.splice(i, 1);
    }
    this.invalidate(seatId);
  }

  /** keyed 席位的合法 key 顺序（声明 keys，缺失则按注册序去重） */
  keys(seatId: string): readonly string[] {
    const seat = this.declarations.get(seatId);
    const declared = seat?.keys;
    if (declared !== undefined) return declared;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of this.contributions) {
      if (c.seat !== seatId || c.key === null || seen.has(c.key)) continue;
      seen.add(c.key);
      out.push(c.key);
    }
    return out;
  }

  private findByKey(seatId: string, key: string): SlotEntry | undefined {
    return this.contributions.find((c) => c.seat === seatId && c.key === key);
  }

  private resolve(seatId: string): readonly SlotEntry[] {
    const seat = this.declarations.get(seatId);
    if (seat === undefined) return EMPTY;
    const mine = this.contributions.filter((c) => c.seat === seatId);
    if (mine.length === 0) return EMPTY;
    switch (seat.kind as SeatKind) {
      case 'single': {
        // 抢占：优先级高者胜；同级后注册者胜（「可被品牌包接管」语义）
        let best = mine[0]!;
        for (const c of mine) {
          if (c.priority > best.priority || (c.priority === best.priority && c.seq > best.seq)) best = c;
        }
        return Object.freeze([best]);
      }
      case 'keyed':
        // 保注册顺序（注入顺序即渲染顺序）
        return Object.freeze([...mine]);
      case 'list':
        return Object.freeze([...mine].sort((a, b) => (a.order === b.order ? a.seq - b.seq : a.order - b.order)));
    }
  }

  /** 解析结果变化才通知（避免无意义重渲染；entries 引用稳定） */
  private invalidate(seatId: string): void {
    if (this.cache.delete(seatId)) this.emit();
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

/** 便捷工厂（便于测试与壳装配；等价于 new SlotRegistry(declarations)） */
export function createSlotRegistry(declarations: readonly SeatDeclaration[] = []): SlotRegistry {
  return new SlotRegistry(declarations);
}
