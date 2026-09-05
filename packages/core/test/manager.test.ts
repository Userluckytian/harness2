// 会话管理器测试：cwd 编码规则 / 全局布局 / list 排序与摘要 / search 命中 / resume 续写。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSessionsRoot, encodeCwd, SessionManager } from '../src/session/manager.js';
import { SESSION_LOG_FILE } from '../src/session/types.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-mgr-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造一个带若干消息的会话并关闭 */
function makeSession(mgr: SessionManager, cwd: string, userTexts: string[], assistantTexts: string[]): string {
  const { id, writer } = mgr.create(cwd, { fsync: false });
  for (let i = 0; i < userTexts.length; i++) {
    writer.append('user/message', { text: userTexts[i]! });
    const a = assistantTexts[i];
    if (a !== undefined) writer.append('assistant/message', { text: a });
  }
  writer.close();
  return id;
}

function setMtime(dir: string, ms: number): void {
  const log = join(dir, SESSION_LOG_FILE);
  const t = new Date(ms);
  utimesSync(log, t, t);
}

describe('encodeCwd 编码规则', () => {
  it('盘符冒号丢弃、路径分隔符替换为 --（D:\\a\\b → D--a--b）', () => {
    expect(encodeCwd('D:\\a\\b')).toBe('D--a--b');
    expect(encodeCwd('C:\\')).toBe('C--');
    expect(encodeCwd('/home/u')).toBe('--home--u');
    expect(encodeCwd('/var/log/app.d')).toBe('--var--log--app.d');
  });

  it('安全字符原样保留；其余字符逐个替换（不合并连续）', () => {
    expect(encodeCwd('abc-1_2.3')).toBe('abc-1_2.3');
    expect(encodeCwd('a b\\c')).toBe('a-b--c'); // 空格 → -，分隔符 → --
    expect(encodeCwd('项目')).toBe('--'); // 非 ASCII 逐字替换
  });

  it('纯字符串映射：任何平台对同一字符串结果一致', () => {
    // 不做 resolve/平台路径解析，manager 层负责先 resolve
    expect(encodeCwd('X:/y/z')).toBe('X--y--z');
  });
});

describe('create / 全局布局', () => {
  it('create 建立嵌套目录与 header（sessionId/cwd/createdAt），~/.harness2 链自动创建', () => {
    const root = tmpDir('h2-mgr-root-'); // 模拟 ~/.harness2/sessions
    const cwd = tmpDir('h2-mgr-cwd-');
    const mgr = new SessionManager(root);
    const { id, dir, writer } = mgr.create(cwd, { fsync: false });

    expect(dir).toBe(join(root, encodeCwd(cwd), id));
    expect(existsSync(join(dir, SESSION_LOG_FILE))).toBe(true);
    const header = writer.append('user/message', { text: 'hi' }); // 顺手验证可写
    expect(header.seq).toBe(2);
    writer.close();

    const resumed = mgr.resume(id, { cwd, fsync: false });
    expect(resumed.header).toMatchObject({ sessionId: id, cwd });
    resumed.writer.close();
  });

  it('create id 格式：UTC 时间戳 + 随机后缀，两次生成不同', () => {
    const mgr = new SessionManager(tmpDir('h2-mgr-root-'));
    const cwd = tmpDir();
    const a = mgr.create(cwd, { fsync: false });
    const b = mgr.create(cwd, { fsync: false });
    expect(a.id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);
    expect(b.id).not.toBe(a.id);
    a.writer.close();
    b.writer.close();
  });

  it('defaultSessionsRoot 默认挂用户 home 的 .harness2/sessions', () => {
    expect(defaultSessionsRoot()).toContain(join('.harness2', 'sessions'));
    expect(defaultSessionsRoot('/tmp/h')).toBe(join('/tmp/h', '.harness2', 'sessions'));
  });
});

describe('list / 摘要 / 排序', () => {
  it('list 按 mtime 倒序；摘要含首条用户消息(≤60)/消息数/lastSeq', () => {
    const root = tmpDir('h2-mgr-root-');
    const cwd = tmpDir('h2-mgr-cwd-');
    const mgr = new SessionManager(root);
    const id1 = makeSession(mgr, cwd, ['第一条消息'], ['回复一']);
    const id2 = makeSession(mgr, cwd, ['第二条 '.padEnd(80, '长') + '超限内容应被截断'], []);

    const group = join(root, encodeCwd(cwd));
    setMtime(join(group, id1), 1_000);
    setMtime(join(group, id2), 2_000);

    const list = mgr.list(cwd);
    expect(list.map((s) => s.id)).toEqual([id2, id1]); // mtime 倒序
    expect(list[1]!.firstUserText).toBe('第一条消息');
    expect(list[1]!.messageCount).toBe(2);
    expect(list[1]!.lastSeq).toBe(3);
    expect(list[0]!.firstUserText.length).toBeLessThanOrEqual(61); // 60 字 + 省略号
    expect(list[0]!.firstUserText.endsWith('…')).toBe(true);
  });

  it('list(cwd) 只列该 cwd 组；无参列全库', () => {
    const root = tmpDir('h2-mgr-root-');
    const cwdA = tmpDir('h2-mgr-a-');
    const cwdB = tmpDir('h2-mgr-b-');
    const mgr = new SessionManager(root);
    makeSession(mgr, cwdA, ['A 的消息'], []);
    makeSession(mgr, cwdA, ['A 的第二条'], []);
    makeSession(mgr, cwdB, ['B 的消息'], []);

    expect(mgr.list(cwdA)).toHaveLength(2);
    expect(mgr.list(cwdB)).toHaveLength(1);
    expect(mgr.list()).toHaveLength(3);
  });

  it('root 不存在时 list 返回空数组', () => {
    const mgr = new SessionManager(join(tmpDir(), 'nonexistent', 'sessions'));
    expect(mgr.list()).toEqual([]);
    expect(mgr.list(tmpDir())).toEqual([]);
  });
});

