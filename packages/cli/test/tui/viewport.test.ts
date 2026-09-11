// T3 viewport 纯函数测试：follow 与锚定、切片边界、高度缓存 total/invalidate、
// 追加新 item 时锚点仍可见。
import { describe, expect, it } from 'vitest';
import {
  computeViewport,
  estimateItemHeight,
  transcriptHeightCache,
  type TranscriptItem,
} from '../../src/tui/transcript.js';

function sysItem(id: string, text: string): TranscriptItem {
  return { kind: 'system', id, text };
}

describe('computeViewport：follow 与切片', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const heights = [3, 3, 3];
  const totalHeight = 9;

  it('follow：滚到内容末尾，只切出尾部可视 item', () => {
    const vp = computeViewport(items, { heights, totalHeight, height: 4, follow: true, scrollTop: 0 });
    expect(vp.follow).toBe(true);
    // 末尾 4 行 = b(3)+c(3) 尾部 → start=1
    expect(vp.start).toBe(1);
    expect(vp.end).toBe(3);
    expect(vp.offset).toBe(2); // b 被顶部裁掉 2 行
  });

  it('非 follow：按 scrollTop 从顶部切片', () => {
    const vp = computeViewport(items, { heights, totalHeight, height: 4, follow: false, scrollTop: 0 });
    expect(vp.follow).toBe(false);
    expect(vp.start).toBe(0);
    expect(vp.end).toBe(2); // a(3)+b 顶 1 行
    expect(vp.offset).toBe(0);
  });

  it('内容不足一屏：强制 follow 且从头显示', () => {
    const vp = computeViewport(items, { heights, totalHeight: 9, height: 20, follow: false, scrollTop: 5 });
    expect(vp.follow).toBe(true);
    expect(vp.start).toBe(0);
    expect(vp.end).toBe(3);
    expect(vp.offset).toBe(0);
  });

  it('scrollTop 越界被夹取到 [0, totalHeight-height]', () => {
    const hi = computeViewport(items, { heights, totalHeight, height: 4, follow: false, scrollTop: 999 });
    expect(hi.start).toBe(1);
    const lo = computeViewport(items, { heights, totalHeight, height: 4, follow: false, scrollTop: -5 });
    expect(lo.start).toBe(0);
    expect(lo.offset).toBe(0);
  });

  it('空列表不越界', () => {
    const vp = computeViewport([], { heights: [], totalHeight: 0, height: 10, follow: true, scrollTop: 0 });
    expect(vp.start).toBe(0);
    expect(vp.end).toBe(0);
  });
});

describe('computeViewport：锚定', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const heights = [4, 4, 4];
  const totalHeight = 12;

  it('给出 anchorId 时返回其索引并保证其可见', () => {
    const vp = computeViewport(items, { heights, totalHeight, height: 4, follow: false, scrollTop: 4, anchorId: 'b' });
    expect(vp.anchorIndex).toBe(1);
    expect(vp.start).toBeLessThanOrEqual(1);
    expect(vp.end).toBeGreaterThan(1);
  });

  it('追加新 item 后锚点仍可见（scrollTop 不变，内容向下生长）', () => {
    const input = { heights, totalHeight, height: 4, follow: false, scrollTop: 4, anchorId: 'b' } as const;
    const before = computeViewport(items, input);
    // 追加 d 到末尾：b 之前的行数不变，锚点仍落在同一位置
    const grown = [...items, { id: 'd' }];
    const after = computeViewport(grown, { ...input, heights: [...heights, 4], totalHeight: 16 });
    expect(after.anchorIndex).toBe(1);
    expect(after.start).toBe(before.start);
    const anchorTop = 4; // cumBefore(1)
    expect(anchorTop < after.start * 4 + 4).toBe(true);
    expect(after.start).toBeLessThanOrEqual(after.anchorIndex);
  });

  it('anchorId 不存在时 anchorIndex=-1，不抛错', () => {
    const vp = computeViewport(items, {
      heights,
      totalHeight,
      height: 4,
      follow: false,
      scrollTop: 0,
      anchorId: 'zzz',
    });
    expect(vp.anchorIndex).toBe(-1);
  });
});

describe('computeViewport：面板占用行时视口相应收缩', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const heights = [3, 3, 3, 3];
  const totalHeight = 12;

  it('底部面板扣减 height 后，可见 item 数量减少（不溢出）', () => {
    const full = computeViewport(items, { heights, totalHeight, height: 12, follow: false, scrollTop: 12 });
    expect(full.end - full.start).toBe(4); // 无面板：全部可见
    const withPanels = computeViewport(items, { heights, totalHeight, height: 4, follow: false, scrollTop: 12 });
    expect(withPanels.end - withPanels.start).toBe(2); // 面板占 8 行 → 只剩 4 行视口
    expect(withPanels.offset).toBeGreaterThanOrEqual(0);
  });
});

describe('transcriptHeightCache', () => {
  it('set/get/total：缺失项按 0 计；total 按 ids 求和', () => {
    const cache = transcriptHeightCache();
    cache.set('a', 3);
    cache.set('b', 5);
    expect(cache.get('a')).toBe(3);
    expect(cache.get('missing')).toBeUndefined();
    expect(cache.total(['a', 'b', 'missing'])).toBe(8);
  });

  it('invalidate(prefix)：移除该前缀；缺省清空全部', () => {
    const cache = transcriptHeightCache();
    cache.set('tool:c1', 2);
    cache.set('tool:c2', 4);
    cache.set('user:2', 1);
    cache.invalidate('tool:');
    expect(cache.get('tool:c1')).toBeUndefined();
    expect(cache.get('tool:c2')).toBeUndefined();
    expect(cache.get('user:2')).toBe(1);
    cache.invalidate();
    expect(cache.get('user:2')).toBeUndefined();
  });
});

describe('estimateItemHeight', () => {
  it('按显示宽度软折行估算行数；空文本至少 1 行', () => {
    expect(estimateItemHeight(sysItem('s', 'abc'.repeat(30)), 30)).toBeGreaterThanOrEqual(3);
    expect(estimateItemHeight(sysItem('s', ''), 30)).toBe(1);
    expect(estimateItemHeight(sysItem('s', 'a\nb'), 30)).toBe(2);
  });
});
