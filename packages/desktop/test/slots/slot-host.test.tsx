// @vitest-environment jsdom
// slot ↔ React 绑定测试（D-01）：注册表数据 → React 树的渲染语义。
// 覆盖：single 渲染唯一贡献、keyed 只渲染激活 key（缺 key 不取「第一个」）、list 按 order 渲染、
//       运行中注入/卸载即时反映、disposer 后节点消失。
import { describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type React from 'react';
import { createSlotRegistry, SlotHost } from '../../src/renderer/slots/index.js';

function Marker({ text }: { text: string }): React.ReactNode {
  return <p>{text}</p>;
}

/** 同时读静态 props 与宿主补传 props（断言两者合并/覆盖关系） */
function Echo({ text, width }: { text: string; width?: number }): React.ReactNode {
  return <p>{`${text}:${width ?? 'none'}`}</p>;
}

function registryWithSeats() {
  const registry = createSlotRegistry();
  registry.declare({ id: 'one', kind: 'single', owner: 'shell/layout' });
  registry.declare({ id: 'kbd', kind: 'keyed', owner: 'shell/layout', keys: ['conversation', 'plan'] });
  registry.declare({ id: 'many', kind: 'list', owner: 'shell/layout' });
  return registry;
}

describe('SlotHost 渲染（D-01 / D-02）', () => {
  it('single：渲染当前唯一贡献（带断言用的 slot 归属标记）', () => {
    const registry = registryWithSeats();
    registry.inject({ seat: 'one', owner: 'ui-a', component: Marker, props: { text: '唯一的' } });
    render(<SlotHost registry={registry} seat="one" />);
    const node = screen.getByText('唯一的');
    expect(node).toBeTruthy();
    const wrapper = node.closest('[data-slot]');
    expect(wrapper?.getAttribute('data-slot')).toBe('one');
    expect(wrapper?.getAttribute('data-slot-owner')).toBe('ui-a');
    cleanup();
  });

  it('keyed：只渲染激活 key 的内容；没有该 key 时不渲染、也不回落到「第一个」', () => {
    const registry = registryWithSeats();
    registry.inject({
      seat: 'kbd',
      key: 'conversation',
      owner: 'ui-conversation',
      component: Marker,
      props: { text: '会话页' },
    });
    registry.inject({ seat: 'kbd', key: 'plan', owner: 'ui-plan', component: Marker, props: { text: '计划面板' } });

    render(<SlotHost registry={registry} seat="kbd" activeKey="plan" />);
    expect(screen.getByText('计划面板')).toBeTruthy();
    expect(screen.queryByText('会话页')).toBeNull();
    cleanup();

    render(<SlotHost registry={registry} seat="kbd" activeKey="nope" fallback={<em>空</em>} />);
    expect(screen.getByText('空')).toBeTruthy();
    expect(screen.queryByText('会话页')).toBeNull(); // 绝不取第一个注册的
    expect(screen.queryByText('计划面板')).toBeNull();
    cleanup();

    render(<SlotHost registry={registry} seat="kbd" activeKey="conversation" />);
    expect(screen.getByText('会话页')).toBeTruthy();
    cleanup();
  });

  it('list：按 order 渲染多份；运行中注入即时出现，disposer 后消失', () => {
    const registry = registryWithSeats();
    const disposeFirst = registry.inject({
      seat: 'many',
      owner: 'ui-b',
      order: 1,
      component: Marker,
      props: { text: '第二' },
    });
    const view = render(<SlotHost registry={registry} seat="many" />);
    expect(screen.queryByText('第二')).toBeTruthy();

    let disposeEarly = (): void => {};
    act(() => {
      disposeEarly = registry.inject({
        seat: 'many',
        owner: 'ui-a',
        order: 0,
        component: Marker,
        props: { text: '第一' },
      });
    });
    view.rerender(<SlotHost registry={registry} seat="many" />);
    const texts = screen.getAllByText(/第/).map((n) => n.textContent);
    expect(texts).toEqual(['第一', '第二']);

    act(() => disposeFirst());
    view.rerender(<SlotHost registry={registry} seat="many" />);
    expect(screen.queryByText('第二')).toBeNull();
    expect(screen.getByText('第一')).toBeTruthy();

    act(() => disposeEarly());
    view.rerender(<SlotHost registry={registry} seat="many" />);
    expect(screen.queryByText('第一')).toBeNull();
    cleanup();
  });

  it('空席位：无贡献时渲染 fallback（无 fallback 则什么都不渲染）', () => {
    const registry = registryWithSeats();
    render(<SlotHost registry={registry} seat="one" fallback={<span>未装配</span>} />);
    expect(screen.getByText('未装配')).toBeTruthy();
    cleanup();
    const { container } = render(<SlotHost registry={registry} seat="one" />);
    expect(container.textContent).toBe('');
    cleanup();
  });

  it('ownerProps：宿主当帧补传的 props 与注入时的静态 props 合并（同名覆盖）', () => {
    const registry = registryWithSeats();
    registry.inject({ seat: 'one', owner: 'ui-x', component: Echo, props: { text: '右栏', width: 999 } });
    const view = render(<SlotHost registry={registry} seat="one" />);
    expect(screen.getByText('右栏:999')).toBeTruthy(); // 无补传：静态 props 原样
    view.rerender(<SlotHost registry={registry} seat="one" ownerProps={{ width: 300, canShow: true }} />);
    expect(screen.getByText('右栏:300')).toBeTruthy(); // 补传覆盖同名静态 props（上游 width/canShow）
    cleanup();
  });

  it('slot-entry 容器是 div（包块级内容合法；display:contents 不参与布局）', () => {
    const registry = registryWithSeats();
    registry.inject({ seat: 'one', owner: 'ui-x', component: Marker, props: { text: '块级内容' } });
    const view = render(<SlotHost registry={registry} seat="one" ownerProps={{}} />);
    const node = screen.getByText('块级内容');
    const wrapper = node.closest('[data-slot]');
    expect(wrapper?.tagName).toBe('DIV');
    // 块级内容（如 <aside>）嵌在 span 里是非法 HTML —— 这里如实验证 div 包裹
    expect(wrapper?.className).toBe('slot-entry');
    view.unmount();
    cleanup();
  });
});
