// 快照回放测试：fixture 会话 → 重建投影 → 与黄金值断言；再经 writer 重放验证无分叉。
// 全程不需要 API key —— 轨迹即测试夹具（对照 deepseek-harness snapshots）。
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SessionWriter } from '../src/session/writer.js';
import { type AnySessionEvent, type SessionEvent, SESSION_LOG_FILE } from '../src/session/types.js';
import { computeProjection, exportAllEvents, loadSession } from '../src/session/reader.js';
import { renderTrajectory } from '../src/trajectory/view.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'demo-session');

function isMessageEvent(e: AnySessionEvent): e is SessionEvent<'user/message'> | SessionEvent<'assistant/message'> {
  return e.type === 'user/message' || e.type === 'assistant/message';
}

describe('fixture: demo-session', () => {
  const session = loadSession(fixtureDir);
  const projection = computeProjection(session);

  it('日志完整合法（无告警），黄金投影一致', () => {
    expect(session.warnings).toEqual([]);
    expect(session.events).toHaveLength(12);
    expect(session.header?.sessionId).toBe('demo-session');

    expect(projection.messages.map((m) => m.text)).toEqual([
      '列出当前目录的文件',
      '我来查看目录内容。',
      '目录下有 README.md 和 package.json。',
      '查看 .gitignore 内容',
    ]);
    expect(projection.rewindCount).toBe(1);
    expect(projection.shadowedCount).toBe(2); // 限流失败的 turn2（seq 9-10）
    expect(projection.lastSeq).toBe(12);
  });

  it('Model-visible ⟺ logged：活动消息与日志中的消息事件一一对应', () => {
    const loggedActive = session.events
      .filter(({ active }) => active)
      .map(({ event }) => event)
      .filter(isMessageEvent)
      .map((e) => e.payload.text);
    expect(loggedActive).toEqual(projection.messages.map((m) => m.text));
  });

  it('append-only 导出无损：逐行序列化后与原文件行数一致', () => {
    const originalLines = readFileSync(join(fixtureDir, SESSION_LOG_FILE), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(exportAllEvents(session).split('\n')).toHaveLength(originalLines.length);
  });

  it('渲染确定性：两次加载投影逐字段相等；影子事件仅在 --all 视图出现', () => {
    const again = computeProjection(loadSession(fixtureDir));
    expect(again).toEqual(projection);
    const rendered = renderTrajectory(session).join('\n');
    expect(rendered).toContain('[REWIND] to seq 8 (turn2 因限流失败，回退重试)');
    expect(rendered).toContain('< ok 34ms: README.md\\npackage.json'); // 多行输出折叠为单行
    expect(rendered).not.toContain('attempt failed'); // 影子区内容默认不渲染
    expect(rendered).toMatch(/12 events \| 4 messages \| 1 rewind\(s\) \| shadowed 2/);

    const withShadowed = renderTrajectory(session, { includeShadowed: true }).join('\n');
    expect(withShadowed).toContain('! attempt failed: rate_limited: 429');
    expect(withShadowed).toContain('~ [USER] 顺便看下 .gitignore');
  });

  it('writer 重放：相同事件流写入新日志后投影一致（无分叉）', () => {
    const replayDir = mkdtempSync(join(tmpdir(), 'h2-replay-'));
    try {
      const w = SessionWriter.create(replayDir, { sessionId: 'demo-session', parentSession: 'demo-session', isSeeded: true }, { fsync: false });
      for (const { event } of loadSession(fixtureDir).events) {
        if (event.type === 'session/header') continue; // writer.create 已写新 header
        w.append(event.type, event.payload);
      }
      w.close();

      const replayProjection = computeProjection(loadSession(replayDir));
      expect(replayProjection.messages.map((m) => `${m.role}:${m.text}`)).toEqual(
        projection.messages.map((m) => `${m.role}:${m.text}`),
      );
      expect(replayProjection.rewindCount).toBe(projection.rewindCount);
      expect(replayProjection.lastSeq).toBe(projection.lastSeq);
    } finally {
      rmSync(replayDir, { recursive: true, force: true });
    }
  });
});
