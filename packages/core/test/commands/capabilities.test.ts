// describeCapabilities 结构测试：命令数=23（P3-A 加性扩容 15→23：G-54~G-90 补齐）、shellOnly 标记、modes 非空、工具表、审批策略摘要。
import { describe, expect, it } from 'vitest';
import { DEFAULT_SAFE_TOOLS } from '../../src/approval/policy.js';
import { describeCapabilities } from '../../src/commands/capabilities.js';
import { APPROVAL_MODES } from '../../src/config/schema.js';
import { builtinTools } from '../../src/tools/predefined/index.js';

describe('describeCapabilities', () => {
  it('commands = 全部 23 条元数据（id/summary/argsSpec 与注册表一致；P3-A 加性）', () => {
    const caps = describeCapabilities();
    expect(caps.commands.length).toBe(23);
    expect(caps.commands.map((c) => c.id)).toEqual([
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
    expect(caps.commands.find((c) => c.id === 'resume')?.summary).toBe('恢复指定会话（/resume <id>）');
    expect(caps.commands.find((c) => c.id === 'undo')?.argsSpec).toBe('[n] [--dry-run]');
    expect(caps.commands.find((c) => c.id === 'new')?.aliases).toEqual(['clear']);
    expect(caps.commands.find((c) => c.id === 'undo')?.aliases).toEqual(['rewind']);
  });

  it('shellOnly 12 条带标记（P2-C 4 条 + P3-A 批次 8 条），其余 11 条不带（core 实现）', () => {
    const caps = describeCapabilities();
    const shellOnly = new Set([
      'mode',
      'reasoning',
      'minimal',
      'fullscreen',
      'session-info',
      'export',
      'timeline',
      'doctor',
      'memory',
      'skills',
      'plugins',
      'mcps',
    ]);
    for (const c of caps.commands) {
      if (shellOnly.has(c.id)) expect(c.shellOnly).toBe(true);
      else expect(c.shellOnly).toBeUndefined();
    }
  });

  it('modes 非空且与 APPROVAL_MODES 四态一一对应（含说明，不重复造枚举）', () => {
    const caps = describeCapabilities();
    expect(caps.modes.length).toBeGreaterThan(0);
    expect(caps.modes.map((m) => m.mode)).toEqual([...APPROVAL_MODES]);
    for (const m of caps.modes) {
      expect(m.description.length).toBeGreaterThan(0);
    }
    const byMode = Object.fromEntries(caps.modes.map((m) => [m.mode, m.description]));
    expect(byMode['default']).toContain('safe=allow');
    expect(byMode['plan']).toContain('deny');
  });

  it('tools 与内置工具表一一对应（名称+说明，不暴露执行体）', () => {
    const caps = describeCapabilities();
    expect(caps.tools.map((t) => t.name)).toEqual(builtinTools.map((t) => t.name));
    expect(caps.tools.map((t) => t.name)).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep']);
    for (const t of caps.tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(Object.keys(t)).toEqual(['name', 'description']);
    }
  });

  it('approvalPolicy 摘要：优先级 + 兜底 + 缺省安全集（只读工具）', () => {
    const caps = describeCapabilities();
    expect(caps.approvalPolicy.rule).toContain('per-tool');
    expect(caps.approvalPolicy.fallback).toContain('safe=allow');
    expect(caps.approvalPolicy.safeTools).toEqual([...DEFAULT_SAFE_TOOLS]);
    expect(caps.approvalPolicy.safeTools).toEqual(['read', 'glob', 'grep']);
  });
});
