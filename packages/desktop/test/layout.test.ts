// 分屏布局测试（Task 5）：纯函数（normalize/栏数变化/分配去重/后台判定）+ 主进程持久化读写。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assignSession,
  boundSessionIds,
  defaultLayout,
  MAX_PANES,
  normalizeLayout,
  setPaneCount,
  type DesktopLayout,
} from '../src/shared/layout.js';
import { readLayout, writeLayout } from '../src/main/layout-file.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-layout-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('布局纯函数', () => {
  it('normalizeLayout：合法布局保留；非法（越界栏数/坏 sessionId/非对象）回落默认', () => {
    expect(normalizeLayout({ panes: [{ sessionId: 'a' }, { sessionId: null }] })).toEqual({
      panes: [{ sessionId: 'a' }, { sessionId: null }],
    });
    expect(normalizeLayout(undefined)).toEqual(defaultLayout());
    expect(normalizeLayout({})).toEqual(defaultLayout());
    expect(normalizeLayout({ panes: [] })).toEqual(defaultLayout());
    expect(
      normalizeLayout({ panes: [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }, { sessionId: 'd' }] }),
    ).toEqual(defaultLayout());
    expect(normalizeLayout({ panes: [{ sessionId: 42 }] })).toEqual(defaultLayout());
    expect(normalizeLayout({ panes: [{}] })).toEqual(defaultLayout());
  });

  it('setPaneCount：1→3 保留绑定、新增空栏；3→1 裁剪；同会话去重只留最靠前', () => {
    const one = setPaneCount(defaultLayout(), 2);
    expect(one.panes).toEqual([{ sessionId: null }, { sessionId: null }]);

    const two: DesktopLayout = { panes: [{ sessionId: 'a' }, { sessionId: null }] };
    const three = setPaneCount(two, 3);
    expect(three.panes).toEqual([{ sessionId: 'a' }, { sessionId: null }, { sessionId: null }]);

    const back = setPaneCount(three, 1);
    expect(back.panes).toEqual([{ sessionId: 'a' }]);

    // setPaneCount 的去重针对持久化文件的遗留形态（同一会话占多栏）
    const dup: DesktopLayout = { panes: [{ sessionId: 'a' }, { sessionId: 'a' }] };
    expect(setPaneCount(dup, 2).panes.map((p) => p.sessionId)).toEqual(['a', null]);
    expect(MAX_PANES).toBe(3);
  });

  it('assignSession：拖入即绑定并清掉其它栏同会话；null 清空该栏；越界下标安全', () => {
    const base = setPaneCount(defaultLayout(), 3);
    const a = assignSession(base, 0, 's1');
    const b = assignSession(a, 2, 's1'); // 同会话拖到第三栏 → 第一栏清空
    expect(b.panes.map((p) => p.sessionId)).toEqual([null, null, 's1']);
    const c = assignSession(b, 2, null);
    expect(c.panes.map((p) => p.sessionId)).toEqual([null, null, null]);
    expect(assignSession(base, 9, 's1')).toEqual(base); // 越界 no-op
    expect(assignSession(base, -1, 's1')).toEqual(base);
  });

  it('boundSessionIds：已绑定会话集合（后台判定用）', () => {
    const layout = assignSession(setPaneCount(defaultLayout(), 2), 1, 's2');
    expect(boundSessionIds(layout)).toEqual(new Set(['s2']));
  });
});

describe('布局持久化（主进程）', () => {
  it('write→read 往返一致；损坏文件/缺失文件回落默认布局', () => {
    const home = tmpDir();
    expect(readLayout(home)).toEqual(defaultLayout()); // 缺失

    const layout = assignSession(setPaneCount(defaultLayout(), 2), 0, 's1');
    expect(writeLayout(home, layout)).toEqual(layout);
    expect(readLayout(home)).toEqual(layout);

    writeFileSync(join(home, '.harness2', 'desktop-layout.json'), '{broken json', 'utf8');
    expect(readLayout(home)).toEqual(defaultLayout()); // 损坏容错

    writeLayout(home, { panes: [{ sessionId: 1 }] }); // 非法结构：写入前被 normalize 为默认
    expect(readLayout(home)).toEqual(defaultLayout());
  });
});
