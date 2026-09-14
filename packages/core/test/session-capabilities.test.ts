// H-11～H-14 三壳入口缝测试：命令元数据（H 编号 + 核心落点）与 runSessionCapability 分发。
// 目的：把「能力已在 core、但壳还没接线」这半边的契约钉死——壳只需注册元数据 + 调用本分发器。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/session/manager.js';
import type { SessionWriter } from '../src/session/writer.js';
import { SESSION_LOG_FILE } from '../src/session/types.js';
import { loadSession } from '../src/session/reader.js';
import { exportSession } from '../src/session/export.js';
import {
  SESSION_CAPABILITY_COMMANDS,
  runSessionCapability,
  type SessionCapabilityContext,
} from '../src/session/capabilities.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-cap-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Harness {
  ctx: SessionCapabilityContext;
  lines: string[];
  dir: string;
  writer: SessionWriter;
  root: string;
  cwd: string;
}

/** 造一个带活动会话的上下文（每轮 user/assistant，含工具调用） */
function makeHarness(turns = 4): Harness {
  const root = tmpDir();
  const cwd = '/proj/cap';
  const manager = new SessionManager(root);
  const created = manager.create(cwd, { id: '20260914-444444-aa0001', fsync: false });
  const writer = created.writer;
  for (let i = 1; i <= turns; i++) {
    writer.append('user/message', { text: `第 ${i} 轮：请分析 quantum 模块 ${i} 与索引方案`, turnId: `t${i}` });
    writer.append('tool/call', { callId: `c${i}`, tool: 'read', args: {}, turnId: `t${i}` });
    writer.append('tool/result', { callId: `c${i}`, tool: 'read', ok: true, output: `out ${i}`, turnId: `t${i}` });
    writer.append('assistant/message', { text: `第 ${i} 轮结论`, turnId: `t${i}` });
  }
  const lines: string[] = [];
  const ctx: SessionCapabilityContext = {
    manager,
    cwd,
    print: (t) => lines.push(t),
    current: () => ({ id: '20260914-444444-aa0001', writer }),
  };
  return { ctx, lines, dir: writer.dir, writer, root, cwd };
}

