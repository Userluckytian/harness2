// getContextUsage 只读导出测试（T6）：占用比例 0..1、数据源与压缩触发一致、
// 无效目录不抛错、contextWindow 缺省取默认值。只读、无副作用。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getContextUsage } from '../src/agent/contextUsage.js';
import { SessionWriter } from '../src/session/writer.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-ctx-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('getContextUsage', () => {
  it('空会话（仅 header）占用接近 0', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 't', cwd: dir });
    w.close();
    const usage = getContextUsage(dir);
    expect(usage).toBeGreaterThanOrEqual(0);
    expect(usage).toBeLessThan(0.01);
  });

  it('文本越长占用越高（样本与触发一致）', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 't', cwd: dir });
    for (let i = 0; i < 20; i++) {
      w.append('user/message', { text: '你好，请总结一下当前仓库结构和主要变更点。'.repeat(5) });
      w.append('assistant/message', { text: '好的，我来分析。'.repeat(10) });
    }
    w.close();
    const usage = getContextUsage(dir, { contextWindow: 1024 });
    expect(usage).toBeGreaterThan(0);
    // 字符/4 = (20*(30*5+4*10))/4 ≈ 950 → 上限 1.0 附近
    expect(usage).toBeLessThanOrEqual(1);
    const usageBig = getContextUsage(dir, { contextWindow: 512 });
    expect(usageBig).toBeGreaterThan(usage!);
  });

  it('超窗（tokens > contextWindow）截断到 1.0', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 't', cwd: dir });
    w.append('user/message', { text: 'x'.repeat(100_000) });
    w.close();
    expect(getContextUsage(dir, { contextWindow: 1000 })).toBe(1);
  });

  it('contextWindow <= 0 返回 undefined（没有可用的容量）', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 't', cwd: dir });
    w.close();
    expect(getContextUsage(dir, { contextWindow: 0 })).toBeUndefined();
  });

  it('目录不存在返回 undefined；坏日志行被容错跳过返回 0（不抛错）', () => {
    expect(getContextUsage(join(tmpDir(), 'nope'))).toBeUndefined();
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 't', cwd: dir });
    w.close();
    // 覆盖损坏：写坏行（loadSession 容错跳过，如既存语义）
    writeFileSync(join(dir, 'session.log'), 'not-json\n');
    expect(getContextUsage(dir)).toBe(0);
  });

  it('缺省 contextWindow 取 DEFAULT_CONTEXT_WINDOW（匹配压缩兜底）', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 't', cwd: dir });
    w.append('user/message', { text: 'a'.repeat(12_800) }); // ≈3200 tokens / 131072
    w.close();
    expect(getContextUsage(dir)).toBeGreaterThan(0);
    expect(getContextUsage(dir)).toBeLessThan(0.05);
  });
});
