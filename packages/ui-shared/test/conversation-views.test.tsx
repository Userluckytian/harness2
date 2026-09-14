// 视图环与视图选择（D-30/D-31/D-32）+ 选择持久缝（Persistence 端口）：
//   * 选择规则是纯函数：有效持久选择 > 已注册 chat > 不渲染（**绝不**取第一个注册的）；
//   * 持久缝由壳注入：本测试同时验证「环外改写会即时切视图」（Persistence.subscribe）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, act } from '@testing-library/react';
import { createInMemoryPersistence } from '../src/renderer/ports.js';
import { createConversationViewRegistry } from '../src/renderer/conversation/views/view-registry.js';
import { CHAT_VIEW_KEY, selectConversationView } from '../src/renderer/conversation/views/view-selection.js';
import { ConversationViewRing } from '../src/renderer/conversation/views/view-ring.js';
import {
  CHAT_VIEW_KEY as CHAT_KEY_FROM_KEYS,
  TRAJECTORY_VIEW_KEY,
} from '../src/renderer/conversation/views/view-keys.js';

afterEach(() => cleanup());

describe('视图选择规则（D-31）', () => {
  it('有效持久选择优先于 chat（请求轨迹就保持轨迹）', () => {
    expect(
      selectConversationView({
        registeredKeys: [CHAT_VIEW_KEY, TRAJECTORY_VIEW_KEY],
        persisted: TRAJECTORY_VIEW_KEY,
        session: { active: true },
      }),
    ).toBe(TRAJECTORY_VIEW_KEY);
  });

  it('持久值失效（未注册）→ 回落 chat', () => {
    expect(
      selectConversationView({ registeredKeys: [CHAT_VIEW_KEY], persisted: 'ghost', session: { active: true } }),
    ).toBe(CHAT_VIEW_KEY);
  });

  it('只注册了别的视图（没有 chat）→ 不渲染，绝不取第一个注册的', () => {
    expect(
      selectConversationView({ registeredKeys: ['trajectory'], persisted: null, session: { active: true } }),
    ).toBeNull();
  });

  it('没有活跃会话 → 不渲染（不存在幽灵视图）', () => {
    expect(
      selectConversationView({ registeredKeys: [CHAT_VIEW_KEY], persisted: CHAT_VIEW_KEY, session: { active: false } }),
    ).toBeNull();
  });

  it('视图 key 的字面量唯一来源：view-keys 与 view-selection 同值', () => {
    expect(CHAT_VIEW_KEY).toBe(CHAT_KEY_FROM_KEYS);
    expect(TRAJECTORY_VIEW_KEY).toBe('trajectory');
  });
});

describe('视图环（D-32）：切换不重建会话 + 注入持久缝', () => {
  const session = { id: 's1' };

  it('按持久缝渲染对应视图；环外改写经订阅即时切换', async () => {
    const registry = createConversationViewRegistry<typeof session>();
    registry.register({
      key: 'chat',
      title: 'Chat',
      owner: 'ui-chat',
      component: () => createElement('p', null, 'chat-view'),
    });
    registry.register({
      key: 'trajectory',
      title: 'Trajectory',
      owner: 'ui-trajectory',
      component: () => createElement('p', null, 'trajectory-view'),
    });
    const persistence = createInMemoryPersistence();
    render(
      createElement(ConversationViewRing<typeof session>, {
        registry,
        sessionId: 's1',
        session,
        persistence,
      }),
    );
    expect(screen.getByText('chat-view')).toBeTruthy();

    // 环外改写（等价于 D-86 ② 工具卡 inspect → 切轨迹）：持久缝订阅生效
    await act(async () => {
      persistence.write('s1', 'trajectory');
    });
    expect(screen.getByText('trajectory-view')).toBeTruthy();
  });

  it('会话对象引用稳定：切换视图不重新订阅会话（D-32）', async () => {
    const registry = createConversationViewRegistry<typeof session>();
    registry.register({ key: 'chat', title: 'Chat', owner: 'ui-chat', component: () => null });
    registry.register({ key: 'trajectory', title: 'Trajectory', owner: 'ui-trajectory', component: () => null });
    let subscriptions = 0;
    const bound = {
      id: 's1',
      subscribe: () => {
        subscriptions += 1;
        return () => undefined;
      },
    };
    // 该用例的会话对象带 subscribe → 注册表按同一泛型重建（组件类型需与会话类型一致）
    const boundRegistry = createConversationViewRegistry<typeof bound>();
    boundRegistry.register({ key: 'chat', title: 'Chat', owner: 'ui-chat', component: () => null });
    boundRegistry.register({ key: 'trajectory', title: 'Trajectory', owner: 'ui-trajectory', component: () => null });
    const persistence = createInMemoryPersistence();
    render(
      createElement(ConversationViewRing<typeof bound>, {
        registry: boundRegistry,
        sessionId: 's1',
        session: bound,
        persistence,
      }),
    );
    await act(async () => {
      persistence.write('s1', 'trajectory');
    });
    expect(subscriptions).toBe(1);
  });

  it('没有可渲染视图时给兜底内容（不是空白）', () => {
    const registry = createConversationViewRegistry<typeof session>();
    render(
      createElement(ConversationViewRing<typeof session>, {
        registry,
        sessionId: 's1',
        session,
        persistence: createInMemoryPersistence(),
        emptyFallback: createElement('p', null, 'no-view'),
      }),
    );
    expect(screen.getByText('no-view')).toBeTruthy();
  });
});