describe('入口元数据（可发现性契约）', () => {
  it('5 条命令覆盖 H-11～H-14，id 唯一且都标注核心落点', () => {
    const ids = SESSION_CAPABILITY_COMMANDS.map((c) => c.id);
    expect(ids).toEqual(['search', 'reindex', 'import', 'title', 'compact-layers']);
    expect(new Set(ids).size).toBe(ids.length);
    const caps = new Set(SESSION_CAPABILITY_COMMANDS.map((c) => c.capability));
    expect([...caps].sort()).toEqual(['H-11', 'H-12', 'H-13', 'H-14']);
    for (const cmd of SESSION_CAPABILITY_COMMANDS) {
      expect(cmd.entry).toMatch(/^session\/[\w-]+\.ts#/);
      expect(cmd.summary.length).toBeGreaterThan(0);
      expect(['会话', '上下文']).toContain(cmd.group);
    }
  });

  it('未识别的命令 id → false（壳转交既有命令表，不抛错）', async () => {
    const { ctx } = makeHarness(1);
    expect(await runSessionCapability('nope', { rest: '' }, ctx)).toBe(false);
  });
});

describe('/search 与 /reindex（H-11）', () => {
  it('检索命中打印会话行与片段；未命中打印「无命中」', async () => {
    const h = makeHarness(2);
    await runSessionCapability('search', { rest: 'quantum' }, h.ctx);
    expect(h.lines[0]).toContain('命中 1 个会话');
    expect(h.lines.join('\n')).toContain('[user@2]');
    h.lines.length = 0;
    await runSessionCapability('search', { rest: '根本不存在的词' }, h.ctx);
    expect(h.lines[0]).toContain('无命中');
    h.lines.length = 0;
    await runSessionCapability('search', { rest: '' }, h.ctx);
    expect(h.lines[0]).toContain('error: 用法 /search');
    h.writer.close();
  });

  it('--or 放宽语义，--limit 限制条数；注入摘要 provider 时打印 LLM 摘要', async () => {
    const h = makeHarness(2);
    h.ctx.summarizeSearch = async ({ hits }) => `共 ${hits.length} 条命中摘要`;
    await runSessionCapability('search', { rest: 'quantum --or --limit 1' }, h.ctx);
    expect(h.lines.join('\n')).toContain('摘要：共');
    // 摘掉注入方再搜：必须出现显式降级行
    h.lines.length = 0;
    h.ctx.summarizeSearch = undefined;
    await runSessionCapability('search', { rest: 'quantum' }, h.ctx);
    expect(h.lines.join('\n')).toContain('未注入摘要 provider');
    h.writer.close();
  });

  it('未注入摘要 provider 时如实降级为原文片段（不伪造摘要）', async () => {
    const h = makeHarness(1);
    await runSessionCapability('search', { rest: 'quantum' }, h.ctx);
    expect(h.lines.join('\n')).toContain('以上为命中原文片段');
    h.writer.close();
  });

  it('/reindex 打印重建统计', async () => {
    const h = makeHarness(1);
    await runSessionCapability('reindex', { rest: '' }, h.ctx);
    expect(h.lines[0]).toContain('索引重建：');
    h.writer.close();
  });
});

describe('/import（H-13）', () => {
  it('导入真实 zip 打印逐会话状态；坏路径打印 error 行（不抛错）', async () => {
    const h = makeHarness(1);
    h.writer.close();
    const zip = join(tmpDir(), 'cap.zip');
    exportSession(h.dir, zip);
    await runSessionCapability('import', { rest: `${zip} --dry-run` }, h.ctx);
    expect(h.lines[0]).toContain('导入 cap.zip');
    expect(h.lines.join('\n')).toContain('[planned]');
    h.lines.length = 0;
    await runSessionCapability('import', { rest: join(h.root, 'missing.zip') }, h.ctx);
    expect(h.lines[0]).toContain('error: 导入失败');
    h.lines.length = 0;
    await runSessionCapability('import', { rest: '' }, h.ctx);
    expect(h.lines[0]).toContain('error: 用法 /import');
  });
});

describe('/title（H-14）', () => {
  it('无标题时提示生成方式；设置后读取；--auto 生成并可用注入精炼', async () => {
    const h = makeHarness(1);
    await runSessionCapability('title', { rest: '' }, h.ctx);
    expect(h.lines[0]).toContain('标题：—');
    h.lines.length = 0;
    await runSessionCapability('title', { rest: '手动标题' }, h.ctx);
    expect(h.lines[0]).toBe('已设置标题：手动标题');
    h.lines.length = 0;
    await runSessionCapability('title', { rest: '' }, h.ctx);
    expect(h.lines[0]).toContain('手动标题');
    h.lines.length = 0;
    h.ctx.refineTitle = async ({ candidate }) => `精炼：${candidate}`;
    await runSessionCapability('title', { rest: '--auto' }, h.ctx);
    expect(h.lines[0]).toContain('精炼：');
    h.writer.close();
    expect(readFileSync(join(h.dir, SESSION_LOG_FILE), 'utf8')).toContain('第 1 轮'); // 事实源未被标题写入污染
  });

  it('精炼失败时提示回退原因（如实登记）', async () => {
    const h = makeHarness(1);
    h.ctx.refineTitle = async () => {
      throw new Error('provider 未配置');
    };
    await runSessionCapability('title', { rest: '--auto' }, h.ctx);
    expect(h.lines.join('\n')).toContain('精炼未生效（provider 未配置）');
    h.writer.close();
  });
});

describe('/compact-layers（H-12）', () => {
  it('达阈值 → 执行分层压缩并打印层与覆盖范围；事件按既有形状落盘', async () => {
    const h = makeHarness(4);
    h.ctx.contextUsage = () => 0.9;
    await runSessionCapability('compact-layers', { rest: '' }, h.ctx);
    expect(h.lines[0]).toContain('已执行分层压缩（session 层）');
    const session = loadSession(h.dir);
    const last = session.events.at(-1)!.event;
    expect(last.type).toBe('compaction/applied');
    h.writer.close();
  });

  it('未达阈值 → 如实输出未执行；非法层参数 → error 行', async () => {
    const h = makeHarness(4);
    h.ctx.contextUsage = () => 0.1;
    await runSessionCapability('compact-layers', { rest: '' }, h.ctx);
    expect(h.lines[0]).toContain('未执行压缩');
    h.lines.length = 0;
    await runSessionCapability('compact-layers', { rest: 'bogus' }, h.ctx);
    expect(h.lines[0]).toContain('error: 用法 /compact-layers');
    h.lines.length = 0;
    await runSessionCapability('compact-layers', { rest: 'turn' }, h.ctx);
    expect(h.lines[0]).toContain('turn 层');
    h.writer.close();
  });

  it('无活动会话 → error 行（不抛错）', async () => {
    const h = makeHarness(1);
    h.writer.close();
    const ctx: SessionCapabilityContext = { ...h.ctx, current: () => null };
    await runSessionCapability('compact-layers', { rest: '' }, ctx);
    expect(h.lines[0]).toContain('error: 无活动会话');
    h.lines.length = 0;
    await runSessionCapability('title', { rest: '' }, ctx);
    expect(h.lines[0]).toContain('error: 无活动会话');
  });
});
