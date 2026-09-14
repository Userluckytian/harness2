// P7 接线棒（core 侧）测试：A/B/C 三棒 core 能力接进命令面与 serve 装配（sessions-turn.ts）。
// 覆盖：
//   ① 命令面：新命令（search/reindex/import/title/compact-layers/tools）经 runCoreCommand
//      真分发到 core 实现（非 shellOnly 兜底）；/compact 有活动会话切分层压缩；
//   ② serve 装配：记忆三态（off/ask/auto）工具可见性 + 主动持久化契约（createMemoryToolForPolicy
//      唯一出口）；skill_author（skills.authoring）；run_script（真实可调用）；subagent_fanout；
//   ③ 工具面过滤：config.tools（enable=false）从 per-turn 注册表剔除（禁用工具不进模型工具面）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCoreCommand, runCoreCommand } from '../src/commands/index.js';
import type { CoreCommandContext } from '../src/commands/types.js';
import { MemoryStore } from '../src/memory/store.js';
import { createMemoryToolForPolicy } from '../src/memory/mode.js';
import { PendingMemoryStore } from '../src/memory/pending.js';
import { MockProvider } from '../src/provider/mock.js';
import { startServe } from '../src/server/http.js';
import { SessionHub } from '../src/server/sessions.js';
import { SessionManager } from '../src/session/manager.js';
import { SkillAuthoringStore } from '../src/skills/authoring.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/predefined/index.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-p7-wiring-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTools(): ToolRegistry {
  const tools = new ToolRegistry();
  registerBuiltinTools(tools);
  return tools;
}

/** 命令面录制 ctx：真实 manager/current（供会话能力命令读会话） */
function makeCommandCtx(root: string): {
  ctx: CoreCommandContext;
  lines: string[];
  manager: SessionManager;
  session: { id: string; writer: ReturnType<SessionManager['create']>['writer'] };
} {
  const manager = new SessionManager(join(root, 'sessions'));
  const created = manager.create(root);
  created.writer.append('user/message', { text: '记忆索引与标题用例' });
  const lines: string[] = [];
  const ctx: CoreCommandContext = {
    print: (t) => lines.push(t),
    manager,
    cwd: root,
    current: () => ({ id: created.id, writer: created.writer }),
    switchSession: () => undefined,
    requestExit: () => undefined,
    snapshots: () => undefined,
    contextUsage: () => 0.1,
  };
  return { ctx, lines, manager, session: { id: created.id, writer: created.writer } };
}

async function exec(line: string, ctx: CoreCommandContext): Promise<void> {
  const parsed = parseCoreCommand(line);
  if (parsed === null) throw new Error(`非命令: ${line}`);
  const r = runCoreCommand(parsed, ctx);
  if (r instanceof Promise) await r;
}

describe('P7 命令面：新命令真分发（无 shellOnly 兜底）', () => {
  it('search/reindex/import/title/compact-layers 逐条执行出真实输出', async () => {
    const root = tmpDir();
    const { ctx, lines } = makeCommandCtx(root);
    // 每条命令都有自己的真实 core 输出；断言不落「由界面层实现」兜底
    const cases: Array<{ line: string; match: RegExp }> = [
      { line: '/reindex', match: /索引重建/ },
      { line: '/search 记忆', match: /命中|无命中/ },
      { line: '/import', match: /用法 \/import/ },
      { line: '/title', match: /标题：/ },
      { line: '/title --auto', match: /标题：/ },
      { line: '/title 自定义标题', match: /已设置标题：自定义标题/ },
      { line: '/compact-layers', match: /未执行压缩|已执行分层压缩/ },
    ];
    for (const c of cases) {
      lines.length = 0;
      await exec(c.line, ctx);
      const out = lines.join('\n');
      expect(out, `${c.line} 未产出 core 输出`).toMatch(c.match);
      expect(out, `${c.line} 落 shellOnly 兜底`).not.toContain('由界面层实现');
    }
  });

  it('/compact 有活动会话 → 分层压缩路径（与 /compact-layers 同实现）', async () => {
    const root = tmpDir();
    const { ctx, lines } = makeCommandCtx(root);
    await exec('/compact', ctx);
    expect(lines.join('\n')).toMatch(/未执行压缩|已执行分层压缩/);
    expect(lines.join('\n')).not.toContain('压缩将在下一次 turn 开始时自动检查');
  });

  it('/tools 经 toolRegistry/selection 缝输出真实盘点（非空）', async () => {
    const root = tmpDir();
    const { ctx, lines } = makeCommandCtx(root);
    const tools = makeTools();
    await exec('/tools list', {
      ...ctx,
      toolRegistry: () => tools,
      toolSelection: () => ({}),
    });
    const out = lines.join('\n');
    expect(out).toContain('工具 6 个');
    expect(out).toContain('bash');
    expect(out).not.toContain('由界面层实现');
    lines.length = 0;
    // show 单个工具
    await exec('/tools show read', { ...ctx, toolRegistry: () => tools, toolSelection: () => ({}) });
    expect(lines.join('\n')).toContain('工具 read');
  });
});

