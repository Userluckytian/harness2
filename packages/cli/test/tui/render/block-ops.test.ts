// G-06 块内容操作单测（headless，纯逻辑 + 注入回调）：
// - 键位表全表（y/Shift+Y/Enter/Ctrl+F → 动作描述对象；未知键 null）
// - 纯解析：剪贴板文本组成（正文 / 元数据在上正文在下 / 无元数据退化）与查看器意图
// - 注入回调：copyText/openViewer 按动作分派、携带块 id 与口径；缺省 no-op 不做假 UI
import { describe, expect, it } from 'vitest';
import {
  noopBlockOpCallbacks,
  blockOpForKey,
  dispatchBlockOp,
  resolveBlockOp,
  type BlockContent,
  type BlockOpCallbacks,
} from '../../../src/tui/render/block-ops.js';

const BLOCK: BlockContent = {
  id: 'b1',
  body: '正文第一行\n正文第二行',
  metadata: ['assistant · 2026-09-13', 'model: glm-5'],
};

describe('键位表 blockOpForKey（G-06）', () => {
  it('y → copy-body；Shift+Y → copy-with-metadata（动作对象带触发键）', () => {
    expect(blockOpForKey('y')).toEqual({ type: 'copy-body', key: 'y' });
    expect(blockOpForKey('Shift+Y')).toEqual({ type: 'copy-with-metadata', key: 'Shift+Y' });
  });

  it('Enter 与 Ctrl+F 同为 open-viewer（双入口，键位各自记录）', () => {
    expect(blockOpForKey('Enter')).toEqual({ type: 'open-viewer', key: 'Enter' });
    expect(blockOpForKey('Ctrl+F')).toEqual({ type: 'open-viewer', key: 'Ctrl+F' });
  });

  it('未知键 null（不越权处理焦点/滚动/折叠键位）', () => {
    expect(blockOpForKey('j' as never)).toBeNull();
    expect(blockOpForKey('h' as never)).toBeNull();
  });
});

describe('纯解析 resolveBlockOp（无副作用）', () => {
  it('copy-body：剪贴板文本 = 正文原样', () => {
    const r = resolveBlockOp({ type: 'copy-body', key: 'y' }, BLOCK);
    expect(r.clipboardText).toBe('正文第一行\n正文第二行');
    expect(r.openViewer).toBe(false);
  });

  it('copy-with-metadata：元数据行在上、正文在下（\n 连接）', () => {
    const r = resolveBlockOp({ type: 'copy-with-metadata', key: 'Shift+Y' }, BLOCK);
    expect(r.clipboardText).toBe('assistant · 2026-09-13\nmodel: glm-5\n正文第一行\n正文第二行');
    expect(r.openViewer).toBe(false);
  });

  it('copy-with-metadata 无元数据：退化为正文（动作类型仍可区分入口）', () => {
    const r = resolveBlockOp({ type: 'copy-with-metadata', key: 'Shift+Y' }, { id: 'b2', body: '正文' });
    expect(r.clipboardText).toBe('正文');
    expect(r.action.type).toBe('copy-with-metadata');
  });

  it('open-viewer：无剪贴板文本、查看器意图 true', () => {
    const r = resolveBlockOp({ type: 'open-viewer', key: 'Ctrl+F' }, BLOCK);
    expect(r.clipboardText).toBeNull();
    expect(r.openViewer).toBe(true);
  });
});

describe('注入回调 dispatchBlockOp', () => {
  it('y：copyText 收正文 + {blockId, kind: body}；不碰查看器', () => {
    const copied: string[] = [];
    const metas: unknown[] = [];
    let viewerOpened = 0;
    const cb: BlockOpCallbacks = {
      copyText: (text, meta) => {
        copied.push(text);
        metas.push(meta);
      },
      openViewer: () => {
        viewerOpened += 1;
      },
    };
    const r = dispatchBlockOp('y', BLOCK, cb);
    expect(copied).toEqual(['正文第一行\n正文第二行']);
    expect(metas).toEqual([{ blockId: 'b1', kind: 'body' }]);
    expect(viewerOpened).toBe(0);
    expect(r?.action.type).toBe('copy-body');
  });

  it('Shift+Y：kind = body+metadata，文本含元数据', () => {
    const metas: unknown[] = [];
    const texts: string[] = [];
    dispatchBlockOp('Shift+Y', BLOCK, {
      copyText: (text, meta) => {
        texts.push(text);
        metas.push(meta);
      },
    });
    expect(metas).toEqual([{ blockId: 'b1', kind: 'body+metadata' }]);
    expect(texts[0]).toContain('model: glm-5');
  });

  it('Enter / Ctrl+F：openViewer 收完整块内容，不碰剪贴板', () => {
    let openedWith: BlockContent | null = null;
    let copied = 0;
    const r = dispatchBlockOp('Enter', BLOCK, {
      copyText: () => {
        copied += 1;
      },
      openViewer: (b) => {
        openedWith = b;
      },
    });
    expect(openedWith).toEqual(BLOCK);
    expect(copied).toBe(0);
    expect(r?.openViewer).toBe(true);
  });

  it('未知键：null 且不执行任何回调', () => {
    let called = 0;
    expect(
      dispatchBlockOp('j' as never, BLOCK, { copyText: () => (called += 1), openViewer: () => (called += 1) }),
    ).toBeNull();
    expect(called).toBe(0);
  });
});

describe('空实现注入点（不做假 UI）', () => {
  it('noopBlockOpCallbacks 无任何回调；四键全派发不抛错且返回纯结果', () => {
    expect(Object.keys(noopBlockOpCallbacks)).toEqual([]);
    for (const key of ['y', 'Shift+Y', 'Enter', 'Ctrl+F'] as const) {
      expect(() => dispatchBlockOp(key, BLOCK)).not.toThrow();
      expect(dispatchBlockOp(key, BLOCK)?.action).toBeDefined();
    }
  });
});
