// 主进程 JSON 持久化公共层测试（审查 P2-3）：原子写「临时文件 + rename」。
// 该层被 desktop-drafts / desktop-layout / preferences / metadata 四份用户数据共用 ——
// 非原子直写被杀/断电会留截断 JSON，读取端 fallback 会吞掉用户整份数据。
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJsonWithDefault, writeJsonNormalized } from '../src/main/json-file.js';

// node:fs 的 ESM namespace 不可 spy：以工厂 mock 只包一层 renameSync（默认透传真实实现）。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const renameMock = vi.mocked(renameSync);

const dirs: string[] = [];
afterEach(() => {
  renameMock.mockClear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpFile(name: string): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-json-'));
  dirs.push(d);
  return join(d, name);
}

const normalize = (raw: unknown): Record<string, string> =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, string>) : {};

describe('writeJsonNormalized 原子写（审查 P2-3）', () => {
  it('走「临时文件 + rename」原子覆盖；成功后无 .tmp 残留（修复前直写，本断言必红）', () => {
    const path = tmpFile('desktop-drafts.json');
    const normalized = writeJsonNormalized(path, { a: '1' }, normalize);
    expect(normalized).toEqual({ a: '1' });
    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(renameMock.mock.calls[0]?.[0]).toBe(`${path}.tmp`); // 临时文件与目标同目录（同卷才原子）
    expect(renameMock.mock.calls[0]?.[1]).toBe(path);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: '1' });
  });

  it('rename 失败（如文件被占用）回落直写并清理临时文件，数据不丢', () => {
    const path = tmpFile('desktop-layout.json');
    renameMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    });
    const normalized = writeJsonNormalized(path, { b: '2' }, normalize);
    expect(normalized).toEqual({ b: '2' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ b: '2' });
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('二次覆盖与读回兼容：落盘内容始终可被 readJsonWithDefault 读回', () => {
    const path = tmpFile('preferences.json');
    writeJsonNormalized(path, { c: '3' }, normalize);
    expect(readJsonWithDefault(path, normalize, () => ({}))).toEqual({ c: '3' });
    writeJsonNormalized(path, { d: '4' }, normalize);
    expect(readJsonWithDefault(path, normalize, () => ({}))).toEqual({ d: '4' });
  });
});