describe('P7 serve 装配：记忆三态（createMemoryToolForPolicy 唯一出口）', () => {
  function makeHub(root: string, memory?: ConstructorParameters<typeof SessionHub>[0]['memory']) {
    const manager = new SessionManager(join(root, 's'));
    return new SessionHub({
      manager,
      provider: new MockProvider([]),
      tools: makeTools(),
      cwd: root,
      ...(memory !== undefined ? { memory } : {}),
    });
  }

  it('off（未装配）→ memory 工具不可见；ask/auto → 可见且带主动持久化契约', async () => {
    const root = tmpDir();
    const sid = '20260914-000000-aaaaaa';
    const off = makeHub(root);
    expect(off.toolsForSession(sid).get('memory')).toBeUndefined();
    await off.close();

    for (const mode of ['ask', 'auto'] as const) {
      const store = new MemoryStore(join(root, `mem-${mode}`));
      const pending = mode === 'ask' ? new PendingMemoryStore(join(root, `pend-${mode}`), store) : undefined;
      const hub = makeHub(root, { store, mode, nudgeInterval: 10, ...(pending !== undefined ? { pending } : {}) });
      const tool = hub.toolsForSession(sid).get('memory');
      expect(tool, `${mode} 模式应注册 memory 工具`).toBeDefined();
      // 与策略出口逐字一致（三壳唯一入口的机器证据：同参同 description）
      const expected = createMemoryToolForPolicy(store, mode, {
        ...(pending !== undefined ? { pending } : {}),
        sessionId: sid,
      });
      expect(tool!.description).toBe(expected!.description);
      expect(tool!.description).toContain('Persist proactively');
      await hub.close();
    }
  });
});

