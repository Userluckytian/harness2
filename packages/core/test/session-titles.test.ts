// H-14 自动标题测试：启发式（首条 user 消息 / 去噪 / 首句 / 截断 / 兜底）/
// 标题存取走 title.json 辅助文件（append-only 零触碰事实源）/ 复用与覆盖 /
// 注入式精炼与降级 / 管理器集成（list 带标题、rename、clear）。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/session/manager.js';
import { SESSION_LOG_FILE } from '../src/session/types.js';
import { loadSession } from '../src/session/reader.js';
import { exportSession } from '../src/session/export.js';
import { unzipSync } from 'fflate';
import {
  SESSION_TITLE_FILE,
  TITLE_MAX_CHARS,
  autoTitleSession,
  buildTitleTranscript,
  clearSessionTitle,
  deriveAutoTitle,
  readSessionTitle,
  sanitizeTitle,
  writeSessionTitle,
} from '../src/session/titles.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-title-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function createSession(root: string, cwd: string, id: string) {
  return new SessionManager(root).create(cwd, { id, fsync: false });
}

describe('H-14 标题规范化', () => {
  it('换行/控制字符折叠为空格，markdown 前缀与成对包裹符号去掉', () => {
    expect(sanitizeTitle('  多行\n标题  ')).toBe('多行 标题');
    expect(sanitizeTitle('"引号包裹的标题"')).toBe('引号包裹的标题');
    expect(sanitizeTitle('「书名号标题」')).toBe('书名号标题');
    expect(sanitizeTitle('## 标题前缀')).toBe('标题前缀');
    expect(sanitizeTitle('1. 有序列表标题')).toBe('有序列表标题');
    expect(sanitizeTitle('   ')).toBe('');
  });

  it('超长截断到上限（含省略号）', () => {
    const long = 'x'.repeat(200);
    const out = sanitizeTitle(long);
    expect(out.length).toBe(TITLE_MAX_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('H-14 启发式标题', () => {
  it('取首条活动 user 消息的首句；basedOnSeq 指向该消息', () => {
    const root = tmpDir();
    const { dir, writer } = createSession(root, '/proj/t', '20260914-333333-aa0001');
    writer.append('user/message', { text: '请修复构建失败的问题。另外还有别的' });
    writer.append('assistant/message', { text: '已修复' });
    writer.close();
    expect(deriveAutoTitle(loadSession(dir))).toEqual({ title: '请修复构建失败的问题。', basedOnSeq: 2 });
  });

  it('去掉注入的 system-reminder 块与代码围栏后取标题', () => {
    const root = tmpDir();
    const { dir, writer } = createSession(root, '/proj/t', '20260914-333333-aa0002');
    writer.append('user/message', {
      text: '<system-reminder>忽略我</system-reminder> 重构这个函数的实现路径',
    });
    writer.close();
    expect(deriveAutoTitle(loadSession(dir)).title).toBe('重构这个函数的实现路径');
  });

  it('无 user 消息时退回首条 assistant 消息；全空时退回会话 id 形态', () => {
    const root = tmpDir();
    const a = createSession(root, '/proj/t', '20260914-333333-aa0003');
    a.writer.append('assistant/message', { text: '思考：这是助手先发言的一条结论性文本' });
    a.writer.close();
    expect(deriveAutoTitle(loadSession(a.dir)).title).toContain('助手先发言');
    const b = createSession(root, '/proj/t', '20260914-333333-aa0004');
    b.writer.close();
    expect(deriveAutoTitle(loadSession(b.dir))).toEqual({ title: '会话 20260914-333333-aa0004', basedOnSeq: 0 });
  });

  it('被 rewind 遮蔽的首条消息不参与取标题（与投影同口径）', () => {
    const root = tmpDir();
    const { dir, writer } = createSession(root, '/proj/t', '20260914-333333-aa0005');
    writer.append('user/message', { text: '被撤回的第一条请求' });
    writer.append('assistant/message', { text: '回复一' });
    writer.append('rewind/marker', { rewindToSeq: 1, reason: 'undo' });
    writer.append('user/message', { text: '真正生效的第二条请求' });
    writer.close();
    expect(deriveAutoTitle(loadSession(dir)).title).toBe('真正生效的第二条请求');
  });

  it('转录输入尾部优先且有界', () => {
    const root = tmpDir();
    const { dir, writer } = createSession(root, '/proj/t', '20260914-333333-aa0006');
    for (let i = 0; i < 20; i++) {
      writer.append('user/message', { text: `第 ${i} 条足够长的用户输入内容` });
      writer.append('assistant/message', { text: `第 ${i} 条足够长的助手回复内容` });
    }
    writer.close();
    const transcript = buildTitleTranscript(loadSession(dir), { maxChars: 100 });
    expect(transcript.length).toBeLessThanOrEqual(100);
    expect(transcript).toContain('第 19 条');
    expect(transcript).not.toContain('第 0 条');
  });
});

describe('H-14 标题存取（title.json 辅助文件，append-only 零触碰）', () => {
  it('写读往返；坏内容读为 null；空标题拒绝', () => {
    const root = tmpDir();
    const { dir, writer } = createSession(root, '/proj/t', '20260914-333333-bb0001');
    writer.append('user/message', { text: 'hi' });
    writer.close();
    const written = writeSessionTitle(dir, '我的标题', { source: 'manual', basedOnSeq: 2 });
    expect(written.source).toBe('manual');
    expect(readSessionTitle(dir)).toEqual(written);
    writeFileSync(join(dir, SESSION_TITLE_FILE), '{broken', 'utf8');
    expect(readSessionTitle(dir)).toBeNull();
    expect(() => writeSessionTitle(dir, '   ')).toThrow(/empty/);
    expect(clearSessionTitle(dir)).toBe(true);
    expect(clearSessionTitle(dir)).toBe(false);
  });

  it('写入标题不改动 session.v1.jsonl（字节不变）', () => {
    const root = tmpDir();
    const { dir, writer } = createSession(root, '/proj/t', '20260914-333333-bb0002');
    writer.append('user/message', { text: 'append only 标题测试' });
    writer.close();
    const log = join(dir, SESSION_LOG_FILE);
    const before = readFileSync(log);
    writeSessionTitle(dir, '标题一', { source: 'auto' });
    writeSessionTitle(dir, '标题二', { source: 'manual' });
    clearSessionTitle(dir);
    expect(readFileSync(log).equals(before)).toBe(true);
  });
});

describe('H-14 autoTitleSession：复用 / 覆盖 / 注入精炼与降级', () => {
  it('无既有标题 → 落启发式（source=auto，basedOnSeq 正确）', async () => {
    const root = tmpDir();
    const { dir, writer } = createSession(root, '/proj/t', '20260914-333333-cc0001');
    writer.append('user/message', { text: '帮我梳理事件溯源日志的读侧容错策略' });
    writer.close();
    const result = await autoTitleSession(dir);
    expect(result.refined).toBe(false);
    expect(result.reused).toBe(false);
    expect(result.title).toMatchObject({ source: 'auto', basedOnSeq: 2 });
    expect(readSessionTitle(dir)?.title).toContain('事件溯源');
  });

  it('既有标题默认复用（人工标题不会被自动标题覆盖）；overwrite 才重算', async () => {
    const root = tmpDir();
    const { dir, writer } = createSession(root, '/proj/t', '20260914-333333-cc0002');
    writer.append('user/message', { text: '原始内容' });
    writer.close();
    writeSessionTitle(dir, '人工标题', { source: 'manual' });
    const reused = await autoTitleSession(dir);
    expect(reused).toMatchObject({ reused: true });
    expect(reused.title.title).toBe('人工标题');
    const forced = await autoTitleSession(dir, { overwrite: true });
    expect(forced.reused).toBe(false);
    expect(forced.title.title).toBe('原始内容');
    expect(forced.title.source).toBe('auto');
  });

  it('注入精炼成功 → source=refined；抛错/空 → 落启发式并登记原因', async () => {
    const root = tmpDir();
    const { dir, writer } = createSession(root, '/proj/t', '20260914-333333-cc0003');
    writer.append('user/message', { text: '请分析会话检索的索引方案' });
    writer.close();
    const refined = await autoTitleSession(dir, { refine: async ({ candidate }) => `【精炼】${candidate}` });
    expect(refined.title.source).toBe('refined');
    expect(refined.title.title).toBe('【精炼】请分析会话检索的索引方案');
    const failed = await autoTitleSession(dir, {
      overwrite: true,
      refine: async () => {
        throw new Error('small provider 超时');
      },
    });
    expect(failed.refined).toBe(false);
    expect(failed.refineFallbackReason).toContain('small provider 超时');
    expect(failed.title.source).toBe('auto');
    const empty = await autoTitleSession(dir, { overwrite: true, refine: async () => '  ' });
    expect(empty.refineFallbackReason).toContain('空标题');
  });
});

describe('H-14 管理器集成', () => {
  it('list 摘要带 title；rename/titleOf/clearTitle/autoTitle 可用', async () => {
    const root = tmpDir();
    const cwd = '/proj/t';
    const { id, writer } = createSession(root, cwd, '20260914-333333-dd0001');
    writer.append('user/message', { text: '实现会话标题的启发式生成' });
    writer.close();
    const mgr = new SessionManager(root);
    expect(mgr.list(cwd)[0]!.title).toBeUndefined();
    mgr.rename(id, '自定义标题', { cwd });
    expect(mgr.titleOf(id, { cwd })?.title).toBe('自定义标题');
    expect(mgr.list(cwd)[0]!.title).toBe('自定义标题');
    const auto = await mgr.autoTitle(id, { cwd, overwrite: true });
    expect(auto.title.source).toBe('auto');
    expect(mgr.titleOf(id, { cwd })?.title).toContain('启发式');
    expect(mgr.clearTitle(id, { cwd })).toBe(true);
    expect(mgr.titleOf(id, { cwd })).toBeNull();
    // 检索命中同时带标题（H-11 与 H-14 协同）
    mgr.rename(id, '检索标题', { cwd });
    const hits = mgr.searchIndexed(cwd, '启发式');
    expect(hits[0]!.title).toBe('检索标题');
  });

  it('已知边界：title.json 不入导出白名单（zip 冻结结构不变）', () => {
    const root = tmpDir();
    const { dir, writer } = createSession(root, '/proj/t', '20260914-333333-dd0002');
    writer.append('user/message', { text: 'export whitelist check' });
    writer.close();
    writeSessionTitle(dir, '不该入包', { source: 'manual' });
    const zip = join(tmpDir(), 'title.zip');
    exportSession(dir, zip);
    const entries = Object.keys(unzipSync(readFileSync(zip)));
    expect(entries).toEqual([SESSION_LOG_FILE]);
    expect(existsSync(join(dir, SESSION_TITLE_FILE))).toBe(true);
  });
});
