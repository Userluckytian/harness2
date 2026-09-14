// D-38 composer 链测试：priority 升序 → 注册顺序、首个非 null 获选、无接管 = null。
import { describe, expect, it, vi } from 'vitest';
import {
  ComposerChain,
  COMPOSER_CHAIN_NAME,
  renderComposerTakeover,
  selectComposerTakeover,
  sortComposerChain,
  type ComposerChainEntry,
  type ComposerChainProps,
} from '@harness2/ui-shared/renderer/conversation/composer/composer-chain.js';

const owner = (patch: Partial<ComposerChainProps> = {}): ComposerChainProps => ({
  sessionId: 's1',
  session: { id: 's1', running: false },
  pendingInteraction: undefined,
  ...patch,
});

function entry(selectResult: string | null, seq: number, priority: number, ownerName: string): ComposerChainEntry {
  return {
    owner: ownerName,
    priority,
    seq,
    select: () => selectResult,
    component: () => null,
  };
}

describe('D-38 ChainSelect 选举（纯函数）', () => {
  it('priority 升序 → 同 priority 保注册顺序', () => {
    const sorted = sortComposerChain([entry('a', 0, 5, 'A'), entry('b', 1, 1, 'B'), entry('c', 2, 1, 'C')]);
    expect(sorted.map((e) => e.owner)).toEqual(['B', 'C', 'A']);
  });

  it('首个返回非 null 的 selector 获选；matched 原样带出', () => {
    const takeover = selectComposerTakeover([entry(null, 0, 0, 'null-first'), entry('match', 1, 0, 'second')], owner());
    expect(takeover?.entry.owner).toBe('second');
    expect(takeover?.matched).toBe('match');
  });

  it('无人接管 = null（不是「第一个注册的」）', () => {
    expect(selectComposerTakeover([entry(null, 0, 0, 'A'), entry(null, 1, 0, 'B')], owner())).toBeNull();
    expect(selectComposerTakeover([], owner())).toBeNull();
  });

  it('selector 收到完整 owner currency（sessionId / session / pendingInteraction）', () => {
    const select = vi.fn(() => null);
    const interaction = { id: 'i1', kind: 'question' };
    selectComposerTakeover(
      [{ owner: 'x', priority: 0, seq: 0, select, component: () => null }],
      owner({ pendingInteraction: interaction }),
    );
    expect(select).toHaveBeenCalledWith({
      sessionId: 's1',
      session: { id: 's1', running: false },
      pendingInteraction: interaction,
    });
  });
});

describe('D-38 ComposerChain 注册表', () => {
  it('链名与上游一致', () => {
    expect(COMPOSER_CHAIN_NAME).toBe('conversation.composer');
  });

  it('注册 / 选举 / 幂等 disposer / clear', () => {
    const chain = new ComposerChain();
    const disposeLow = chain.register({
      owner: 'low',
      priority: 0,
      select: () => ({ tag: 'low' }),
      component: () => null,
    });
    chain.register({ owner: 'high', priority: 10, select: () => ({ tag: 'high' }), component: () => null });
    chain.register({ owner: 'null', priority: -1, select: () => null, component: () => null });

    expect(chain.entries().map((e) => e.owner)).toEqual(['null', 'low', 'high']);
    const takeover = chain.select(owner());
    expect(takeover?.entry.owner).toBe('low');
    expect(takeover?.matched).toEqual({ tag: 'low' });

    disposeLow();
    disposeLow(); // 幂等
    expect(chain.entries().map((e) => e.owner)).toEqual(['null', 'high']);
    expect(chain.select(owner())?.entry.owner).toBe('high');

    chain.clear();
    expect(chain.entries()).toHaveLength(0);
    expect(chain.select(owner())).toBeNull();
  });

  it('select 委派给纯函数（同输入恒同输出），subscribe 在注册变化时通知', () => {
    const chain = new ComposerChain();
    const listener = vi.fn();
    const unsubscribe = chain.subscribe(listener);
    const dispose = chain.register({ owner: 'a', select: () => ({ a: 1 }), component: () => null });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(chain.select(owner())?.matched).toEqual({ a: 1 });
    dispose();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    chain.register({ owner: 'b', select: () => null, component: () => null });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('renderComposerTakeover 把 matched 与标准 props 合并交给组件', () => {
    const ChainComp = () => null;
    const chain = new ComposerChain();
    chain.register({ owner: 'a', select: () => ({ marker: true }), component: ChainComp });
    const takeover = chain.select(owner());
    expect(takeover).not.toBeNull();
    const element = renderComposerTakeover(takeover!, owner());
    expect(element).toMatchObject({ props: { matched: { marker: true }, sessionId: 's1' } });
  });
});
