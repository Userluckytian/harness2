// S7a 有效运行配置视图（effective-run-config）。
// 契约（计划 S7 / 验收 #7b）：
//   - 会话 root/cwd 来源正确（per-session cwd 配置 → cwd 用 header 值，未配置 → 回退 root）；
//   - provider/model 与角色正确；可用工具列表来自装配集（排序）；
//   - 连接状态反映 provider 状态（有则原样反映，无则不臆造）；
//   - 脱敏：输出不含 key/token 字段与 sk- 形态密钥；
//   - 新 turn 记录配置 revision + 生效时点明确；同 run 内配置快照冻结稳定。
// 只读视图：复用既有 config/provider 装配语义，不新建配置存储。全部本地临时目录，无网络。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEffectiveRunConfig,
  sealRunConfigSnapshot,
  type EffectiveRunConfig,
  type EffectiveRunConfigInput,
} from '../src/interaction/run-config.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-rcfg-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function baseInput(): EffectiveRunConfigInput {
  const root = tmpDir();
  return {
    session: {
      sessionId: '20260908-120000-a1b2c3',
      root,
      cwd: join(root, 'projectA'),
      cwdFromHeader: true,
    },
    provider: {
      role: 'main',
      channel: 'openai-cn',
      model: 'gpt-4o',
      protocol: 'openai',
      name: 'openai-cn/gpt-4o',
      connectionStatus: 'connected',
    },
    approval: { mode: 'default', tools: { write: 'ask', read: 'allow' } },
    memoryMode: 'off',
    tools: ['bash', 'read', 'write', 'grep', 'glob'],
    skills: [
      { name: 'reverse', source: 'project' },
      { name: 'audit', source: 'global' },
    ],
    contextWindow: 128 * 1024,
    maxOutputTokens: 4096,
    snapshot: { revision: 1, capturedAt: '2026-09-08T00:00:00.000Z', effectiveAt: '2026-09-08T00:00:00.000Z' },
  };
}

describe('会话 root/cwd 来源正确（per-session cwd）', () => {
  it('cwdFromHeader=true：cwd=per-session 真值，root=项目根，perSessionCwd 标记为 true', () => {
    const input = baseInput();
    const view = buildEffectiveRunConfig(input);
    expect(view.session.root).toBe(input.session.root);
    expect(view.session.cwd).toBe(input.session.cwd);
    expect(view.session.perSessionCwd).toBe(true);
    expect(view.session.perSessionCwd).not.toBe(false);
  });

  it('cwdFromHeader=false（未配置 per-session cwd）：有效 cwd 回退 root', () => {
    const input = baseInput();
    input.session.cwdFromHeader = false;
    const view = buildEffectiveRunConfig(input);
    expect(view.session.perSessionCwd).toBe(false);
    expect(view.session.cwd).toBe(view.session.root);
  });
});

describe('provider/model 与角色正确', () => {
  it('输出 role/channel/model/protocol/name 全部来自装配好的 provider 视图', () => {
    const input = baseInput();
    const view = buildEffectiveRunConfig(input);
    expect(view.provider.role).toBe('main');
    expect(view.provider.channel).toBe('openai-cn');
    expect(view.provider.model).toBe('gpt-4o');
    expect(view.provider.protocol).toBe('openai');
    expect(view.provider.name).toBe('openai-cn/gpt-4o');
  });
});

describe('可用工具列表来自装配集（排序）', () => {
  it('tools = 装配集工具名的排序拷贝', () => {
    const input = baseInput();
    const view = buildEffectiveRunConfig(input);
    expect([...view.tools]).toEqual(['bash', 'glob', 'grep', 'read', 'write']);
    // 输入数组与输出数组不共享引用（快照拷贝，后续修改输入不静默改写视图）
    (input.tools as string[]).push('hacked_tool');
    expect([...view.tools]).toEqual(['bash', 'glob', 'grep', 'read', 'write']);
  });
});

describe('连接状态反映 provider 状态', () => {
  it('provider 提供 connectionStatus → 原样反映（不臆造）', () => {
    const input = baseInput();
    expect(buildEffectiveRunConfig(input).connection.status).toBe('connected');
  });

  it("provider 未提供连接状态 → 'unknown'（不猜测为 connected）", () => {
    const input = baseInput();
    delete input.provider.connectionStatus;
    expect(buildEffectiveRunConfig(input).connection.status).toBe('unknown');
  });

  it("provider 断开 → 'disconnected'（如实反映）", () => {
    const input = baseInput();
    input.provider.connectionStatus = 'disconnected';
    expect(buildEffectiveRunConfig(input).connection.status).toBe('disconnected');
  });
});

describe('脱敏（不暴露 key/token/sk- 密钥）', () => {
  const SENSITIVE_NAMES = new Set([
    'apikey',
    'api_key',
    'api-key',
    'key',
    'token',
    'secret',
    'password',
    'authorization',
  ]);
  function assertNoSensitiveKeys(value: unknown, path = 'view'): void {
    if (value === null || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) {
      expect(SENSITIVE_NAMES.has(k.toLowerCase()), `${path}.${k} 是敏感字段名，不应出现在脱敏视图`).toBe(false);
      assertNoSensitiveKeys(v, `${path}.${k}`);
    }
  }

  it('输出不含 sk- 形态密钥（cwd / 任意字符串叶都被脱敏）', () => {
    const input = baseInput();
    input.session.cwd = join(tmpDir(), 'sk-leak123456secret', 'work');
    input.provider.name = 'sk-oppsaaaaaa/mdl';
    const view = buildEffectiveRunConfig(input);
    const json = JSON.stringify(view);
    expect(json).not.toContain('sk-leak123456secret');
    expect(json).not.toContain('sk-oppsaaaaaa');
    expect(json).not.toMatch(/sk-[A-Za-z0-9_-]{6,}/);
  });

  it('输出对象无任何敏感字段名（递归遍历）', () => {
    const view: EffectiveRunConfig = buildEffectiveRunConfig(baseInput());
    assertNoSensitiveKeys(view);
    expect(view.redacted).toBe(true);
  });
});

