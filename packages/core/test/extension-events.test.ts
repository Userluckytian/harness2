// D02 事件类型开放化测试：扩展事件类型注册表 + writer 接受 + reader 解析 +
// 投影 opaque 通道 + 回放确定性 + rewind 互操作 + 崩溃恢复 + 测试隔离。
// 红线对照：内建 11 种行为零变化（parseEventLine 对扩展类型仍返回 null）；
// 扩展事件同样「落盘才可见」（append-only + 单一写入者不变）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionWriter,
  computeProjection,
  exportAllEvents,
  forkSession,
  loadSession,
  parseExtensionEventLine,
  extensionEventTypes,
  ExtensionEventTypeRegistry,
  defaultSessionsRoot,
  SessionManager,
} from '../src/index.js';
import { SESSION_LOG_FILE, parseEventLine, type SessionEventType } from '../src/session/types.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-ext-events-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 进程级单例：每个用例前后清场（注册表生命周期立场的测试隔离面）
beforeEach(() => {
  extensionEventTypes.reset();
});
afterEach(() => {
  extensionEventTypes.reset();
});

/** 标准测试扩展类型：payload 需含非空 note 字符串 */
function registerNoteType(registry: ExtensionEventTypeRegistry = extensionEventTypes): void {
  registry.register({
    type: 'ui/note',
    validator: (p) => typeof p.note === 'string' && p.note.length > 0,
    projection: 'opaque',
  });
}

