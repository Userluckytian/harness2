// @vitest-environment jsdom
// 视图环测试（D-32 + D-31 选择规则接线 + D-39 图片解析器注入）。
// 重点证明「切换不重建会话」：
//   a) session.subscribe 只调用一次、切换后从不退订；
//   b) 视图上下文里的 session / imageUrl 在切换前后引用相等；
//   c) 会话作用域容器 `view-ring-session` 的 DOM 节点引用不变。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import {
  createConversationViewRegistry,
  ConversationViewRing,
} from '../../../src/renderer/conversation/views/index.js';
import type {
  ConversationImageAttachment,
  ConversationViewProps,
  ViewSelectionPersistence,
} from '../../../src/renderer/conversation/views/index.js';

interface TestSession {
  readonly id: string;
  read(): number;
  subscribe?(listener: () => void): () => void;
}

interface ObservedContext {
  sessionId: string;
  session: TestSession;
  imageUrl: (attachment: ConversationImageAttachment) => string | null;
}

let observed: ObservedContext[] = [];
const lastContext = (): ObservedContext => {
  const value = observed.at(-1);
  if (value === undefined) throw new Error('视图尚未渲染');
  return value;
};

/** 记录每次渲染收到的上下文（用于证明会话对象/解析器引用稳定性） */
function viewComponent(label: string): ComponentType<ConversationViewProps<TestSession>> {
  return function View(context: ConversationViewProps<TestSession>) {
    observed.push({ sessionId: context.sessionId, session: context.session, imageUrl: context.imageUrl });
    return <span data-probe={label}>{`${label}-view`}</span>;
  };
}

