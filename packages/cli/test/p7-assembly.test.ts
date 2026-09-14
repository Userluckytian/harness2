// P7 接线棒（CLI 侧）测试：CLI 装配（chat-setup.ts）与 serve 装配（core sessions-turn.ts）
// 对同一 core 能力给出**一致**的行为——记忆三态工具可见性 + 主动持久化契约、skill_author、
// run_script、subagent_fanout、config.tools 过滤。用 config 驱动真实装配（非 mock 路径），
// 不触发任何模型调用（只检查装配产物 toolRegistry/toolSelection/configPath）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMemoryToolForPolicy,
  defaultConfigPaths,
  MemoryStore,
  MockProvider,
  PendingMemoryStore,
  registerBuiltinTools,
  SessionHub,
  SessionManager,
  ToolRegistry,
} from '@harness2/core';
import { setupChatSession, type ChatRuntime } from '../src/chat-setup.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-p7-cli-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const ENV_KEY = 'H2_P7_CLI_TEST_KEY';
const prevKey = process.env[ENV_KEY];
beforeEach(() => {
  process.env[ENV_KEY] = 'test-key-not-a-secret';
});
afterEach(() => {
  if (prevKey === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prevKey;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 写全局 config.json（home/.harness2/config.json）并返回 { home, root } */
function writeConfig(root: string, home: string, extra: Record<string, unknown>): void {
  const dir = join(home, '.harness2');
  mkdirSync(dir, { recursive: true });
  const config = {
    providers: {
      openai: {
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:9/v1',
        envKey: ENV_KEY,
        models: { 'test-model': {} },
      },
    },
    roles: { main: { channel: 'openai', model: 'test-model' } },
    browser: { enabled: false },
    ...extra,
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

async function boot(extra: Record<string, unknown>): Promise<{ runtime: ChatRuntime; root: string; home: string }> {
  const root = tmpDir('h2-p7-cli-root-');
  const home = tmpDir('h2-p7-cli-home-');
  writeConfig(root, home, extra);
  const runtime = await setupChatSession({ root, home }, { line: () => undefined, askApproval: async () => 'n' });
  return { runtime, root, home };
}

describe('P7 CLI 装配：记忆三态（与 serve 同一条 createMemoryToolForPolicy）', () => {
  it('off → 无 memory 工具；ask/auto → 有且描述与策略出口逐字一致（含主动持久化契约）', async () => {
    const off = await boot({ memory: { mode: 'off' } });
    expect(off.runtime.toolRegistry?.().get('memory')).toBeUndefined();
    await off.runtime.finish({});

    for (const mode of ['ask', 'auto'] as const) {
      const r = await boot({ memory: { mode } });
      const tool = r.runtime.toolRegistry?.().get('memory');
      expect(tool, `${mode} 模式应注册 memory 工具`).toBeDefined();
      expect(tool!.description).toContain('Persist proactively');
      await r.runtime.finish({});
    }
  });
});

describe('P7 CLI 装配：skill_author / run_script / subagent_fanout / 工具面', () => {
  it('skills.authoring=on → skill_author 注册；缺省 off → 不注册', async () => {
    const on = await boot({ skills: { authoring: 'on' } });
    expect(on.runtime.toolRegistry?.().get('skill_author')).toBeDefined();
    await on.runtime.finish({});

    const off = await boot({});
    expect(off.runtime.toolRegistry?.().get('skill_author')).toBeUndefined();
    await off.runtime.finish({});
  });

  it('run_script 与 subagent_fanout 均注册且可调用', async () => {
    const { runtime, root } = await boot({});
    const reg = runtime.toolRegistry!();
    const script = reg.get('run_script');
    expect(script).toBeDefined();
    const out = await script!.execute({ script: 'return 2 + 3;' }, { signal: new AbortController().signal, cwd: root });
    expect(out.error).toBeUndefined();
    expect(out.output).toContain('5');
    expect(reg.get('subagent_fanout')).toBeDefined();
    await runtime.finish({});
  });

  it('config.tools.enable=false → 禁用工具不进模型工具面', async () => {
    const { runtime } = await boot({ tools: { enable: { bash: false, run_script: false } } });
    const reg = runtime.toolRegistry!();
    expect(reg.get('bash')).toBeUndefined();
    expect(reg.get('run_script')).toBeUndefined();
    expect(reg.get('read')).toBeDefined();
    expect(runtime.toolSelection?.()).toEqual({ enable: { bash: false, run_script: false } });
    await runtime.finish({});
  });

  it('configPath = 项目 config.json（/tools select 落盘目标）', async () => {
    const { runtime, root } = await boot({});
    expect(runtime.configPath?.()).toBe(defaultConfigPaths(root).projectConfig);
    await runtime.finish({});
  });
});

describe('P7 CLI 装配：与 serve 记忆描述一致性（跨路径机器证据）', () => {
  it('CLI memory(auto) 描述 === core createMemoryToolForPolicy(auto) 描述', async () => {
    const r = await boot({ memory: { mode: 'auto' } });
    const cliTool = r.runtime.toolRegistry!().get('memory')!;
    const { MemoryStore } = await import('@harness2/core');
    const store = new MemoryStore(join(r.home, '.harness2', 'memories'));
    const policyTool = createMemoryToolForPolicy(store, 'auto', { sessionId: r.runtime.getCurrent()!.id })!;
    expect(cliTool.description).toBe(policyTool.description);
    await r.runtime.finish({});
  });
});

// P7 补强（覆盖矩阵）：记忆三模式 off/ask/auto 在 CLI 与 serve 两条装配路径上行为一致——
// 不仅「都与策略出口一致」，而且两条路径的 description **逐字相等**。serve 侧取 core SessionHub
// 的 per-turn 工具面（桌面/网关同一装配点），CLI 侧取 chat-setup 的真实产物。
describe('P7 记忆三模式跨装配路径一致（CLI ↔ serve ↔ 策略出口，description 逐字相等）', () => {
  const MODES = ['off', 'ask', 'auto'] as const;
  const SID = '20260914-777777-mem001';

  /** serve 侧：core SessionHub per-turn 工具面里的 memory 工具（off = 未装配 → undefined） */
  async function serveMemoryTool(root: string, mode: (typeof MODES)[number]) {
    const store = new MemoryStore(join(root, `mem-${mode}`));
    const tools = new ToolRegistry();
    registerBuiltinTools(tools);
    const hub = new SessionHub({
      manager: new SessionManager(join(root, `sess-${mode}`)),
      provider: new MockProvider([]),
      tools,
      cwd: root,
      ...(mode === 'off'
        ? {}
        : {
            memory: {
              store,
              mode,
              nudgeInterval: 10,
              ...(mode === 'ask' ? { pending: new PendingMemoryStore(join(root, `pend-${mode}`), store) } : {}),
            },
          }),
    });
    const tool = hub.toolsForSession(SID).get('memory');
    await hub.close();
    return tool;
  }

  for (const mode of MODES) {
    it(`${mode}：CLI 与 serve 的 memory 工具 description 逐字相等，且都等于策略出口`, async () => {
      const r = await boot({ memory: { mode } });
      const cliTool = r.runtime.toolRegistry?.().get('memory');
      const cliStore = new MemoryStore(join(r.home, '.harness2', 'memories'));
      const policyTool = createMemoryToolForPolicy(cliStore, mode, {
        ...(mode === 'ask'
          ? {
              pending: new PendingMemoryStore(join(r.home, '.harness2', 'memories', 'pending'), cliStore),
              sessionId: r.runtime.getCurrent()!.id,
            }
          : { sessionId: r.runtime.getCurrent()!.id }),
      });
      const serveTool = await serveMemoryTool(r.root, mode);

      if (mode === 'off') {
        expect(cliTool, 'off：CLI 不应注册 memory').toBeUndefined();
        expect(serveTool, 'off：serve 不应注册 memory').toBeUndefined();
        expect(policyTool, 'off：策略出口应返回 undefined').toBeUndefined();
      } else {
        expect(cliTool, `${mode}：CLI 应注册 memory`).toBeDefined();
        expect(serveTool, `${mode}：serve 应注册 memory`).toBeDefined();
        expect(cliTool!.name).toBe('memory');
        expect(cliTool!.description).toBe(serveTool!.description); // 两条装配路径逐字相等
        expect(cliTool!.description).toBe(policyTool!.description); // 且都等于唯一策略出口
      }
      await r.runtime.finish({});
    });
  }
});
