// 对话视图注册表测试（D-30）：`UiConversation.views` 等价物的注册语义。
// 覆盖：拒重复 key / 保注册顺序 / 幂等 disposer / 订阅通知 / 快照引用稳定 / 渲染闭包把上下文原样交给组件。
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import {
  ConversationViewRegistryError,
  createConversationViewRegistry,
} from '@harness2/ui-shared/renderer/conversation/views/index.js';
import type {
  ConversationViewDefinition,
  ConversationViewProps,
} from '@harness2/ui-shared/renderer/conversation/views/index.js';

function View(): null {
  return null;
}

function def(key: string, title = key.toUpperCase()): ConversationViewDefinition {
  return { key, title, owner: 'ui-test', component: View };
}

const CTX: ConversationViewProps = {
  sessionId: 's1',
  session: { id: 's1' },
  imageUrl: () => null,
};

describe('ConversationViewRegistry 注册语义（D-30）', () => {
  it('保注册顺序：keys() 按注册先后返回，与 key 字面序无关', () => {
    const registry = createConversationViewRegistry();
    registry.register(def('trajectory'));
    registry.register(def('chat'));
    registry.register(def('alpha'));
    expect(registry.keys()).toEqual(['trajectory', 'chat', 'alpha']);
    expect(registry.views().map((entry) => entry.seq)).toEqual([0, 1, 2]);
    expect(registry.has('chat')).toBe(true);
    expect(registry.has('nope')).toBe(false);
    expect(registry.get('alpha')?.owner).toBe('ui-test');
  });

  it('拒重复 key / 空 key', () => {
    const registry = createConversationViewRegistry();
    registry.register(def('chat'));
    expect(() => registry.register(def('chat'))).toThrow(ConversationViewRegistryError);
    expect(() => registry.register(def(''))).toThrow(ConversationViewRegistryError);
    // 失败的注册不得污染注册表（仍只有 chat）
    expect(registry.keys()).toEqual(['chat']);
  });

  it('disposer 幂等：重复调用只卸载一次，且不误伤同键重注册', () => {
    const registry = createConversationViewRegistry();
    const dispose = registry.register(def('chat'));
    registry.register(def('trajectory'));
    dispose();
    dispose();
    expect(registry.keys()).toEqual(['trajectory']);
    // 卸载后可重新注册同名 key（无残留）
    const disposeAgain = registry.register(def('chat'));
    expect(registry.keys()).toEqual(['trajectory', 'chat']);
    disposeAgain();
    expect(registry.keys()).toEqual(['trajectory']);
  });

  it('订阅：集合变化才通知；无变化时 views() 返回同一引用（供 useSyncExternalStore）', () => {
    const registry = createConversationViewRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    const emptySnapshot = registry.views();
    expect(registry.views()).toBe(emptySnapshot);

    const dispose = registry.register(def('chat'));
    expect(listener).toHaveBeenCalledTimes(1);
    const withChat = registry.views();
    expect(withChat).not.toBe(emptySnapshot);
    expect(registry.views()).toBe(withChat); // 引用稳定
    expect(withChat.map((entry) => entry.key)).toEqual(['chat']);

    dispose();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.views()).toEqual([]);

    unsubscribe();
    registry.register(def('trajectory'));
    expect(listener).toHaveBeenCalledTimes(2); // 退订后不再收到
  });

  it('render 闭包把视图上下文原样交给组件，并带上 key/title/owner 元数据', () => {
    const registry = createConversationViewRegistry();
    registry.register(def('chat', '对话'));
    const entry = registry.get('chat')!;
    const element = entry.render(CTX) as ReactElement<ConversationViewProps>;
    expect(element.type).toBe(View);
    expect(element.props.sessionId).toBe('s1');
    expect(element.props.session).toBe(CTX.session);
    expect(element.props.imageUrl).toBe(CTX.imageUrl);
    expect(entry.title).toBe('对话');
    expect(entry.owner).toBe('ui-test');
  });

  it('clear() 清空全部；clear 之后再调旧 disposer 也安全（幂等）', () => {
    const registry = createConversationViewRegistry();
    const dispose = registry.register(def('chat'));
    registry.register(def('trajectory'));
    registry.clear();
    expect(registry.keys()).toEqual([]);
    expect(() => dispose()).not.toThrow();
    expect(registry.keys()).toEqual([]);
    registry.register(def('chat'));
    expect(registry.keys()).toEqual(['chat']);
  });
});
