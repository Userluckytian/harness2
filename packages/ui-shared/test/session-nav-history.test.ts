// Z10-3 会话导航历史（壳无关纯逻辑 + 小 store）单测：
//   record 相邻去重 / forward 分支截断 / back-forward 游标 / canGoBack-canGoForward / 上限 50。
// node 环境（vitest 默认）；不依赖 React/DOM。
import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_NAV_HISTORY_LIMIT,
  SessionNavHistory,
  canGoBack,
  canGoForward,
  currentHistoryEntry,
  initialSessionNavHistory,
  recordHistoryEntry,
  stepHistoryBack,
  stepHistoryForward,
} from '../src/renderer/layout/session-nav-history.js';

describe('session-nav-history 纯函数', () => {
  it('空历史：无后退/前进，游标 -1，当前条目 null', () => {
    const s = initialSessionNavHistory();
    expect(s.entries).toEqual([]);
    expect(s.index).toBe(-1);
    expect(canGoBack(s)).toBe(false);
    expect(canGoForward(s)).toBe(false);
    expect(currentHistoryEntry(s)).toBeNull();
    expect(stepHistoryBack(s)).toBe(s); // 无处可退：原样返回同一引用（不误动）
    expect(stepHistoryForward(s)).toBe(s);
  });

  it('record：依次记录 a、b → 游标指向 b，可后退不可前进', () => {
    const a = recordHistoryEntry(initialSessionNavHistory(), 'a');
    expect(a.entries).toEqual(['a']);
    expect(a.index).toBe(0);
    expect(canGoBack(a)).toBe(false);

    const b = recordHistoryEntry(a, 'b');
    expect(b.entries).toEqual(['a', 'b']);
    expect(b.index).toBe(1);
    expect(canGoBack(b)).toBe(true);
    expect(canGoForward(b)).toBe(false);
    expect(currentHistoryEntry(b)).toBe('b');
  });

  it('record 相邻重复去重：连续记录同一 id 不增长、返回同一引用', () => {
    const b = recordHistoryEntry(recordHistoryEntry(initialSessionNavHistory(), 'a'), 'a');
    expect(b.entries).toEqual(['a']);
    expect(b.index).toBe(0);
    // 空串也不记录
    const e = recordHistoryEntry(b, '');
    expect(e).toBe(b);
    expect(e.entries).toEqual(['a']);
  });

  it('back/forward：游标移动，边界返回同一引用（不越界）', () => {
    let s = initialSessionNavHistory();
    for (const id of ['a', 'b', 'c']) s = recordHistoryEntry(s, id);
    expect(s.index).toBe(2);

    const back1 = stepHistoryBack(s);
    expect(back1.index).toBe(1);
    expect(back1.entries).toEqual(['a', 'b', 'c']); // 条目保留，无前进分支被截
    expect(canGoForward(back1)).toBe(true);
    expect(currentHistoryEntry(back1)).toBe('b');

    const back2 = stepHistoryBack(back1);
    expect(back2.index).toBe(0);
    expect(stepHistoryBack(back2)).toBe(back2); // 已到最旧：不越界

    const fwd = stepHistoryForward(back2);
    expect(fwd.index).toBe(1);
    expect(currentHistoryEntry(fwd)).toBe('b');
  });

  it('forward 分支截断：后退后再记录新会话 → 丢弃游标之后的分支', () => {
    let s = initialSessionNavHistory();
    for (const id of ['a', 'b', 'c']) s = recordHistoryEntry(s, id); // [a,b,c] idx2
    s = stepHistoryBack(s); // idx1 (b)
    s = stepHistoryBack(s); // idx0 (a)
    s = recordHistoryEntry(s, 'd'); // 从 a 记录 d → 截掉 b,c
    expect(s.entries).toEqual(['a', 'd']);
    expect(s.index).toBe(1);
    expect(canGoForward(s)).toBe(false);
  });

  it('上限 50：超过则丢最旧，长度恒 ≤ 50', () => {
    let s = initialSessionNavHistory();
    for (let i = 0; i < SESSION_NAV_HISTORY_LIMIT + 10; i += 1) s = recordHistoryEntry(s, `s${i}`);
    expect(s.entries.length).toBe(SESSION_NAV_HISTORY_LIMIT);
    expect(s.entries[0]).toBe('s10'); // 最旧 10 条被丢
    expect(s.entries[s.entries.length - 1]).toBe('s59');
    expect(s.index).toBe(SESSION_NAV_HISTORY_LIMIT - 1);
  });
});

describe('SessionNavHistory store（单例行为）', () => {
  it('record/back/forward 经 store：back 返回上一会话，forward 前进；边界 null', () => {
    const h = new SessionNavHistory();
    expect(h.back()).toBeNull(); // 空栈：不报错、不误动
    expect(h.forward()).toBeNull();

    h.record('a');
    h.record('b');
    expect(h.canGoBack()).toBe(true);
    expect(h.canGoForward()).toBe(false);

    expect(h.back()).toBe('a');
    expect(h.canGoBack()).toBe(false);
    expect(h.canGoForward()).toBe(true);
    expect(h.back()).toBe('a'); // 已到最旧：停在 a（不越界）

    expect(h.forward()).toBe('b');
    expect(h.forward()).toBe('b'); // 已到最新：停在 b
    expect(h.canGoForward()).toBe(false);
  });

  it('订阅：状态变化通知监听者；reset 复位且通知', () => {
    const h = new SessionNavHistory();
    const listener = vi.fn();
    const unsub = h.subscribe(listener);
    h.record('a');
    expect(listener).toHaveBeenCalledTimes(1);
    h.record('a'); // 去重 → 无变化 → 不通知
    expect(listener).toHaveBeenCalledTimes(1);
    h.record('b');
    expect(listener).toHaveBeenCalledTimes(2);
    h.reset();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(h.getSnapshot()).toEqual(initialSessionNavHistory());
    unsub();
    h.record('c');
    expect(listener).toHaveBeenCalledTimes(3); // 已退订
  });
});
