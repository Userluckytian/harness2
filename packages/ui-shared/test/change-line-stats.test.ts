// Z10-6c：变更面板「每文件 +N/−M」行级增删纯函数（复用既有 diff 依赖，不新增依赖）。
// 覆盖：全增 / 全删 / 部分改 / 两边 null / 大文件不炸 + 末尾空行口径。
import { describe, expect, it } from 'vitest';
import { changeLineStats } from '../src/renderer/panels/workspace/change-line-stats.js';

describe('changeLineStats（拟议 before→after 行级增删）', () => {
  it('全增：before=null（新增文件）→ after 全部计入 added', () => {
    expect(changeLineStats(null, 'a\nb\nc\n')).toEqual({ added: 3, deleted: 0 });
  });

  it('全删：after=null（删除文件）→ before 全部计入 deleted', () => {
    expect(changeLineStats('a\nb\n', null)).toEqual({ added: 0, deleted: 2 });
  });

  it('部分改：只算变更行，上下文行不计', () => {
    expect(changeLineStats('x\nold\ny\n', 'x\nnew\ny\n')).toEqual({ added: 1, deleted: 1 });
  });

  it('两边都 null → null（无内容可比，不猜、不显示 +0 −0）', () => {
    expect(changeLineStats(null, null)).toBeNull();
  });

  it('空文本（非 null）→ 零变更而非 null（空文件是真实内容，与「无内容」区分）', () => {
    expect(changeLineStats('', '')).toEqual({ added: 0, deleted: 0 });
    expect(changeLineStats('', 'a\n')).toEqual({ added: 1, deleted: 0 });
  });

  it('无变化 → 零增零删（上下文行不计）', () => {
    expect(changeLineStats('a\nb\n', 'a\nb\n')).toEqual({ added: 0, deleted: 0 });
  });

  it('末尾空行不产生多余计数（与 DiffCard.buildDiffRows 同口径）', () => {
    expect(changeLineStats(null, 'a\n')).toEqual({ added: 1, deleted: 0 });
    expect(changeLineStats('a\n', null)).toEqual({ added: 0, deleted: 1 });
  });

  it('大文件不炸：数千行仅少量改动 → 计数正确、不抛错', () => {
    const base = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
    const changed = base.split('\n');
    changed[10] = 'CHANGED-10';
    changed[3990] = 'CHANGED-3990';
    const after = [...changed, 'APPENDED'].join('\n');
    const stats = changeLineStats(`${base}\n`, `${after}\n`);
    expect(stats).toEqual({ added: 3, deleted: 2 });
  });
});