function logLines(dir: string): string[] {
  return readFileSync(join(dir, SESSION_LOG_FILE), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
}

describe('ExtensionEventTypeRegistry（注册表单元）', () => {
  it('register/has/get/types：注册后可查，types 保持注册顺序', () => {
    registerNoteType();
    extensionEventTypes.register({ type: 'flow/state', validator: () => true });
    expect(extensionEventTypes.has('ui/note')).toBe(true);
    expect(extensionEventTypes.has('flow/state')).toBe(true);
    expect(extensionEventTypes.has('user/message')).toBe(false); // 内建不在本注册表
    expect(extensionEventTypes.types()).toEqual(['ui/note', 'flow/state']);
    expect(extensionEventTypes.get('ui/note')?.projection).toBe('opaque');
  });

  it('重名注册（扩展间）→ 抛明确错误（fail-closed）', () => {
    registerNoteType();
    expect(() => registerNoteType()).toThrow(/already registered/);
  });

  it('与内建 11 种重名 → 抛错（内建不可覆盖）', () => {
    expect(() => extensionEventTypes.register({ type: 'user/message', validator: () => true })).toThrow(
      /collides with builtin/,
    );
    expect(() => extensionEventTypes.register({ type: 'rewind/marker', validator: () => true })).toThrow(
      /collides with builtin/,
    );
  });

  it('非法定义 → 抛错（空名/含空白/validator 非函数/非法 projection）', () => {
    expect(() => extensionEventTypes.register({ type: '', validator: () => true })).toThrow(
      /invalid extension event type/,
    );
    expect(() => extensionEventTypes.register({ type: 'a b', validator: () => true })).toThrow(
      /invalid extension event type/,
    );
    expect(() =>
      extensionEventTypes.register({ type: 'ok/type', validator: 'nope' as unknown as () => boolean }),
    ).toThrow(/validator must be a function/);
    expect(() =>
      extensionEventTypes.register({
        type: 'ok/type',
        validator: () => true,
        projection: 'eager' as unknown as 'opaque',
      }),
    ).toThrow(/projection must be 'opaque'/);
  });

  it('unregister：注销后 has=false，未注册返回 false（幂等）；独立实例互不影响', () => {
    registerNoteType();
    expect(extensionEventTypes.unregister('ui/note')).toBe(true);
    expect(extensionEventTypes.has('ui/note')).toBe(false);
    expect(extensionEventTypes.unregister('ui/note')).toBe(false);

    const isolated = new ExtensionEventTypeRegistry();
    isolated.register({ type: 'ui/note', validator: () => true });
    expect(isolated.has('ui/note')).toBe(true);
    expect(extensionEventTypes.has('ui/note')).toBe(false); // 单例未被波及
  });

  it('reset：清空全部扩展注册，内建白名单不受影响（测试隔离面）', () => {
    registerNoteType();
    extensionEventTypes.reset();
    expect(extensionEventTypes.types()).toEqual([]);
    expect(extensionEventTypes.has('user/message')).toBe(false); // 内建不归本注册表管
  });
});

describe('parseExtensionEventLine（解析层）', () => {
  it('已注册类型：信封齐全 + validator 通过 → 解析出扩展事件', () => {
    registerNoteType();
    const line = JSON.stringify({
      v: 1,
      seq: 7,
      ts: '2026-10-11T00:00:00.000Z',
      type: 'ui/note',
      payload: { note: 'hello' },
    });
    const e = parseExtensionEventLine(line);
    expect(e).not.toBeNull();
    expect(e?.type).toBe('ui/note');
    expect(e?.seq).toBe(7);
    expect(e?.payload).toEqual({ note: 'hello' });
  });

  it('validator 拒绝 / 未注册类型 / 内建类型 / 信封残缺 → null（现状：跳过+告警）', () => {
    registerNoteType();
    const envelope = (over: Record<string, unknown>): string =>
      JSON.stringify({
        v: 1,
        seq: 1,
        ts: '2026-10-11T00:00:00.000Z',
        type: 'ui/note',
        payload: { note: 'x' },
        ...over,
      });
    expect(parseExtensionEventLine(JSON.stringify({ type: 'ui/note', payload: {} }))).toBeNull(); // validator 拒
    expect(parseExtensionEventLine(envelope({ payload: { note: '' } }))).toBeNull();
    expect(parseExtensionEventLine(envelope({ type: 'ghost/type' }))).toBeNull(); // 未注册
    expect(parseExtensionEventLine(envelope({ type: 'user/message' }))).toBeNull(); // 内建不归本解析
    expect(parseExtensionEventLine(envelope({ v: 2 }))).toBeNull(); // 代际不对
    expect(parseExtensionEventLine(envelope({ ts: 123 }))).toBeNull();
    expect(parseExtensionEventLine('not json')).toBeNull();
  });

  it('内建 parseEventLine 行为零变化：对扩展类型仍返回 null（跳过+告警路径不变）', () => {
    registerNoteType();
    const line = JSON.stringify({
      v: 1,
      seq: 1,
      ts: '2026-10-11T00:00:00.000Z',
      type: 'ui/note',
      payload: { note: 'hello' },
    });
    expect(parseEventLine(line)).toBeNull();
  });
});

describe('SessionWriter.appendExtension（写侧）', () => {
  it('注册后写扩展事件：信封与 seq 空间和内建一致（v/seq/ts 同机制）', () => {
    registerNoteType();
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1', cwd: 'D:/x' }, { fsync: false });
    const u = w.append('user/message', { text: 'u1' });
    const ext = w.appendExtension('ui/note', { note: 'marked' });
    expect(ext.seq).toBe(u.seq + 1);
    expect(ext.v).toBe(1);
    expect(typeof ext.ts).toBe('string');
    w.append('assistant/message', { text: 'a1' });
    w.close();
    const lines = logLines(dir);
    expect(lines).toHaveLength(4); // header + u1 + ext + a1（同一日志、同一 seq 空间）
    expect(JSON.parse(lines[2]!).type).toBe('ui/note');
  });

  it('未注册类型写扩展 → 抛错；validator 拒绝 → 抛错（写入口 fail-closed）', () => {
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1', cwd: 'D:/x' }, { fsync: false });
    expect(() => w.appendExtension('ghost/type', {})).toThrow(/unknown extension event type/);
    registerNoteType();
    expect(() => w.appendExtension('ui/note', { note: '' })).toThrow(/invalid extension event payload/);
    w.close();
  });

  it('append() 写扩展类型拒（内建白名单不变），错误信息给明确指引', () => {
    registerNoteType();
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1', cwd: 'D:/x' }, { fsync: false });
    const bogus = 'ui/note' as SessionEventType;
    expect(() => w.append(bogus, { note: 'x' } as never)).toThrow(/use appendExtension/);
    const ghost = 'ghost/type' as SessionEventType;
    expect(() => w.append(ghost, {} as never)).toThrow(/unknown event type/);
    w.close();
  });
});

describe('事件溯源全链路：注册 → 写 → 读 → 重放 → 投影（opaque 通道）', () => {
  it('读回拆双通道：内建 events 不变，扩展进 extensionEvents；投影 opaqueEvents 可见且不崩', () => {
    registerNoteType();
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1', cwd: 'D:/x' }, { fsync: false });
    w.append('user/message', { text: 'u1', turnId: 't1' });
    w.appendExtension('ui/note', { note: 'n1' });
    w.append('assistant/message', { text: 'a1', turnId: 't1' });
    w.appendExtension('ui/note', { note: 'n2' });
    w.close();

    const s = loadSession(dir);
    expect(s.warnings).toEqual([]); // 已注册类型不是非法行
    expect(s.events.map((x) => x.event.type)).toEqual(['session/header', 'user/message', 'assistant/message']);
    expect(s.extensionEvents.map((x) => x.event.payload)).toEqual([{ note: 'n1' }, { note: 'n2' }]);

    const p = computeProjection(s);
    expect(p.messages.map((m) => m.text)).toEqual(['u1', 'a1']); // 消息投影不含扩展事件
    expect(p.opaqueEvents.map((o) => o.type)).toEqual(['ui/note', 'ui/note']);
    expect(p.opaqueEvents.map((o) => o.seq)).toEqual([3, 5]);
    expect(p.opaqueEvents[0]?.payload).toEqual({ note: 'n1' });
    // 计数口径：内建通道计数不变（header + u1 + a1 = 3），扩展走 opaque 独立列表
    expect(p.activeCount).toBe(3);
    expect(p.shadowedCount).toBe(0);
    expect(p.lastSeq).toBe(5);
  });

  it('回放确定性：日志逐行重解析重建双通道，投影与直接读取逐字段一致', () => {
    registerNoteType();
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1', cwd: 'D:/x' }, { fsync: false });
    w.append('user/message', { text: 'u1' });
    w.appendExtension('ui/note', { note: 'n1' });
    w.append('assistant/message', { text: 'a1' });
    w.append('rewind/marker', { rewindToSeq: 1, reason: 'undo' });
    w.append('user/message', { text: 'u2-alt' });
    w.close();

    const direct = computeProjection(loadSession(dir));
    // 回放：逐行重解析（内建/扩展两级），按解析结果拆双通道重建 LoadedSession
    const lines = logLines(dir);
    const events = lines
      .map((l) => parseEventLine(l))
      .filter((e) => e !== null)
      .map((e) => ({ event: e, active: true }));
    const extensionEvents = lines
      .map((l) => parseExtensionEventLine(l))
      .filter((e) => e !== null)
      .map((e) => ({ event: e, active: true }));
    expect(events).toHaveLength(5); // header + u1 + a1 + marker + u2-alt
    expect(extensionEvents).toHaveLength(1);
    const replayed = computeProjection({
      dir: 'replay',
      header: null,
      events,
      extensionEvents,
      warnings: [],
    });
    expect(replayed.messages).toEqual(direct.messages);
    expect(replayed.opaqueEvents).toEqual(direct.opaqueEvents);
    expect(replayed.activeCount).toBe(direct.activeCount);
    expect(replayed.shadowedCount).toBe(direct.shadowedCount);
    expect(replayed.lastSeq).toBe(direct.lastSeq);
    expect(replayed.rewindCount).toBe(direct.rewindCount);
  });

  it('未注册（未注册即未知）维持现状：loadSession 告警跳过；open 恢复路径按撕裂行截断（既有坏行策略）', () => {
    const dir = tmpDir();
    registerNoteType();
    const w = SessionWriter.create(dir, { sessionId: 's1', cwd: 'D:/x' }, { fsync: false });
    w.append('user/message', { text: 'u1' });
    w.appendExtension('ui/note', { note: 'n1' });
    w.close();

    // 注销后读：退回未知类型（null + 告警），消息投影不受影响
    extensionEventTypes.unregister('ui/note');
    const s = loadSession(dir);
    expect(s.extensionEvents).toEqual([]);
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toContain('skipped invalid line');
    expect(computeProjection(s).messages.map((m) => m.text)).toEqual(['u1']);

    // writer 打开：未注册扩展行按既有坏行策略处理——恢复路径视为未提交撕裂行截断
    // （与旧版未知 type 行为逐字节一致），截断后按最后合法 seq 续排
    const w2 = SessionWriter.open(dir, { fsync: false });
    expect(w2.recoveredBytes).toBeGreaterThan(0);
    expect(w2.lastSeq).toBe(2); // header + u1（扩展行已被截断）
    w2.close();
  });
});

describe('rewind 互操作（遮蔽窗口对扩展事件同等生效）', () => {
  it('rewind 遮蔽窗口内的扩展事件转影子（opaqueEvents 不含），消息与计数口径不变', () => {
    registerNoteType();
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1', cwd: 'D:/x' }, { fsync: false });
    w.append('user/message', { text: 'u1', turnId: 't1' }); // 2
    w.appendExtension('ui/note', { note: 'n1' }); // 3
    w.append('assistant/message', { text: 'a1', turnId: 't1' }); // 4
    w.append('rewind/marker', { rewindToSeq: 1, reason: 'undo t1' }); // 5：遮蔽 2..4（含扩展 seq3）
    w.append('user/message', { text: 'u2-alt' }); // 6：新分支
    w.close();

    const p = computeProjection(loadSession(dir));
    expect(p.messages.map((m) => m.text)).toEqual(['u2-alt']);
    expect(p.opaqueEvents).toEqual([]); // seq3 在遮蔽窗口内 → 不进 opaque 投影
    const s = loadSession(dir);
    computeProjection(s); // 活动性由投影计算就地回填（loadSession 不代算，与内建同口径）
    const ext = s.extensionEvents[0]!;
    expect(ext.active).toBe(false); // 影子保留可导出
    expect(s.warnings).toEqual([]);
    expect(exportAllEvents(s).split('\n')).toHaveLength(6); // append-only：影子不删
  });

  it('redo 中立化对扩展事件同构：被重做 undo 标记的遮蔽解除后扩展事件复活', () => {
    registerNoteType();
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1', cwd: 'D:/x' }, { fsync: false });
    w.append('user/message', { text: 'u1' }); // 2
    w.appendExtension('ui/note', { note: 'n1' }); // 3
    w.append('rewind/marker', { rewindToSeq: 1, reason: 'undo' }); // 4：遮蔽 2..3
    w.append('rewind/marker', { rewindToSeq: 3, reason: 'redo' }); // 5：中立化 seq4 标记 → 复活 2..3
    w.close();

    const p = computeProjection(loadSession(dir));
    expect(p.messages.map((m) => m.text)).toEqual(['u1']);
    expect(p.opaqueEvents.map((o) => o.seq)).toEqual([3]); // 扩展事件随链复活
  });
});

describe('崩溃恢复与打开（扩展行按已提交处理）', () => {
  it('open() 重开：已提交扩展行保留、seq 续排；末尾撕裂扩展行截断', () => {
    registerNoteType();
    const dir = tmpDir();
    const w = SessionWriter.create(dir, { sessionId: 's1', cwd: 'D:/x' }, { fsync: false });
    w.appendExtension('ui/note', { note: 'committed' });
    w.close();
    // 模拟崩溃撕裂：半行（无换行）
    appendFileSync(join(dir, SESSION_LOG_FILE), '{"v":1,"seq":3,"ts":"x","type":"ui/note","payl');
    const w2 = SessionWriter.open(dir, { fsync: false });
    expect(w2.recoveredBytes).toBeGreaterThan(0);
    expect(w2.lastSeq).toBe(2); // header + 已提交扩展行
    const ext2 = w2.appendExtension('ui/note', { note: 'after-reopen' });
    expect(ext2.seq).toBe(3);
    w2.close();
    const s = loadSession(dir);
    expect(s.extensionEvents.map((x) => x.event.payload)).toEqual([{ note: 'committed' }, { note: 'after-reopen' }]);
  });
});

describe('fork 携带扩展事件（重放保真）', () => {
  it('活动扩展事件随分叉复制（按原 seq 归并、新 seq 续排）；atSeq 截取同口径', () => {
    registerNoteType();
    const root = tmpDir();
    const manager = new SessionManager(defaultSessionsRoot(root));
    const { id, writer } = manager.create(root);
    writer.append('user/message', { text: 'u1', turnId: 't1' }); // 2
    writer.appendExtension('ui/note', { note: 'n1' }); // 3
    writer.append('assistant/message', { text: 'a1', turnId: 't1' }); // 4
    writer.close();

    const forked = forkSession(manager, id);
    expect(forked.copiedEvents).toBe(3); // u1 + 扩展 + a1（不含新会话自身 header）
    const child = loadSession(forked.dir);
    expect(child.events.map((x) => x.event.type)).toEqual(['session/header', 'user/message', 'assistant/message']);
    expect(child.extensionEvents.map((x) => x.event.seq)).toEqual([3]); // 原 seq3 位置保持
    expect(child.extensionEvents[0]?.event.payload).toEqual({ note: 'n1' });

    // atSeq=2 截取：扩展 seq3 不复制
    const cut = forkSession(manager, id, { atSeq: 2 });
    const cutSession = loadSession(cut.dir);
    expect(cutSession.events.map((x) => x.event.type)).toEqual(['session/header', 'user/message']);
    expect(cutSession.extensionEvents).toEqual([]);
    expect(cut.copiedEvents).toBe(1);
  });
});
