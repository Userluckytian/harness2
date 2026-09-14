// slot 注册表测试（D-01～D-03）：声明式席位（single / keyed / list）的注册、注入与解析语义。
// 覆盖：未声明席位拒绝、重复声明拒绝、keyed 缺 key/重复 key/非法 key 拒绝、保留 key 不可被 clear 卸载、
//       single 抢占（优先级 → 后注册）、list 按 order 排序、幂等 disposer、快照引用稳定。
import { describe, expect, it, vi } from 'vitest';
import { createSlotRegistry, SlotRegistryError } from '../../src/renderer/slots/index.js';

function Comp(): null {
  return null;
}

const DECLARED = [
  { id: 'one', kind: 'single', owner: 'shell/layout' },
  // owner = 保留 key（conversation）的属主包：保留 key 只接受声明者注入（types.ts 契约）
  {
    id: 'kbd',
    kind: 'keyed',
    owner: 'ui-conversation',
    keys: ['a', 'b', 'conversation'],
    reservedKeys: ['conversation'],
  },
  { id: 'many', kind: 'list', owner: 'shell/layout' },
] as const;

function newRegistry() {
  const registry = createSlotRegistry();
  for (const d of DECLARED) registry.declare(d);
  return registry;
}

describe('SlotRegistry 声明（D-01）', () => {
  it('声明三类席位后可查；重复声明 / 未知类型 / 保留 key 越界均抛错', () => {
    const registry = newRegistry();
    expect(registry.seats().map((s) => s.id)).toEqual(['one', 'kbd', 'many']);
    expect(registry.hasSeat('kbd')).toBe(true);
    expect(registry.hasSeat('nope')).toBe(false);
    expect(() => registry.declare({ id: 'one', kind: 'single', owner: 'x' })).toThrow(SlotRegistryError);
    expect(() => registry.declare({ id: 'bad', kind: 'nope' as unknown as 'single', owner: 'x' })).toThrow(
      SlotRegistryError,
    );
    // 保留 key 必须落在 keys 内（声明自洽性）
    expect(() => registry.declare({ id: 'bad2', kind: 'keyed', owner: 'x', keys: ['p'], reservedKeys: ['q'] })).toThrow(
      SlotRegistryError,
    );
  });

  it('注入未声明席位抛错（先声明再注入）', () => {
    const registry = newRegistry();
    expect(() => registry.inject({ seat: 'ghost', owner: 'ui-x', component: Comp })).toThrow(SlotRegistryError);
  });
});

