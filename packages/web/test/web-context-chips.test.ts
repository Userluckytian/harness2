// Z10-2 web 降级用例：项目 chip = 会话 cwd 末段（只读）；web 无 gitBranch 通道 → 分支 chip 恒不出。
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@harness2/ui-shared/renderer/store.js';
import { webContextChipsForSession } from '../src/web-context-chips.js';

function session(id: string, cwd?: string): SessionMeta {
  return { id, mtimeMs: 1, firstUserText: 'x', messageCount: 0, lastSeq: 0, ...(cwd !== undefined ? { cwd } : {}) };
}

describe('webContextChipsForSession（web 无 gitBranch 通道的如实降级）', () => {
  it('有 cwd 会话 → 只出项目 chip（cwd 末段），分支 chip 恒不出（无通道、不显示假分支名）', () => {
    const chips = webContextChipsForSession([session('s1', 'D:/AI_Projects/harness2')], 's1');
    expect(chips).toEqual({ project: { label: 'harness2', disabledHint: '暂不支持切换项目' } });
    expect(chips?.branch).toBeUndefined();
  });

  it('Windows 反斜杠路径同样取末段', () => {
    expect(webContextChipsForSession([session('s1', 'D:\\proj\\server')], 's1')?.project?.label).toBe('server');
  });

  it('会话无 cwd → undefined（整行不渲染，不摆空 chip）', () => {
    expect(webContextChipsForSession([session('s1')], 's1')).toBeUndefined();
  });

  it('无会话（sessionId null/undefined）→ undefined', () => {
    expect(webContextChipsForSession([session('s1', 'D:/x/a')], null)).toBeUndefined();
    expect(webContextChipsForSession([session('s1', 'D:/x/a')], undefined)).toBeUndefined();
  });

  it('未知会话 id → undefined', () => {
    expect(webContextChipsForSession([session('s1', 'D:/x/a')], 'nope')).toBeUndefined();
  });
});