/** 会话夹具：带可观测的订阅/退订（证明切换不重建会话的 a 条） */
function sessionFixture(id: string): {
  session: TestSession;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  emit: () => void;
} {
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn((listener: () => void) => {
    listeners.delete(listener);
  });
  const subscribe = vi.fn((listener: () => void) => {
    listeners.add(listener);
    return () => unsubscribe(listener);
  });
  return {
    session: { id, read: () => 0, subscribe },
    subscribe,
    unsubscribe,
    emit: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

/** 持久选择注入缝夹具（内存实现，不碰 localStorage） */
function persistenceFixture(initial: Record<string, string> = {}): {
  persistence: ViewSelectionPersistence;
  writes: Array<[string, string | null]>;
  reads: string[];
} {
  const map = new Map(Object.entries(initial));
  const writes: Array<[string, string | null]> = [];
  const reads: string[] = [];
  return {
    writes,
    reads,
    persistence: {
      read: (sessionId) => {
        reads.push(sessionId);
        return map.get(sessionId) ?? null;
      },
      write: (sessionId, key) => {
        writes.push([sessionId, key]);
        if (key === null) map.delete(sessionId);
        else map.set(sessionId, key);
      },
    },
  };
}

function registryWithChatAndTrajectory() {
  const registry = createConversationViewRegistry<TestSession>();
  registry.register({
    key: 'chat',
    title: 'Chat',
    owner: 'ui-chat',
    component: viewComponent('chat'),
  });
  registry.register({
    key: 'trajectory',
    title: 'Trajectory',
    owner: 'ui-trajectory',
    component: viewComponent('trajectory'),
  });
  return registry;
}

beforeEach(() => {
  observed = [];
});
afterEach(cleanup);

describe('视图环标签与选择（D-32 / D-31）', () => {
  it('标签按注册顺序渲染；有效持久选择命中该视图', () => {
    const registry = registryWithChatAndTrajectory();
    const { session } = sessionFixture('s1');
    const { persistence } = persistenceFixture({ s1: 'trajectory' });
    render(
      <ConversationViewRing
        registry={registry}
        sessionId="s1"
        session={session}
        persistence={persistence}
        onSelectView={() => {}}
      />,
    );
    expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('data-view-key'))).toEqual(['chat', 'trajectory']);
    expect(screen.getByRole('tab', { name: 'Trajectory' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Trajectory' }).getAttribute('data-view-owner')).toBe('ui-trajectory');
    expect(screen.getByText('trajectory-view')).toBeTruthy();
    expect(screen.queryByText('chat-view')).toBeNull();
  });

  it('无有效持久选择 → 回落已注册 chat；持久值未注册也回落 chat', () => {
    const registry = registryWithChatAndTrajectory();
    for (const persisted of [null, 'ghost']) {
      const { session } = sessionFixture('s1');
      const { persistence } = persistenceFixture(persisted === null ? {} : { s1: persisted });
      const view = render(
        <ConversationViewRing registry={registry} sessionId="s1" session={session} persistence={persistence} />,
      );
      expect(screen.getByText('chat-view')).toBeTruthy();
      expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
      view.unmount();
    }
  });

  it('没有 chat、也没有持久选择 → 不渲染任何视图（绝不取第一个注册的）', () => {
    const registry = createConversationViewRegistry<TestSession>();
    registry.register({ key: 'alpha', title: 'Alpha', owner: 'ui-a', component: viewComponent('alpha') });
    registry.register({ key: 'beta', title: 'Beta', owner: 'ui-b', component: viewComponent('beta') });
    const { session } = sessionFixture('s1');
    const { persistence } = persistenceFixture();
    render(<ConversationViewRing registry={registry} sessionId="s1" session={session} persistence={persistence} />);
    expect(screen.getByTestId('view-ring-empty')).toBeTruthy();
    expect(screen.queryByText('alpha-view')).toBeNull();
    expect(screen.queryByText('beta-view')).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('点击标签：写持久缝 + 切换通知 + 内容切换', () => {
    const registry = registryWithChatAndTrajectory();
    const { session } = sessionFixture('s1');
    const { persistence, writes } = persistenceFixture();
    const onSelectView = vi.fn();
    render(
      <ConversationViewRing
        registry={registry}
        sessionId="s1"
        session={session}
        persistence={persistence}
        onSelectView={onSelectView}
      />,
    );
    expect(screen.getByText('chat-view')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }));
    expect(writes).toEqual([['s1', 'trajectory']]);
    expect(onSelectView).toHaveBeenCalledTimes(1);
    expect(onSelectView).toHaveBeenCalledWith('trajectory');
    expect(screen.getByText('trajectory-view')).toBeTruthy();
    expect(screen.queryByText('chat-view')).toBeNull();
  });

  it('注册表变化即时反映：运行中注册出现新标签，卸载后标签消失', () => {
    const registry = registryWithChatAndTrajectory();
    const { session } = sessionFixture('s1');
    const { persistence } = persistenceFixture();
    render(<ConversationViewRing registry={registry} sessionId="s1" session={session} persistence={persistence} />);
    let dispose: () => void = () => {};
    act(() => {
      dispose = registry.register({
        key: 'trace',
        title: 'Trace',
        owner: 'ui-trace',
        component: viewComponent('trace'),
      });
    });
    expect(screen.getByRole('tab', { name: 'Trace' })).toBeTruthy();
    act(() => {
      dispose();
    });
    expect(screen.queryByRole('tab', { name: 'Trace' })).toBeNull();
  });
});

describe('切换不重建会话（D-32）', () => {
  it('切换视图：会话订阅不重建、会话对象与图片解析器引用不变、会话容器 DOM 不变', () => {
    const registry = registryWithChatAndTrajectory();
    const fixture = sessionFixture('s1');
    const { persistence } = persistenceFixture();
    render(
      <ConversationViewRing
        registry={registry}
        sessionId="s1"
        session={fixture.session}
        persistence={persistence}
        onSelectView={() => {}}
      />,
    );
    const sessionBefore = lastContext().session;
    const imageUrlBefore = lastContext().imageUrl;
    const scopeBefore = screen.getByTestId('view-ring-session');

    fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }));
    expect(lastContext().session).toBe(sessionBefore);
    expect(lastContext().imageUrl).toBe(imageUrlBefore);
    expect(lastContext().sessionId).toBe('s1');
    expect(screen.getByTestId('view-ring-session')).toBe(scopeBefore);

    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(lastContext().session).toBe(sessionBefore);
    expect(lastContext().imageUrl).toBe(imageUrlBefore);
    expect(scopeBefore.isConnected).toBe(true);

    expect(fixture.subscribe).toHaveBeenCalledTimes(1);
    expect(fixture.unsubscribe).not.toHaveBeenCalled();
  });

  it('会话对象推送数据只触发重渲染，不退订：发一次事件后仍只订阅一次', () => {
    const registry = registryWithChatAndTrajectory();
    const fixture = sessionFixture('s1');
    const { persistence } = persistenceFixture();
    render(
      <ConversationViewRing registry={registry} sessionId="s1" session={fixture.session} persistence={persistence} />,
    );
    act(() => {
      fixture.emit();
    });
    expect(fixture.subscribe).toHaveBeenCalledTimes(1);
    expect(fixture.unsubscribe).not.toHaveBeenCalled();
    expect(screen.getByText('chat-view')).toBeTruthy();
  });

  it('换会话才重读持久选择并重订阅（旧会话退订一次）', () => {
    const registry = registryWithChatAndTrajectory();
    const first = sessionFixture('s1');
    const second = sessionFixture('s2');
    const { persistence, reads } = persistenceFixture({ s1: 'trajectory', s2: 'chat' });
    const view = render(
      <ConversationViewRing registry={registry} sessionId="s1" session={first.session} persistence={persistence} />,
    );
    expect(screen.getByText('trajectory-view')).toBeTruthy();

    view.rerender(
      <ConversationViewRing registry={registry} sessionId="s2" session={second.session} persistence={persistence} />,
    );
    expect(reads).toEqual(['s1', 's2']);
    expect(screen.getByText('chat-view')).toBeTruthy();
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    expect(second.subscribe).toHaveBeenCalledTimes(1);
    expect(screen.getByText('chat-view').closest('.view-ring')?.getAttribute('data-session-id')).toBe('s2');
  });

  it('会话对象没有 subscribe 也能渲染（订阅是可选缝）', () => {
    const registry = registryWithChatAndTrajectory();
    const { persistence } = persistenceFixture();
    const bare: TestSession = { id: 's1', read: () => 0 };
    render(<ConversationViewRing registry={registry} sessionId="s1" session={bare} persistence={persistence} />);
    expect(screen.getByText('chat-view')).toBeTruthy();
  });
});

