// 视图选择规则测试（D-31）：有效持久选择 > 已注册 chat > 不渲染；**绝不选「第一个注册的」**。
// 纯函数，无 React 依赖（node 环境）。
import { describe, expect, it } from 'vitest';
import { CHAT_VIEW_KEY, selectConversationView } from '../../../src/renderer/conversation/views/index.js';

const ACTIVE = { active: true } as const;
const INACTIVE = { active: false } as const;

describe('selectConversationView（D-31）', () => {
  it('分支 1：有效持久选择优先（即使不是 chat、也不是第一个注册的）', () => {
    expect(
      selectConversationView({
        registeredKeys: ['chat', 'trajectory'],
        persisted: 'trajectory',
        session: ACTIVE,
      }),
    ).toBe('trajectory');
    // 持久选择的视图排在最后也要选中（证明不是「按顺序取第一个有效项」）
    expect(
      selectConversationView({
        registeredKeys: ['alpha', 'beta', 'chat', 'trajectory'],
        persisted: 'trajectory',
        session: ACTIVE,
      }),
    ).toBe('trajectory');
  });

  it('分支 2：持久选择无效（未注册 / 空白）→ 回落到已注册的 chat（不是第一个注册的）', () => {
    expect(
      selectConversationView({ registeredKeys: ['trajectory', 'chat'], persisted: 'ghost', session: ACTIVE }),
    ).toBe(CHAT_VIEW_KEY);
    expect(selectConversationView({ registeredKeys: ['trajectory', 'chat'], persisted: '', session: ACTIVE })).toBe(
      CHAT_VIEW_KEY,
    );
    expect(selectConversationView({ registeredKeys: ['trajectory', 'chat'], persisted: '   ', session: ACTIVE })).toBe(
      CHAT_VIEW_KEY,
    );
    expect(selectConversationView({ registeredKeys: ['trajectory', 'chat'], persisted: null, session: ACTIVE })).toBe(
      CHAT_VIEW_KEY,
    );
  });

  it('分支 3：既无有效持久选择、又没注册 chat → null（不渲染）', () => {
    expect(selectConversationView({ registeredKeys: ['alpha', 'beta'], persisted: null, session: ACTIVE })).toBeNull();
    expect(selectConversationView({ registeredKeys: [], persisted: 'chat', session: ACTIVE })).toBeNull();
  });

  it('负向断言：无 chat 且无持久选择时**绝不**返回首个注册项', () => {
    const first = 'trajectory';
    const result = selectConversationView({ registeredKeys: [first, 'alpha'], persisted: null, session: ACTIVE });
    expect(result).not.toBe(first);
    expect(result).not.toBe('alpha');
    expect(result).toBeNull();
  });

  it('无会话（session.active=false）→ 不渲染，且不看持久选择', () => {
    expect(
      selectConversationView({ registeredKeys: ['chat', 'trajectory'], persisted: 'trajectory', session: INACTIVE }),
    ).toBeNull();
    expect(selectConversationView({ registeredKeys: ['chat'], persisted: null, session: INACTIVE })).toBeNull();
  });

  it('纯函数：同入参同出参、不改输入', () => {
    const registeredKeys = ['trajectory', 'chat'] as const;
    const input = { registeredKeys, persisted: 'trajectory', session: ACTIVE };
    const before = [...registeredKeys];
    expect(selectConversationView(input)).toBe(selectConversationView(input));
    expect([...registeredKeys]).toEqual(before);
  });
});
