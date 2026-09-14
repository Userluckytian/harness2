// 注册表结构测试：23 条全部注册（P3-A 加性扩容 15→23：G-54~G-90 补齐）、shellOnly 标记
// （mode/reasoning/minimal/fullscreen + P3-A 批次 session-info/export/timeline/doctor/
// memory/skills/plugins/mcps）、分组/别名/参数说明、分发行为。
import { describe, expect, it } from 'vitest';
import { CORE_COMMANDS, parseCoreCommand, runCoreCommand } from '../../src/commands/index.js';
import { execCommand, makeRecordingCtx } from './helpers.js';

describe('CORE_COMMANDS 注册表结构', () => {
  it('23 条命令全部注册，id 不带 /，声明顺序按 group 聚簇（P3-A 加性：G-54~G-90 补齐）', () => {
    expect(CORE_COMMANDS.map((c) => c.id)).toEqual([
      'new',
      'sessions',
      'resume',
      'session-info',
      'fork',
      'export',
      'undo',
      'redo',
      'timeline',
      'help',
      'exit',
      'doctor',
      'skills',
      'plugins',
      'mcps',
      'mode',
      'reasoning',
      'minimal',
      'fullscreen',
      'context',
      'compact',
      'memory',
      'tasks',
    ]);
    for (const c of CORE_COMMANDS) {
      expect(c.id.startsWith('/')).toBe(false);
    }
  });

  it('11 条 core 实现（有 run）；shellOnly 12 条仅元数据（P2-C 4 条 + P3-A 批次 8 条）', () => {
    const shellOnly = CORE_COMMANDS.filter((c) => c.shellOnly === true).map((c) => c.id);
    // 期望顺序 = CORE_COMMANDS 声明顺序（memory 归「上下文」簇，故在 P2-C 模式簇之后）
    expect(shellOnly).toEqual([
      'session-info',
      'export',
      'timeline',
      'doctor',
      'skills',
      'plugins',
      'mcps',
      'mode',
      'reasoning',
      'minimal',
      'fullscreen',
      'memory',
    ]);
    for (const c of CORE_COMMANDS) {
      if (c.shellOnly === true) expect(c.run).toBeUndefined();
      else expect(c.run).toBeTypeOf('function');
    }
    const implemented = CORE_COMMANDS.filter((c) => c.shellOnly !== true).map((c) => c.id);
    expect(implemented).toEqual([
      'new',
      'sessions',
      'resume',
      'fork',
      'undo',
      'redo',
      'help',
      'exit',
      'context',
      'compact',
      'tasks',
    ]);
  });

  it('别名注册：help↔?、exit↔quit、fullscreen↔full、new↔clear（G-54）、undo↔rewind（G-61）、session-info↔status/info（G-59）、doctor↔terminal-*（G-85）', () => {
    expect(CORE_COMMANDS.find((c) => c.id === 'help')?.aliases).toEqual(['?']);
    expect(CORE_COMMANDS.find((c) => c.id === 'exit')?.aliases).toEqual(['quit']);
    expect(CORE_COMMANDS.find((c) => c.id === 'fullscreen')?.aliases).toEqual(['full']);
    expect(CORE_COMMANDS.find((c) => c.id === 'new')?.aliases).toEqual(['clear']);
    expect(CORE_COMMANDS.find((c) => c.id === 'undo')?.aliases).toEqual(['rewind']);
    expect(CORE_COMMANDS.find((c) => c.id === 'session-info')?.aliases).toEqual(['status', 'info']);
    expect(CORE_COMMANDS.find((c) => c.id === 'doctor')?.aliases).toEqual([
      'terminal-setup',
      'terminal-check',
      'terminal-info',
    ]);
  });

  it('每条命令有中文 summary；带参命令有 argsSpec', () => {
    for (const c of CORE_COMMANDS) {
      expect(c.summary.length).toBeGreaterThan(0);
    }
    const withArgs = CORE_COMMANDS.filter((c) => c.argsSpec !== undefined).map((c) => c.id);
    expect(withArgs).toEqual(['sessions', 'resume', 'fork', 'export', 'undo', 'mode', 'reasoning', 'compact']);
    expect(CORE_COMMANDS.find((c) => c.id === 'undo')?.argsSpec).toBe('[n] [--dry-run]');
  });

  it('分组按语义：会话/历史/通用/模式/上下文/调度（P3-A 声明顺序聚簇）', () => {
    const groupOf = (id: string): string | undefined => CORE_COMMANDS.find((c) => c.id === id)?.group;
    for (const id of ['new', 'sessions', 'resume', 'session-info', 'fork', 'export']) expect(groupOf(id)).toBe('会话');
    for (const id of ['undo', 'redo', 'timeline']) expect(groupOf(id)).toBe('历史');
    for (const id of ['help', 'exit', 'doctor', 'skills', 'plugins', 'mcps']) expect(groupOf(id)).toBe('通用');
    for (const id of ['mode', 'reasoning', 'minimal', 'fullscreen']) expect(groupOf(id)).toBe('模式');
    for (const id of ['context', 'compact', 'memory']) expect(groupOf(id)).toBe('上下文');
    expect(groupOf('tasks')).toBe('调度');
  });
});

