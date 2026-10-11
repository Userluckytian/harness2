// Z6-A16 权限规则 DSL 测试：glob 匹配矩阵 / 两段式命令级规则 / 确定性优先级链
// （字面数 → 精确 > 通配 → deny>ask>allow） / fail-closed 显式口径 / 老配置兼容 /
// always 授权写回 config.approval.tools 的 helper。
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../src/approval/glob.js';
import {
  APPROVAL_SUBJECT_FIELDS,
  createApprovalPolicy,
  extractApprovalSubject,
  resolveUnmatchedDecision,
  DEFAULT_SAFE_TOOLS,
} from '../src/approval/policy.js';
import { grantsToApprovalToolRules, upsertApprovalToolRule } from '../src/flows/approval-flow.js';
import { parseConfig } from '../src/config/schema.js';
import type { ApprovalConfig, ApprovalToolRule, HarnessConfig } from '../src/config/schema.js';

function decide(cfg: ApprovalConfig | undefined, tool: string, args: unknown = {}): string {
  return createApprovalPolicy(cfg).decide({ tool, args });
}

describe('matchGlob（glob 语义矩阵：* / ? 全串锚定）', () => {
  it('精确串：全等才命中', () => {
    expect(matchGlob('bash', 'bash')).toBe(true);
    expect(matchGlob('bash', 'bashx')).toBe(false);
    expect(matchGlob('bash', 'Bash')).toBe(false); // 大小写敏感（工具名恒小写）
  });

  it('`*` 通配任意序列（含空串、含换行——bash 命令可多行）', () => {
    expect(matchGlob('mcp__*', 'mcp__deep__tool')).toBe(true);
    expect(matchGlob('mcp__*', 'bash')).toBe(false);
    expect(matchGlob('git *', 'git status')).toBe(true);
    expect(matchGlob('git *', 'git')).toBe(false); // 需字面空格；* 可为空但不补空格
    expect(matchGlob('git*', 'git')).toBe(true);
    expect(matchGlob('git *', 'git commit\n-m "x"')).toBe(true); // 跨行
    expect(matchGlob('a*bc', 'abc')).toBe(true); // * 匹配空串
  });

  it('`?` 恰好一个字符（含换行）', () => {
    expect(matchGlob('rea?', 'read')).toBe(true);
    expect(matchGlob('rea?', 'readx')).toBe(false);
    expect(matchGlob('rea?', 'rea\n')).toBe(true);
  });

  it('正则元字符按字面匹配（不误当正则）', () => {
    expect(matchGlob('git log (v1)', 'git log (v1)')).toBe(true);
    expect(matchGlob('a.b', 'aXb')).toBe(false); // . 是字面点
    expect(matchGlob('a.b', 'a.b')).toBe(true);
    expect(matchGlob('x+y', 'x+y')).toBe(true);
  });

  it('全串锚定：partial match 不算命中', () => {
    expect(matchGlob('*end', 'the end')).toBe(true);
    expect(matchGlob('*end', 'the end!')).toBe(false);
    expect(matchGlob('git', 'github')).toBe(false);
  });
});

