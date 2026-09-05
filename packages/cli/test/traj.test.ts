import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionWriter } from '@harness2/core';

// 依赖根脚本 `pnpm -r build && pnpm -r test`：core 与 cli 的 dist 均已构建
const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-traj-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeSession(dir: string): void {
  const w = SessionWriter.create(dir, { sessionId: 'traj-demo', cwd: 'D:/demo' }, { fsync: false });
  w.append('user/message', { text: 'hello', turnId: 't1' });
  w.append('assistant/message', {
    text: 'hi there',
    model: 'glm-5.3',
    usage: { inputTokens: 10, outputTokens: 4 },
    turnId: 't1',
  });
  w.append('step/start', { stepId: 's1', turnId: 't1' });
  w.append('tool/call', { callId: 'c1', tool: 'bash', args: { cmd: 'ls' }, turnId: 't1' });
  w.append('tool/result', { callId: 'c1', ok: true, output: 'file1.txt', durationMs: 12 });
  w.append('step/end', { stepId: 's1', turnId: 't1', durationMs: 15 });
  w.append('user/message', { text: 'shadowed-user', turnId: 't2' });
  w.append('assistant/message', { text: 'shadowed-answer', turnId: 't2' });
  // 回退到 seq=7（turn 1 的 step/tool 之后）：只遮蔽 turn 2 的两条消息
  w.append('rewind/marker', { rewindToSeq: 7, reason: 'undo turn 2' });
  w.close();
}

describe('harness2 traj', () => {
  it('默认渲染活动投影：含消息/工具/回退统计，不含影子消息', () => {
    const dir = tmpDir();
    makeSession(dir);
    const out = execFileSync('node', [cliEntry, 'traj', dir], { encoding: 'utf8' });
    expect(out).toContain('# session traj-demo (D:/demo)');
    expect(out).toContain('[USER] hello');
    expect(out).toContain('[ASSISTANT] [glm-5.3] hi there (10 in / 4 out)');
    expect(out).toContain('> tool bash({"cmd":"ls"})');
    expect(out).toContain('< ok 12ms: file1.txt');
    expect(out).toContain('[REWIND] to seq 7 (undo turn 2)');
    expect(out).not.toContain('shadowed-user');
    expect(out).toMatch(/-- 10 events \| 2 messages \| 1 rewind\(s\) \| shadowed 2/);
  });

  it('--all 显示影子事件；--json 输出结构化事件与投影', () => {
    const dir = tmpDir();
    makeSession(dir);
    const outAll = execFileSync('node', [cliEntry, 'traj', dir, '--all'], { encoding: 'utf8' });
    expect(outAll).toContain('~ [USER] shadowed-user');
    expect(outAll).toContain('~ [ASSISTANT] shadowed-answer');

    const outJson = JSON.parse(execFileSync('node', [cliEntry, 'traj', dir, '--json'], { encoding: 'utf8' })) as {
      header: { sessionId: string } | null;
      warnings: string[];
      projection: { messages: unknown[]; lastSeq: number };
      events: Array<{ seq: number; type: string; active: boolean }>;
    };
    expect(outJson.header?.sessionId).toBe('traj-demo');
    expect(outJson.warnings).toEqual([]);
    expect(outJson.projection.messages).toHaveLength(2);
    expect(outJson.projection.lastSeq).toBe(10);
    expect(outJson.events).toHaveLength(10);
    expect(outJson.events.filter((e) => !e.active)).toHaveLength(2);
  });
});