describe('runCoreCommand 分发', () => {
  it('未知命令 → 逐字「未知命令 /nope（/help 查看命令列表）」', async () => {
    const ctx = makeRecordingCtx();
    const parsed = parseCoreCommand('/nope x');
    expect(parsed).not.toBeNull();
    const r = runCoreCommand(parsed!, ctx);
    expect(r).toBeUndefined(); // 未知命令同步输出
    expect(ctx.lines).toEqual(['未知命令 /nope（/help 查看命令列表）']);
  });

  it('shellOnly 命令 → 如实声明由界面层实现（不画饼）', () => {
    const ctx = makeRecordingCtx();
    const parsed = parseCoreCommand('/mode');
    expect(parsed?.id).toBe('mode');
    const r = runCoreCommand(parsed!, ctx);
    expect(r).toBeUndefined(); // shellOnly 拦截也是同步
    expect(ctx.lines).toEqual(['error: 命令 /mode 由界面层实现（shellOnly），core 未提供执行体']);
  });

  it('P3-A 新注册的 shellOnly 命令同样走 shellOnly 拦截（/export 抽查）', () => {
    const ctx = makeRecordingCtx();
    const parsed = parseCoreCommand('/export');
    expect(parsed?.id).toBe('export');
    const r = runCoreCommand(parsed!, ctx);
    expect(r).toBeUndefined();
    expect(ctx.lines).toEqual(['error: 命令 /export 由界面层实现（shellOnly），core 未提供执行体']);
  });

  it('别名可分发：/? 输出帮助、/quit 请求退出、/clear→new、/rewind→undo（P3-A）', async () => {
    const helpCtx = makeRecordingCtx();
    await execCommand('/?', helpCtx);
    expect(helpCtx.lines.length).toBe(1);
    expect(helpCtx.lines[0]).toContain('命令：');

    const quitCtx = makeRecordingCtx();
    await execCommand('/quit', quitCtx);
    expect(quitCtx.exitCalls.count).toBe(1);

    const clearCtx = makeRecordingCtx();
    await execCommand('/clear', clearCtx);
    expect(clearCtx.switched).toEqual([null]);

    const rewindCtx = makeRecordingCtx();
    await execCommand('/rewind', rewindCtx);
    expect(rewindCtx.lines).toEqual(['error: 无活动会话']); // /undo 的录制缝缺省无会话
  });

  it('旧 8 条命令保持同步语义（run 返回非 Promise）', () => {
    const ctx = makeRecordingCtx();
    for (const id of ['new', 'resume', 'sessions', 'fork', 'undo', 'redo', 'help', 'exit']) {
      const cmd = CORE_COMMANDS.find((c) => c.id === id);
      expect(cmd?.run).toBeTypeOf('function');
      // 同步调用（不 await）：抛错即失败
      const r = cmd!.run!(ctx, { rest: '' });
      expect(r).not.toBeInstanceOf(Promise);
    }
  });
});