describe('A16 规则链（createApprovalPolicy）', () => {
  it('兼容：既有 exact-name 规则行为不变（老 config 不迁移即可用）', () => {
    expect(decide({ mode: 'default', tools: { bash: 'deny' } }, 'bash')).toBe('deny');
    expect(decide({ mode: 'default', tools: { bash: 'deny' } }, 'write')).toBe('ask');
    expect(decide({ mode: 'bypass', tools: { bash: 'ask', write: 'deny' } }, 'bash')).toBe('ask');
    expect(decide({ mode: 'plan', tools: { bash: 'allow' } }, 'bash')).toBe('allow');
  });

  it('glob 工具名前缀：mcp__* 命中 namespaced 工具；未命中工具走 fail-closed', () => {
    const cfg: ApprovalConfig = { mode: 'default', tools: { 'mcp__*': 'allow' } };
    expect(decide(cfg, 'mcp__deep__tool')).toBe('allow');
    expect(decide(cfg, 'mcp__other')).toBe('allow');
    expect(decide(cfg, 'bash')).toBe('ask'); // 未命中 → 未列出的 unsafe → ask
    expect(decide(cfg, 'read')).toBe('allow'); // 未命中 → safe 集
  });

  it('两段式命令级规则 `bash:git *`：按 args.command 匹配；无主体不命中（fail-closed）', () => {
    const cfg: ApprovalConfig = { mode: 'default', tools: { bash: 'ask', 'bash:git *': 'allow' } };
    expect(decide(cfg, 'bash', { command: 'git status' })).toBe('allow');
    expect(decide(cfg, 'bash', { command: 'git push --force' })).toBe('allow');
    expect(decide(cfg, 'bash', { command: 'rm -rf /' })).toBe('ask');
    expect(decide(cfg, 'bash', { command: 'git' })).toBe('ask'); // `git *` 需字面空格
    expect(decide(cfg, 'bash', {})).toBe('ask'); // 无 command 主体 → 两段键不命中
    expect(decide(cfg, 'bash', { command: 42 })).toBe('ask'); // 主体非字符串 → 不命中
  });

  it('主体可含冒号（键按首个 : 分隔；命令自带的冒号不参与分隔）', () => {
    const cfg: ApprovalConfig = { mode: 'default', tools: { 'bash:npm run *': 'allow', bash: 'ask' } };
    expect(decide(cfg, 'bash', { command: 'npm run build:prod' })).toBe('allow');
    expect(decide(cfg, 'bash', { command: 'npm test' })).toBe('ask');
  });

  it('精确主体 > 通配主体（`bash:git status` 压过 `bash:git *`）', () => {
    const cfg: ApprovalConfig = {
      mode: 'default',
      tools: { 'bash:git status': 'deny', 'bash:git *': 'allow' },
    };
    expect(decide(cfg, 'bash', { command: 'git status' })).toBe('deny');
    expect(decide(cfg, 'bash', { command: 'git push' })).toBe('allow');
  });

  it('通配特异性：字面多者更特异（`git st*` 压过 `git *`）', () => {
    const cfg: ApprovalConfig = {
      mode: 'default',
      tools: { 'bash:git st*': 'allow', 'bash:git *': 'deny' },
    };
    expect(decide(cfg, 'bash', { command: 'git status' })).toBe('allow');
    expect(decide(cfg, 'bash', { command: 'git push' })).toBe('deny');
  });

  it('精确工具 > 通配工具（字面数相同时无通配者胜）', () => {
    const cfg: ApprovalConfig = { mode: 'default', tools: { ab: 'deny', 'a*b': 'allow' } };
    expect(decide(cfg, 'ab')).toBe('deny'); // 字面和同为 2 → 精确优先
  });

  it('同特异性：deny > ask > allow（fail-closed 取更严）', () => {
    // `*ead` 与 `r*ad` 字面数同为 3、同为通配、同为单段 → deny 胜
    const cfg: ApprovalConfig = { mode: 'default', tools: { '*ead': 'allow', 'r*ad': 'deny' } };
    expect(decide(cfg, 'read')).toBe('deny');
  });

  it('命令级规则压过工具级兜底（`bash:git *` 压过精确 `bash`）', () => {
    const cfg: ApprovalConfig = { mode: 'default', tools: { bash: 'deny', 'bash:git *': 'allow' } };
    expect(decide(cfg, 'bash', { command: 'git log' })).toBe('allow');
    expect(decide(cfg, 'bash', { command: 'curl evil.example' })).toBe('deny');
  });

  it('全量兜底通配不压过精确工具名（`*` 字面数少于 `bash`）', () => {
    const cfg: ApprovalConfig = { mode: 'default', tools: { '*': 'allow', bash: 'deny' } };
    expect(decide(cfg, 'bash')).toBe('deny');
    expect(decide(cfg, 'anything')).toBe('allow');
  });

  it('多规则链组合（mcp 前缀 + 精确覆盖 + 命令级）确定性解析', () => {
    const cfg: ApprovalConfig = {
      mode: 'default',
      tools: {
        'mcp__*': 'ask',
        mcp__deep: 'deny',
        bash: 'ask',
        'bash:git *': 'allow',
        'bash:git push --force*': 'deny',
      },
    };
    expect(decide(cfg, 'mcp__deep')).toBe('deny');
    expect(decide(cfg, 'mcp__other__tool')).toBe('ask');
    expect(decide(cfg, 'bash', { command: 'git log' })).toBe('allow');
    expect(decide(cfg, 'bash', { command: 'git push --force-with-lease' })).toBe('deny');
    expect(decide(cfg, 'bash', { command: 'make' })).toBe('ask');
  });
});

