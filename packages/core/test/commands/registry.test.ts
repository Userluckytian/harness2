// 注册表结构测试：13 条全部注册、shellOnly 标记（mode/reasoning）、分组/别名/参数说明、分发行为。
import { describe, expect, it } from 'vitest';
import { CORE_COMMANDS, parseCoreCommand, runCoreCommand } from '../../src/commands/index.js';
import { execCommand, makeRecordingCtx } from './helpers.js';

describe('CORE_COMMANDS 注册表结构', () => {
  it('13 条命令全部注册，id 不带 /，声明顺序对齐 cli command-registry', () => {
    expect(CORE_COMMANDS.map((c) => c.id)).toEqual([
      'new',
      'sessions',
      'resume',
      'fork',
      'undo',
      'redo',
      'help',
      'exit',
      'mode',
      'context',
      'compact',
      'reasoning',
      'tasks',
    ]);
    for (const c of CORE_COMMANDS) {
      expect(c.id.startsWith('/')).toBe(false);
    }
  });

  it('11 条 core 实现（有 run）；mode/reasoning 仅元数据（shellOnly，无 run）', () => {
    const shellOnly = CORE_COMMANDS.filter((c) => c.shellOnly === true).map((c) => c.id);
    expect(shellOnly).toEqual(['mode', 'reasoning']);
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

  it('别名注册：help ↔ ?、exit ↔ quit', () => {
    expect(CORE_COMMANDS.find((c) => c.id === 'help')?.aliases).toEqual(['?']);
    expect(CORE_COMMANDS.find((c) => c.id === 'exit')?.aliases).toEqual(['quit']);
  });

  it('每条命令有中文 summary；带参命令有 argsSpec', () => {
    for (const c of CORE_COMMANDS) {
      expect(c.summary.length).toBeGreaterThan(0);
    }
    const withArgs = CORE_COMMANDS.filter((c) => c.argsSpec !== undefined).map((c) => c.id);
    expect(withArgs).toEqual(['sessions', 'resume', 'fork', 'undo', 'mode', 'compact', 'reasoning']);
    expect(CORE_COMMANDS.find((c) => c.id === 'undo')?.argsSpec).toBe('[n] [--dry-run]');
  });

  it('分组按语义：会话/历史/上下文/调度/模式/通用', () => {
    const groupOf = (id: string): string | undefined => CORE_COMMANDS.find((c) => c.id === id)?.group;
    expect(groupOf('new')).toBe('会话');
    expect(groupOf('sessions')).toBe('会话');
    expect(groupOf('resume')).toBe('会话');
    expect(groupOf('fork')).toBe('会话');
    expect(groupOf('undo')).toBe('历史');
    expect(groupOf('redo')).toBe('历史');
    expect(groupOf('context')).toBe('上下文');
    expect(groupOf('compact')).toBe('上下文');
    expect(groupOf('tasks')).toBe('调度');
    expect(groupOf('mode')).toBe('模式');
    expect(groupOf('reasoning')).toBe('模式');
    expect(groupOf('help')).toBe('通用');
    expect(groupOf('exit')).toBe('通用');
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

  it('别名可分发：/? 输出帮助、/quit 请求退出', async () => {
    const helpCtx = makeRecordingCtx();
    await execCommand('/?', helpCtx);
    expect(helpCtx.lines.length).toBe(1);
    expect(helpCtx.lines[0]).toContain('命令：');

    const quitCtx = makeRecordingCtx();
    await execCommand('/quit', quitCtx);
    expect(quitCtx.exitCalls.count).toBe(1);
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
