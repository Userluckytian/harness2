// plan 第四审批态测试：只读工具 allow，其余 deny，per-tool 覆盖优先；不影响既有模式。
import { describe, expect, it } from 'vitest';
import { createApprovalPolicy } from '../src/approval/policy.js';
import type { ApprovalConfig } from '../src/config/index.js';
import { APPROVAL_MODES } from '../src/config/schema.js';

function decide(cfg: ApprovalConfig | undefined, tool: string): string {
  return createApprovalPolicy(cfg).decide({ tool, args: {} });
}

describe('createApprovalPolicy：plan 模式', () => {
  it('read/glob/grep → allow', () => {
    const cfg: ApprovalConfig = { mode: 'plan' };
    expect(decide(cfg, 'read')).toBe('allow');
    expect(decide(cfg, 'glob')).toBe('allow');
    expect(decide(cfg, 'grep')).toBe('allow');
  });

  it('write/edit/bash → deny', () => {
    const cfg: ApprovalConfig = { mode: 'plan' };
    expect(decide(cfg, 'write')).toBe('deny');
    expect(decide(cfg, 'edit')).toBe('deny');
    expect(decide(cfg, 'bash')).toBe('deny');
    expect(decide(cfg, 'unknown_tool')).toBe('deny');
  });

  it('per-tool 显式 allow 即使 mode=plan 也返回 allow', () => {
    const cfg: ApprovalConfig = { mode: 'plan', tools: { bash: 'allow' } };
    expect(decide(cfg, 'bash')).toBe('allow');
    expect(decide(cfg, 'read')).toBe('allow');
    expect(decide(cfg, 'write')).toBe('deny');
  });

  it('plan 态不影响既有模式（default/acceptEdits/bypass 期望值不变）', () => {
    expect(decide({ mode: 'default' }, 'bash')).toBe('ask');
    expect(decide({ mode: 'default' }, 'read')).toBe('allow');
    expect(decide({ mode: 'acceptEdits' }, 'write')).toBe('allow');
    expect(decide({ mode: 'acceptEdits' }, 'bash')).toBe('ask');
    expect(decide({ mode: 'bypass' }, 'bash')).toBe('allow');
    expect(decide({ mode: 'bypass' }, 'anything')).toBe('allow');
  });

  it('APPROVAL_MODES 末尾含 plan，既有顺序不变', () => {
    expect(APPROVAL_MODES).toEqual(['default', 'acceptEdits', 'bypass', 'plan']);
  });
});
