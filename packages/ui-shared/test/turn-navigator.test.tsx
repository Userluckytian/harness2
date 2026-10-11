// @vitest-environment jsdom
// 轮次导航（Z2-09b / Z-17 `ConversationTurnNavigator`）：归组、显示阈值（≥2 轮且 ≥864px）、
// 点击定位、当前轮高亮。864px 像素断点由 CSS @container 承担（desktop 样式断言钉规则），
// 这里钉阈值常量、纯函数与组件行为。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChatItem } from '../src/renderer/chat-model.js';
import {
  TURN_NAVIGATOR_MIN_CONTAINER_PX,
  TURN_NAVIGATOR_MIN_TURNS,
  activeTurnIdOf,
  deriveTurns,
  jumpToTurn,
  truncateTurnTitle,
  turnNavigatorVisible,
  TurnNavigator,
} from '../src/renderer/conversation/turn-navigator.js';

afterEach(cleanup);

const header = (turnId: string): ChatItem => ({ kind: 'turn-header', turnId });
const user = (turnId: string, seq: number, text: string): ChatItem => ({ kind: 'user', turnId, seq, text });

describe('deriveTurns（ChatItem 流 → 轮次条目）', () => {
  it('按 turn-header 归组，序号 1 起；标题取该轮第一条 user 文本', () => {
    const items: ChatItem[] = [
      header('t1'),
      user('t1', 1, '第一轮的问题。请详细回答'),
      { kind: 'assistant', turnId: 't1', seq: 2, text: '答' },
      header('t2'),
      user('t2', 3, '第二轮'),
    ];
    expect(deriveTurns(items)).toEqual([
      { turnId: 't1', index: 1, title: '第一轮的问题' },
      { turnId: 't2', index: 2, title: '第二轮' },
    ]);
  });

  it('无 user 文本的轮 → title 缺省（title 属性回落序号，不编造标题）', () => {
    expect(deriveTurns([header('t1'), { kind: 'assistant', turnId: 't1', seq: 1, text: '答' }])).toEqual([
      { turnId: 't1', index: 1 },
    ]);
  });

  it('marker / streaming / 重复 header 不产生额外轮次', () => {
    const items: ChatItem[] = [
      header('t1'),
      user('t1', 1, '问'),
      { kind: 'marker', variant: 'compact', seq: 2, summary: '压缩' },
      header('t1'), // 重复 header：不重复计轮
      { kind: 'streaming', text: '在途', streaming: true },
      { kind: 'marker', variant: 'checkpoint-restored', seq: 3, rewindToSeq: 0 },
    ];
    expect(deriveTurns(items)).toEqual([{ turnId: 't1', index: 1, title: '问' }]);
  });
});

describe('truncateTurnTitle / turnNavigatorVisible（阈值单一事实源）', () => {
  it('首句截断：句末标点处断；超长硬截加省略号', () => {
    expect(truncateTurnTitle('  帮我看看这个 bug。后面的都不算  ')).toBe('帮我看看这个 bug');
    expect(truncateTurnTitle('没有标点的长句')).toBe('没有标点的长句');
    expect(truncateTurnTitle('长'.repeat(60))).toBe(`${'长'.repeat(48)}…`);
  });

  it(`显示阈值 = 轮次 ≥${TURN_NAVIGATOR_MIN_TURNS} 且容器 ≥${TURN_NAVIGATOR_MIN_CONTAINER_PX}px（Z-17）`, () => {
    expect(turnNavigatorVisible(1, 2000)).toBe(false); // 轮次不足
    expect(turnNavigatorVisible(2, TURN_NAVIGATOR_MIN_CONTAINER_PX - 1)).toBe(false); // 宽度不足
    expect(turnNavigatorVisible(2, TURN_NAVIGATOR_MIN_CONTAINER_PX)).toBe(true); // 双条件同时满足
    expect(turnNavigatorVisible(5, 1400)).toBe(true);
  });
});

describe('TurnNavigator 组件', () => {
  const twoTurns = [
    { turnId: 't1', index: 1, title: '第一轮' },
    { turnId: 't2', index: 2, title: '第二轮' },
  ];

  it('轮次 <2 → 不渲染（JS 侧阈值；864px 断点交给 CSS）', () => {
    render(<TurnNavigator turns={[{ turnId: 't1', index: 1 }]} onJump={() => {}} />);
    expect(screen.queryByTestId('turn-rail')).toBeNull();
  });

  it('轮次 ≥2 → rail 渲染：每轮一枚按钮（序号 + 首句截断 title），当前轮 aria-current 高亮', () => {
    render(<TurnNavigator turns={twoTurns} activeTurnId="t2" onJump={() => {}} />);
    const rail = screen.getByTestId('turn-rail');
    expect(rail.getAttribute('aria-label')).toBe('轮次导航');
    const buttons = rail.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute('title')).toBe('第一轮');
    expect(buttons[1]?.getAttribute('aria-current')).toBe('true');
    expect(buttons[0]?.getAttribute('aria-current')).toBeNull();
  });

  it('点击 → onJump 带该轮 turnId（滚动定位由宿主接线）', () => {
    const jumped: string[] = [];
    render(<TurnNavigator turns={twoTurns} onJump={(id) => jumped.push(id)} />);
    fireEvent.click(screen.getByLabelText('第 2 轮'));
    expect(jumped).toEqual(['t2']);
  });
});

describe('jumpToTurn / activeTurnIdOf（DOM 定位与当前轮判定）', () => {
  it('jumpToTurn：命中轮首行 → 置 scrollTop（内缩线预留）并返回 true；未命中 → false', () => {
    const container = document.createElement('div');
    const first = document.createElement('div');
    first.setAttribute('data-turn-id', 't1');
    container.appendChild(first);
    document.body.appendChild(container);
    try {
      // jsdom 无布局（rects 全 0）：scrollTop = max(0, 0 - 内缩) = 0，但赋值路径与返回值可断言
      expect(jumpToTurn(container, 't1')).toBe(true);
      expect(container.scrollTop).toBe(0);
      expect(jumpToTurn(container, 'missing')).toBe(false);
      expect(jumpToTurn(null, 't1')).toBe(false);
    } finally {
      container.remove();
    }
  });

  it('activeTurnIdOf：取顶部越过内缩线的最后一个轮首行（jsdom rects=0 → 最后一轮）', () => {
    const container = document.createElement('div');
    for (const id of ['t1', 't2', 't3']) {
      const el = document.createElement('div');
      el.setAttribute('data-turn-id', id);
      container.appendChild(el);
    }
    document.body.appendChild(container);
    try {
      expect(activeTurnIdOf(container)).toBe('t3');
      expect(activeTurnIdOf(null)).toBeUndefined();
    } finally {
      container.remove();
    }
  });
});
