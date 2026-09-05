// 审批策略配置化测试：mode × 工具矩阵 + per-tool 优先级 + 与 Ph2 executor 审批缝对接。
import { describe, expect, it } from 'vitest';
import { createApprovalPolicy, DEFAULT_SAFE_TOOLS } from '../src/approval/policy.js';
import type { ApprovalConfig } from '../src/config/index.js';
import { ToolExecutor, DENIED_MESSAGE } from '../src/tools/executor.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';

function decide(cfg: ApprovalConfig | undefined, tool: string): string {
  return createApprovalPolicy(cfg).decide({ tool, args: {} });
}

describe('createApprovalPolicy：mode × 工具矩阵', () => {
  it('default：safe（read/glob/grep）= allow，unsafe（bash/write/edit/未知）= ask', () => {
    expect(decide(undefined, 'read')).toBe('allow');
    expect(decide(undefined, 'glob')).toBe('allow');
    expect(decide(undefined, 'grep')).toBe('allow');
    expect(decide(undefined, 'bash')).toBe('ask');
    expect(decide(undefined, 'write')).toBe('ask');
    expect(decide(undefined, 'edit')).toBe('ask');
    expect(decide(undefined, 'custom_tool')).toBe('ask'); // 未列出的 unsafe
    expect(decide({ mode: 'default' }, 'bash')).toBe('ask');
  });

  it('acceptEdits：write/edit = allow，bash 仍 ask，safe 仍 allow', () => {
    const cfg: ApprovalConfig = { mode: 'acceptEdits' };
    expect(decide(cfg, 'write')).toBe('allow');
    expect(decide(cfg, 'edit')).toBe('allow');
    expect(decide(cfg, 'read')).toBe('allow');
    expect(decide(cfg, 'bash')).toBe('ask');
    expect(decide(cfg, 'unknown_x')).toBe('ask');
  });

  it('bypass：全 allow（含 unsafe 与未知工具）', () => {
    const cfg: ApprovalConfig = { mode: 'bypass' };
    for (const tool of ['bash', 'write', 'edit', 'read', 'anything']) {
      expect(decide(cfg, tool)).toBe('allow');
    }
  });

  it('per-tool 规则优先于 mode 推导（含 bypass 下的 ask/deny）', () => {
    const denyBash: ApprovalConfig = { mode: 'default', tools: { bash: 'deny' } };
    expect(decide(denyBash, 'bash')).toBe('deny');
    expect(decide(denyBash, 'write')).toBe('ask'); // 未列出的仍按 mode

    const bypassAsk: ApprovalConfig = { mode: 'bypass', tools: { bash: 'ask', write: 'deny' } };
    expect(decide(bypassAsk, 'bash')).toBe('ask');
    expect(decide(bypassAsk, 'write')).toBe('deny');
    expect(decide(bypassAsk, 'read')).toBe('allow'); // 其余 bypass

    const editsAsk: ApprovalConfig = { mode: 'acceptEdits', tools: { write: 'ask', read: 'deny' } };
    expect(decide(editsAsk, 'write')).toBe('ask'); // per-tool 压过 acceptEdits
    expect(decide(editsAsk, 'read')).toBe('deny'); // per-tool 压过 safe=allow
    expect(decide(editsAsk, 'edit')).toBe('allow');
  });

  it('自定义安全集：未列出的工具按注入的安全集判定', () => {
    const extended = new Set([...DEFAULT_SAFE_TOOLS, 'web_fetch']);
    const policy = createApprovalPolicy(undefined, extended);
    expect(policy.decide({ tool: 'web_fetch', args: {} })).toBe('allow');
    expect(policy.decide({ tool: 'bash', args: {} })).toBe('ask');
  });
});

describe('与 Ph2 executor 审批缝对接', () => {
  function makeRegistry(allowTool: string): ToolRegistry {
    const registry = new ToolRegistry();
    const def: ToolDefinition = {
      name: allowTool,
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ output: 'ran' }),
    };
    registry.register(def);
    return registry;
  }

  const env = { signal: new AbortController().signal, cwd: process.cwd() };

  it('deny 规则：短路返回 DENIED_MESSAGE，工具不执行', async () => {
    const registry = makeRegistry('bash');
    const executor = new ToolExecutor(registry, createApprovalPolicy({ mode: 'bypass', tools: { bash: 'deny' } }));
    const r = await executor.execute({ callId: 'c1', tool: 'bash', args: {} }, env);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(DENIED_MESSAGE);
  });

  it('ask 决策：无 onAsk 按拒绝；onAsk 通过则执行', async () => {
    const registry = makeRegistry('bash');
    const refusing = new ToolExecutor(registry, createApprovalPolicy({ mode: 'default' }));
    const denied = await refusing.execute({ callId: 'c1', tool: 'bash', args: {} }, env);
    expect(denied.ok).toBe(false);
    expect(denied.error).toBe(DENIED_MESSAGE);

    let asked = 0;
    const accepting = new ToolExecutor(registry, {
      decide: createApprovalPolicy({ mode: 'default' }).decide,
      onAsk: () => {
        asked += 1;
        return true;
      },
    });
    const allowed = await accepting.execute({ callId: 'c2', tool: 'bash', args: {} }, env);
    expect(asked).toBe(1);
    expect(allowed.ok).toBe(true);
    expect(allowed.output).toBe('ran');
  });

  it('bypass 模式：直接执行不经 ask', async () => {
    const registry = makeRegistry('bash');
    const executor = new ToolExecutor(registry, createApprovalPolicy({ mode: 'bypass' }));
    const r = await executor.execute({ callId: 'c1', tool: 'bash', args: {} }, env);
    expect(r.ok).toBe(true);
  });
});