describe('P7 serve 装配：skill_author / run_script / subagent_fanout / 工具面过滤', () => {
  const sid = '20260914-000000-bbbbbb';
  function makeHub(root: string, extra: Partial<ConstructorParameters<typeof SessionHub>[0]> = {}) {
    const manager = new SessionManager(join(root, 's'));
    return new SessionHub({
      manager,
      provider: new MockProvider([]),
      tools: makeTools(),
      cwd: root,
      ...extra,
    });
  }

  it('skills.authoring → skill_author 注册（只提案工具）', async () => {
    const root = tmpDir();
    const hub = makeHub(root, { skillsAuthoring: new SkillAuthoringStore(join(root, 'skills')) });
    expect(hub.toolsForSession(sid).get('skill_author')).toBeDefined();
    await hub.close();
  });

  it('script → run_script 注册且真实可调用（返回脚本结果）', async () => {
    const root = tmpDir();
    const hub = makeHub(root, { script: true, decide: () => 'allow' });
    const tool = hub.toolsForSession(sid).get('run_script');
    expect(tool).toBeDefined();
    const out = await tool!.execute({ script: 'return 1 + 1;' }, { signal: new AbortController().signal, cwd: root });
    expect(out.error).toBeUndefined();
    expect(out.output).toContain('2');
    await hub.close();
  });

  it('subagent 装配 → subagent_fanout 注册且可调用（1 个子代理）', async () => {
    const root = tmpDir();
    const hub = makeHub(root, {
      subagent: { provider: new MockProvider([{ text: 'child ok' }]), maxDepth: 1, maxTurns: 3 },
      decide: () => 'allow',
    });
    const tool = hub.toolsForSession(sid).get('subagent_fanout');
    expect(tool).toBeDefined();
    const out = await tool!.execute({ prompts: ['子任务'] }, { signal: new AbortController().signal, cwd: root });
    expect(out.error).toBeUndefined();
    expect(out.output).toContain('child ok');
    await hub.close();
  });

  it('config.tools（enable=false）→ 禁用工具不进 per-turn 注册表（含动态 run_script）', async () => {
    const root = tmpDir();
    const hub = makeHub(root, { script: true, toolsConfig: { enable: { bash: false, run_script: false } } });
    const reg = hub.toolsForSession(sid);
    expect(reg.get('bash')).toBeUndefined();
    expect(reg.get('run_script')).toBeUndefined();
    expect(reg.get('read')).toBeDefined();
    await hub.close();
  });

  it('toolsForSession 直调（诊断缝）不落 run_script 递归：RPC 快照不含 run_script', async () => {
    const root = tmpDir();
    const hub = makeHub(root, { script: true, decide: () => 'allow' });
    const tool = hub.toolsForSession(sid).get('run_script')!;
    // 脚本列工具：应看不到 run_script 自身（防递归）
    const out = await tool.execute(
      { script: 'const t = await harness.tools.list(); return t.map(x => x.name).join(",");' },
      { signal: new AbortController().signal, cwd: root },
    );
    expect(out.error).toBeUndefined();
    expect(out.output).toContain('bash');
    expect(out.output).not.toContain('run_script');
    await hub.close();
  });
});

// P7 serve 装配（http.ts startServe，config 驱动）——桌面/网关的共用装配点：
// config.skills.authoring=on 派生 skill_author；配置路径缺省开启 run_script；config.tools 过滤生效。
describe('P7 startServe（config 驱动）装配能力确认', () => {
  const ENV_KEY = 'H2_P7_SERVE_TEST_KEY';
  const prev = process.env[ENV_KEY];

  it('skills.authoring + run_script + subagent_fanout 进 turn 工具集；config.tools 剔除禁用工具', async () => {
    process.env[ENV_KEY] = 'test-key';
    const root = tmpDir('h2-p7-serve-root-');
    const home = tmpDir('h2-p7-serve-home-');
    const dir = join(home, '.harness2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        providers: {
          openai: { protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', envKey: ENV_KEY, models: { m: {} } },
        },
        roles: { main: { channel: 'openai', model: 'm' } },
        browser: { enabled: false },
        plugins: { enabled: false },
        skills: { authoring: 'on' },
        tools: { enable: { bash: false } },
      }),
      'utf8',
    );
    let handle: Awaited<ReturnType<typeof startServe>> | undefined;
    try {
      handle = await startServe({ port: 0, root, home });
      const reg = handle.hub.toolsForSession('20260914-000000-cccccc');
      expect(reg.get('run_script'), 'run_script 应注册').toBeDefined();
      expect(reg.get('subagent_fanout'), 'subagent_fanout 应注册').toBeDefined();
      expect(reg.get('skill_author'), 'skill_author 应注册（skills.authoring=on）').toBeDefined();
      expect(reg.get('bash'), 'config.tools 禁用 bash → 不进模型工具面').toBeUndefined();
      expect(reg.get('read')).toBeDefined();
    } finally {
      if (handle !== undefined) await handle.close();
      if (prev === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = prev;
    }
  });
});