describe('search 子串搜索', () => {
  it('命中 user 与 assistant 文本（大小写不敏感），返回 ≤3 条摘要片段', () => {
    const root = tmpDir('h2-mgr-root-');
    const cwd = tmpDir('h2-mgr-cwd-');
    const mgr = new SessionManager(root);
    makeSession(mgr, cwd, ['帮我查找 UndoRedo 语义'], ['好的，UndoRedo 已实现']);
    makeSession(mgr, cwd, ['无关消息'], ['无关回复']);

    const hits = mgr.search(cwd, 'undoredo');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.hits).toHaveLength(2);
    expect(hits[0]!.hits[0]).toMatchObject({ role: 'user' });
    expect(hits[0]!.hits[0]!.snippet).toContain('UndoRedo');
    expect(hits[0]!.hits[1]).toMatchObject({ role: 'assistant', seq: 3 });
  });

  it('不命中返回空；空关键字返回空；cwd 过滤生效', () => {
    const root = tmpDir('h2-mgr-root-');
    const cwdA = tmpDir('h2-mgr-a-');
    const cwdB = tmpDir('h2-mgr-b-');
    const mgr = new SessionManager(root);
    makeSession(mgr, cwdA, ['目标文本在这里'], []);

    expect(mgr.search(cwdA, '不存在的内容')).toEqual([]);
    expect(mgr.search(cwdA, '')).toEqual([]);
    expect(mgr.search(cwdB, '目标文本')).toEqual([]); // B 组搜不到 A 组的会话
    expect(mgr.search(undefined, '目标文本')).toHaveLength(1); // 全库可搜到
  });
});

describe('resume 恢复续写', () => {
  it('resume 打开 writer 继续追加，seq 连续', () => {
    const root = tmpDir('h2-mgr-root-');
    const cwd = tmpDir('h2-mgr-cwd-');
    const mgr = new SessionManager(root);
    const id = makeSession(mgr, cwd, ['第一次'], ['回复']);

    const resumed = mgr.resume(id, { fsync: false });
    expect(resumed.header?.sessionId).toBe(id);
    const ev = resumed.writer.append('user/message', { text: '第二次（续写）' });
    expect(ev.seq).toBe(4); // header(1) u(2) a(3) → 下一 seq 4
    resumed.writer.close();

    const list = mgr.list(cwd);
    expect(list[0]!.lastSeq).toBe(4);
    expect(list[0]!.messageCount).toBe(3);
  });

  it('resume 不带 cwd 时全库查找；未知的 id 报清晰错误', () => {
    const root = tmpDir('h2-mgr-root-');
    const cwd = tmpDir('h2-mgr-cwd-');
    const mgr = new SessionManager(root);
    const id = makeSession(mgr, cwd, ['x'], []);

    expect(mgr.resume(id).dir).toBe(join(root, encodeCwd(cwd), id));
    expect(() => mgr.resume('no-such-id')).toThrow(/session not found: no-such-id/);
  });

  it('崩溃残行：open 恢复撕裂尾行（recoveredBytes > 0），列表不受损', () => {
    const root = tmpDir('h2-mgr-root-');
    const cwd = tmpDir('h2-mgr-cwd-');
    const mgr = new SessionManager(root);
    const id = makeSession(mgr, cwd, ['正常消息'], []);
    const log = join(root, encodeCwd(cwd), id, SESSION_LOG_FILE);
    writeFileSync(log, readFileSync(log, 'utf8') + '{"v":1,"seq":9,"ts":"2026', 'utf8'); // 追加撕裂行

    const resumed = mgr.resume(id, { fsync: false });
    expect(resumed.recoveredBytes).toBeGreaterThan(0);
    resumed.writer.close();
    expect(mgr.list(cwd)[0]!.lastSeq).toBe(2); // 撕裂行被丢弃（header+user 共 2 个事件）
  });
});