describe('single / keyed / list 解析语义（D-01）', () => {
  it('single：优先级高者胜，同级后注册者胜（可被接管）；disposer 幂等', () => {
    const registry = newRegistry();
    const disposeLow = registry.inject({ seat: 'one', owner: 'ui-a', component: Comp, priority: 1 });
    registry.inject({ seat: 'one', owner: 'ui-b', component: Comp, priority: 2 });
    expect(registry.entries('one')).toHaveLength(1);
    expect(registry.entries('one')[0]!.owner).toBe('ui-b');

    const disposeTakeover = registry.inject({ seat: 'one', owner: 'ui-brand', component: Comp, priority: 2 });
    expect(registry.entries('one')[0]!.owner).toBe('ui-brand'); // 同级后注册者接管

    disposeTakeover();
    disposeTakeover(); // 幂等：第二次调用不再改变结果
    expect(registry.entries('one')[0]!.owner).toBe('ui-b');

    disposeLow();
    expect(registry.entries('one')).toHaveLength(1); // ui-b（优先级 2）仍在
    expect(registry.entries('one')[0]!.owner).toBe('ui-b');
  });

  it('keyed：缺 key / 非法 key / 重复 key 均抛错；保注册顺序（不按字典序）', () => {
    const registry = newRegistry();
    expect(() => registry.inject({ seat: 'kbd', owner: 'ui-x', component: Comp })).toThrow(SlotRegistryError);
    expect(() => registry.inject({ seat: 'kbd', owner: 'ui-x', key: 'zzz', component: Comp })).toThrow(
      SlotRegistryError,
    );
    registry.inject({ seat: 'kbd', owner: 'ui-x', key: 'b', component: Comp });
    registry.inject({ seat: 'kbd', owner: 'ui-y', key: 'a', component: Comp });
    expect(() => registry.inject({ seat: 'kbd', owner: 'ui-z', key: 'b', component: Comp })).toThrow(SlotRegistryError);
    expect(registry.entries('kbd').map((e) => e.key)).toEqual(['b', 'a']);
  });

  it('保留 key：只接受声明者 owner 注入（其余包抛错）、任何包都不许重复注入，且 clear 不卸载它', () => {
    const registry = newRegistry();
    // 非声明者注入保留 key：抛错（types.ts「保留 key 只能由声明者注入」的强制校验）
    expect(() => registry.inject({ seat: 'kbd', owner: 'ui-other', key: 'conversation', component: Comp })).toThrow(
      SlotRegistryError,
    );
    expect(() => registry.inject({ seat: 'kbd', owner: 'ui-other', key: 'conversation', component: Comp })).toThrow(
      /保留 key 只接受声明者注入/,
    );
    // 非保留 key 不受 owner 限制（任何包都能填）
    registry.inject({ seat: 'kbd', owner: 'ui-panel', key: 'a', component: Comp });
    // 声明者注入保留 key：通过
    registry.inject({ seat: 'kbd', owner: 'ui-conversation', key: 'conversation', component: Comp });
    expect(() =>
      registry.inject({ seat: 'kbd', owner: 'ui-conversation', key: 'conversation', component: Comp }),
    ).toThrow(SlotRegistryError);
    registry.clear('kbd');
    // 保留 key（会话界面）不被清掉，其余贡献被清掉 —— 「拆掉旧结构」时不会把会话页一起清没
    expect(registry.entries('kbd').map((e) => e.key)).toEqual(['conversation']);
  });

  it('list：按 order 升序，同 order 保注册顺序；无声明席位返回空快照', () => {
    const registry = newRegistry();
    registry.inject({ seat: 'many', owner: 'ui-c', component: Comp, order: 2 });
    registry.inject({ seat: 'many', owner: 'ui-a', component: Comp, order: 0 });
    registry.inject({ seat: 'many', owner: 'ui-b', component: Comp, order: 0 });
    expect(registry.entries('many').map((e) => e.owner)).toEqual(['ui-a', 'ui-b', 'ui-c']);
    expect(registry.entries('ghost-seat')).toHaveLength(0);
  });
});

describe('订阅与快照（React 绑定前提）', () => {
  it('解析结果变化才通知；entries 引用稳定（无变化时同一引用）', () => {
    const registry = newRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);

    const before = registry.entries('one');
    expect(registry.entries('one')).toBe(before); // 缓存：同引用

    registry.inject({ seat: 'one', owner: 'ui-a', component: Comp });
    expect(listener).toHaveBeenCalledTimes(1);
    const after = registry.entries('one');
    expect(after).not.toBe(before);
    expect(registry.entries('one')).toBe(after);

    // 注入到别的席位不影响本席位快照
    registry.entries('many');
    const manySnapshot = registry.entries('many');
    registry.inject({ seat: 'one', owner: 'ui-b', component: Comp, priority: 5 });
    expect(registry.entries('many')).toBe(manySnapshot);
    expect(registry.entries('one')[0]!.owner).toBe('ui-b');
  });

  it('keys()：声明了 keys 就按声明给（含尚未注入的保留 key）', () => {
    const registry = newRegistry();
    expect(registry.keys('kbd')).toEqual(['a', 'b', 'conversation']);
    expect(registry.keys('one')).toEqual([]);
  });
});