describe('新 turn 配置 revision + 生效时点明确', () => {
  it('sealRunConfigSnapshot：首 turn revision=1，下一 turn +1，生效时点显式', () => {
    const s1 = sealRunConfigSnapshot(undefined, {
      capturedAt: '2026-09-08T00:00:01.000Z',
      effectiveAt: '2026-09-08T00:00:01.000Z',
    });
    expect(s1.revision).toBe(1);
    const s2 = sealRunConfigSnapshot(s1, {
      capturedAt: '2026-09-08T00:00:02.000Z',
      effectiveAt: '2026-09-08T00:00:02.000Z',
    });
    expect(s2.revision).toBe(2);
    expect(s2.capturedAt).toBe('2026-09-08T00:00:02.000Z');
    expect(s2.effectiveAt).toBe('2026-09-08T00:00:02.000Z');
    // revision 单调，不回退
    expect(Number(s2.revision)).toBeGreaterThan(Number(s1.revision));
  });

  it('视图携带 snapshot 封存：revision + capturedAt + effectiveAt 与 seal 一致', () => {
    const input = baseInput();
    input.snapshot = sealRunConfigSnapshot(undefined, {
      capturedAt: '2026-09-08T01:00:00.000Z',
      effectiveAt: '2026-09-08T01:00:00.000Z',
    });
    const view = buildEffectiveRunConfig(input);
    expect(view.snapshot.revision).toBe(1);
    expect(view.snapshot.capturedAt).toBe('2026-09-08T01:00:00.000Z');
    expect(view.snapshot.effectiveAt).toBe('2026-09-08T01:00:00.000Z');
  });
});

describe('同 run 内配置快照稳定（冻结 + 捕获时点拷贝）', () => {
  it('输出深度冻结（不可被后续代码改写）', () => {
    const view = buildEffectiveRunConfig(baseInput());
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.session)).toBe(true);
    expect(Object.isFrozen(view.tools)).toBe(true);
    expect(Object.isFrozen(view.context)).toBe(true);
    expect(Object.isFrozen(view.context.retry)).toBe(true);
  });

  it('相同输入+相同 snapshot → 输出确定性一致；同 run 不会因外部异步变化静默改写', () => {
    const seed = baseInput();
    const view1 = buildEffectiveRunConfig(seed);
    const before = JSON.stringify({ ...view1, snapshot: { ...view1.snapshot } });
    // 模拟「同 run 内后续异步变化」：静默修改输入装配
    seed.session.cwd = join(tmpDir(), 'other');
    (seed.tools as string[]).push('silent_hack');
    seed.snapshot.capturedAt = '2099-01-01T00:00:00.000Z';
    // 视图仍是捕获时点的快照：未被静默改写
    const after = JSON.stringify({ ...view1, snapshot: { ...view1.snapshot } });
    expect(after).toBe(before);
  });

  it('同输入重新构建 → 深度相等（确定性，无隐藏状态）', () => {
    const fixedRoot = tmpDir();
    const seed = baseInput();
    seed.session.root = fixedRoot;
    seed.session.cwd = join(fixedRoot, 'projectA');
    const a = buildEffectiveRunConfig(seed);
    const seed2 = baseInput();
    seed2.session.root = fixedRoot;
    seed2.session.cwd = join(fixedRoot, 'projectA');
    const b = buildEffectiveRunConfig(seed2);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('模式/策略、指令/skill 来源、上下文窗口与预算', () => {
  it('approval 模式与 per-tool 策略来自装配（可运行时覆盖 approval 模式）', () => {
    const input = baseInput();
    const view = buildEffectiveRunConfig(input);
    expect(view.approval.mode).toBe('default');
    expect(view.approval.tools).toEqual({ write: 'ask', read: 'allow' });
    const overridden = buildEffectiveRunConfig({ ...input, approvalMode: 'plan' });
    expect(overridden.approval.mode).toBe('plan');
  });

  it('memory 模式（策略位）如实反映', () => {
    const input = baseInput();
    input.memoryMode = 'ask';
    expect(buildEffectiveRunConfig(input).modes.memory).toBe('ask');
  });

  it('指令/skill 来源 = 两级扫描结果（project/global）', () => {
    const view = buildEffectiveRunConfig(baseInput());
    expect(view.instructions.skills.map((s) => `${s.source}:${s.name}`)).toEqual(['project:reverse', 'global:audit']);
  });

  it('上下文窗口、maxOutputTokens 与重试预算如实暴露', () => {
    const view = buildEffectiveRunConfig(baseInput());
    expect(view.context.contextWindow).toBe(128 * 1024);
    expect(view.context.maxOutputTokens).toBe(4096);
    expect(view.context.retry.maxExtraAttempts).toBe(3);
    expect(view.context.retry.backoffSeconds).toEqual([2, 10, 30]);
    expect(view.context.retry.maxExtraPerTurn).toBe(6);
    expect(view.context.retry.maxTotalWaitSeconds).toBe(120);
  });
});