describe('A16-3 fail-closed 显式口径（resolveUnmatchedDecision）', () => {
  it('未命中且工具不在 safe 集 → ask；safe 集 → allow（default/acceptEdits）', () => {
    expect(resolveUnmatchedDecision('default', 'bash')).toBe('ask');
    expect(resolveUnmatchedDecision('default', 'read')).toBe('allow');
    expect(resolveUnmatchedDecision('acceptEdits', 'bash')).toBe('ask');
    expect(resolveUnmatchedDecision('acceptEdits', 'write')).toBe('allow'); // 编辑类放行
    expect(resolveUnmatchedDecision('acceptEdits', 'read')).toBe('allow');
  });

  it('bypass → 全 allow；plan → safe=allow / 其余 deny', () => {
    expect(resolveUnmatchedDecision('bypass', 'bash')).toBe('allow');
    expect(resolveUnmatchedDecision('bypass', 'anything')).toBe('allow');
    expect(resolveUnmatchedDecision('plan', 'read')).toBe('allow');
    expect(resolveUnmatchedDecision('plan', 'bash')).toBe('deny');
    expect(resolveUnmatchedDecision('plan', 'unknown_tool')).toBe('deny');
  });

  it('自定义安全集参与口径；APPROVAL_SUBJECT_FIELDS / extractApprovalSubject 契约', () => {
    const extended = new Set([...DEFAULT_SAFE_TOOLS, 'web_fetch']);
    expect(resolveUnmatchedDecision('default', 'web_fetch', extended)).toBe('allow');
    expect(resolveUnmatchedDecision('default', 'web_fetch')).toBe('ask');
    expect(APPROVAL_SUBJECT_FIELDS['bash']).toBe('command');
    expect(extractApprovalSubject('bash', { command: 'ls -la' })).toBe('ls -la');
    expect(extractApprovalSubject('bash', {})).toBeUndefined();
    expect(extractApprovalSubject('read', { file_path: 'x' })).toBeUndefined(); // 非 bash 无主体
    expect(extractApprovalSubject('bash', 'not-object')).toBeUndefined();
  });
});

describe('A16-4 always 授权写回 config.approval.tools（helper；serve 端点本轮不加）', () => {
  const baseConfig: HarnessConfig = parseConfig({
    providers: { ch: { protocol: 'openai', baseUrl: 'https://api.example.com' } },
    roles: { main: { channel: 'ch', model: 'm' } },
    approval: { mode: 'default', tools: { bash: 'deny' } },
  }).config!;

  it('grantsToApprovalToolRules：授权清单 → allow 规则映射', () => {
    expect(grantsToApprovalToolRules(['bash', 'web_fetch'])).toEqual({ bash: 'allow', web_fetch: 'allow' });
    expect(grantsToApprovalToolRules([], 'ask')).toEqual({});
    expect(grantsToApprovalToolRules(['mcp__deep__tool'], 'ask')).toEqual({ mcp__deep__tool: 'ask' });
  });

  it('upsertApprovalToolRule：写入新规则、保留既有规则（含 glob 键）、不改原对象', () => {
    const withGlob: HarnessConfig = {
      ...baseConfig,
      approval: { ...baseConfig.approval, tools: { ...baseConfig.approval.tools, 'mcp__*': 'ask' } },
    };
    const before = JSON.stringify(withGlob);
    const updated = upsertApprovalToolRule(withGlob, 'web_fetch', 'allow');
    expect(updated.approval.tools).toEqual({ bash: 'deny', 'mcp__*': 'ask', web_fetch: 'allow' });
    expect(JSON.stringify(withGlob)).toBe(before); // 原 config 不被修改
    // 同键覆盖
    const overridden = upsertApprovalToolRule(updated, 'bash', 'ask');
    expect(overridden.approval.tools?.['bash']).toBe('ask');
    expect(updated.approval.tools?.['bash']).toBe('deny');
  });

  it('写回产物经 schema 校验通过（approval.tools 接受规则键，向后兼容）', () => {
    const updated = upsertApprovalToolRule(baseConfig, 'bash:git *', 'allow');
    const reparsed = parseConfig(JSON.parse(JSON.stringify(updated)));
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.config?.approval.tools).toEqual({ bash: 'deny', 'bash:git *': 'allow' });
  });
});

describe('A16 schema 校验（向后兼容）', () => {
  const rawBase = {
    providers: { ch: { protocol: 'openai', baseUrl: 'https://api.example.com' } },
    roles: { main: { channel: 'ch', model: 'm' } },
  };

  function parseApprovalTools(tools: Record<string, string>): {
    errors: string[];
    tools?: Record<string, ApprovalToolRule>;
  } {
    const result = parseConfig({ ...rawBase, approval: { tools } });
    return { errors: result.errors, tools: result.config?.approval.tools };
  }

  it('glob 键与两段式键通过校验', () => {
    const { errors, tools } = parseApprovalTools({ 'mcp__*': 'ask', 'bash:git *': 'allow', bash: 'deny' });
    expect(errors).toEqual([]);
    expect(tools).toEqual({ 'mcp__*': 'ask', 'bash:git *': 'allow', bash: 'deny' });
  });

  it('空键拒绝（fail-closed；非空键不受影响——老配置兼容）', () => {
    const { errors } = parseApprovalTools({ '': 'allow' });
    expect(errors.some((e) => e.includes('规则键不能为空字符串'))).toBe(true);
    const ok = parseApprovalTools({ bash: 'allow' });
    expect(ok.errors).toEqual([]);
  });

  it('非法决策值仍拒绝（既有口径不变）', () => {
    const { errors } = parseApprovalTools({ bash: 'maybe' });
    expect(errors.some((e) => e.includes('approval.tools.bash'))).toBe(true);
  });
});