describe('会话内图片 URL 解析器注入（D-39 接线缝）', () => {
  it('视图拿到的是绑定了 sessionId 的一次授权入口（Chat / Trajectory 共用同一引用）', () => {
    const registry = registryWithChatAndTrajectory();
    const { session } = sessionFixture('s1');
    const { persistence } = persistenceFixture();
    const cached = 'data:image/png;base64,AAAA';
    const imageUrl = vi.fn((_sessionId: string, _attachment: ConversationImageAttachment) => cached);
    render(
      <ConversationViewRing
        registry={registry}
        sessionId="s1"
        session={session}
        persistence={persistence}
        imageUrl={imageUrl}
      />,
    );
    const attachment: ConversationImageAttachment = { id: 'a1', mimeType: 'image/png' };
    const resolverBefore = lastContext().imageUrl;
    expect(lastContext().imageUrl(attachment)).toBe(cached);
    expect(imageUrl).toHaveBeenCalledWith('s1', attachment);
    expect(imageUrl).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }));
    // 切换后 Trajectory 拿到同一解析器引用（同一缓存入口，不重复授权）
    expect(lastContext().imageUrl).toBe(resolverBefore);
    expect(lastContext().imageUrl(attachment)).toBe(cached);
    expect(imageUrl).toHaveBeenCalledTimes(2);
  });

  it('未注入解析器时视图拿到的解析器恒为 null（不伪造 URL）', () => {
    const registry = registryWithChatAndTrajectory();
    const { session } = sessionFixture('s1');
    const { persistence } = persistenceFixture();
    render(<ConversationViewRing registry={registry} sessionId="s1" session={session} persistence={persistence} />);
    expect(lastContext().imageUrl({ id: 'a1' })).toBeNull();
  });
});
