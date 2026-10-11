// A09 hook 运行器/执行器测试：matcher 命中矩阵、stdin 注入、输出解释（拦截/改写/回注）、
// 失败策略（fail-open）、超时、env 白名单、输出截断（真实 node -e）。
import { describe, expect, it, vi } from 'vitest';
import type { HooksConfig } from '../src/config/schema.js';
import { matchHookMatcher, eventSupportsMatcher } from '../src/hooks/matcher.js';
import { buildHookEnv, defaultSpawnHook, type HookSpawnHook, type HookSpawnInput } from '../src/hooks/executor.js';
import {
  createHookRunner,
  formatHookAdditionalContexts,
  hasConfiguredHooks,
  parseHookOutput,
} from '../src/hooks/runner.js';

function cfg(entries: HooksConfig['entries'], over: Partial<HooksConfig> = {}): HooksConfig {
  return { enabled: true, timeoutMs: 30_000, maxOutputBytes: 32_768, entries, ...over };
}

/** 记录调用 + 返回固定结果的 spawn mock */
function mockSpawn(result: Partial<Awaited<ReturnType<HookSpawnHook>>> = {}): {
  hook: HookSpawnHook;
  calls: HookSpawnInput[];
} {
  const calls: HookSpawnInput[] = [];
  const hook: HookSpawnHook = async (input) => {
    calls.push(input);
    return { status: 'completed', exitCode: 0, stdout: '', stderr: '', ...result };
  };
  return { hook, calls };
}

describe('hook matcher（复用 A16 matchGlob）', () => {
  it('缺省匹配全命中；空串 = 全命中', () => {
    expect(matchHookMatcher(undefined, 'bash')).toBe(true);
    expect(matchHookMatcher('', 'bash')).toBe(true);
  });
  it('精确名 / glob / ? 与全串锚定', () => {
    expect(matchHookMatcher('bash', 'bash')).toBe(true);
    expect(matchHookMatcher('bash', 'bashful')).toBe(false); // 全串锚定
    expect(matchHookMatcher('mcp__*', 'mcp__fs__read')).toBe(true);
    expect(matchHookMatcher('mcp__*', 'bash')).toBe(false);
    expect(matchHookMatcher('rea?', 'read')).toBe(true);
    expect(matchHookMatcher('rea?', 'rea')).toBe(false);
  });
  it('有 matcher 但无目标值 → false（fail-closed）', () => {
    expect(matchHookMatcher('bash', undefined)).toBe(false);
  });
  it('事件维度：仅工具事件支持 matcher', () => {
    expect(eventSupportsMatcher('preTool')).toBe(true);
    expect(eventSupportsMatcher('postTool')).toBe(true);
    expect(eventSupportsMatcher('turnEnd')).toBe(false);
  });
});

describe('运行器：匹配与执行', () => {
  it('未配置/未启用 = 零行为（不 spawn）', async () => {
    const { hook, calls } = mockSpawn();
    const runner = createHookRunner({ config: undefined, spawnHook: hook });
    const res = await runner.run({ event: 'preTool', toolName: 'bash', cwd: 'C:/x' });
    expect(res.invocations).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(hasConfiguredHooks(undefined)).toBe(false);
  });

  it('按事件过滤 + matcher 过滤；只有命中者执行（声明序）', async () => {
    const { hook, calls } = mockSpawn();
    const runner = createHookRunner({
      config: cfg([
        { event: 'preTool', matcher: 'read', command: 'hook-read' },
        { event: 'preTool', matcher: 'bash', command: 'hook-bash' },
        { event: 'postTool', command: 'hook-post' },
      ]),
      spawnHook: hook,
    });
    const res = await runner.run({ event: 'preTool', toolName: 'bash', args: { command: 'ls' }, cwd: 'C:/x' });
    expect(calls.map((c) => c.command)).toEqual(['hook-bash']);
    expect(res.invocations).toHaveLength(1);
    expect(res.invocations[0]).toMatchObject({
      event: 'preTool',
      command: 'hook-bash',
      target: 'bash',
      outcome: 'success',
    });
  });

  it('stdin 注入 JSON 上下文（含 tool_name / tool_input；postTool 带 tool_response）', async () => {
    const { hook, calls } = mockSpawn();
    const runner = createHookRunner({ config: cfg([{ event: 'postTool', command: 'h' }]), spawnHook: hook });
    await runner.run({
      event: 'postTool',
      toolName: 'read',
      args: { path: 'a' },
      output: 'hello',
      ok: true,
      cwd: 'C:/x',
    });
    const payload = JSON.parse(calls[0]!.stdin) as Record<string, unknown>;
    expect(payload['hook_event_name']).toBe('postTool');
    expect(payload['tool_name']).toBe('read');
    expect(payload['tool_input']).toEqual({ path: 'a' });
    expect(payload['tool_response']).toBe('hello');
    expect(payload['ok']).toBe(true);
    expect(calls[0]!.stdin.endsWith('\n')).toBe(true);
  });

  it('run 选项：注入 spawn 捕获超时/输出上限（透传自 config）', async () => {
    const { hook, calls } = mockSpawn();
    const runner = createHookRunner({
      config: cfg([{ event: 'preTool', command: 'h', timeoutMs: 1234 }], { maxOutputBytes: 777 }),
      spawnHook: hook,
    });
    await runner.run({ event: 'preTool', toolName: 'bash', cwd: 'C:/x' });
    expect(calls[0]!.timeoutMs).toBe(1234);
    expect(calls[0]!.maxOutputBytes).toBe(777);
  });
});

describe('运行器：输出解释', () => {
  it('exit 0 + JSON additionalContext → 回注段', async () => {
    const { hook } = mockSpawn({ stdout: '{"additionalContext":"记得跑测试"}' });
    const runner = createHookRunner({ config: cfg([{ event: 'postTool', command: 'h' }]), spawnHook: hook });
    const res = await runner.run({ event: 'postTool', toolName: 'bash', cwd: 'C:/x' });
    expect(res.additionalContexts).toEqual(['记得跑测试']);
    expect(res.blocked).toBeUndefined();
    expect(res.invocations[0]!.contextCount).toBe(1);
  });

  it('preTool：continue:false → 拦截（原因取自 reason）', async () => {
    const { hook } = mockSpawn({ stdout: '{"continue":false,"reason":"危险命令"}' });
    const runner = createHookRunner({ config: cfg([{ event: 'preTool', command: 'h' }]), spawnHook: hook });
    const res = await runner.run({ event: 'preTool', toolName: 'bash', cwd: 'C:/x' });
    expect(res.blocked).toEqual({ reason: '危险命令' });
    expect(res.invocations[0]!.outcome).toBe('success'); // exit 0；决策来自 JSON
  });

  it('preTool：hookSpecificOutput.permissionDecision=deny → 拦截', async () => {
    const { hook } = mockSpawn({
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'preTool', permissionDecision: 'deny', permissionDecisionReason: '策略' },
      }),
    });
    const runner = createHookRunner({ config: cfg([{ event: 'preTool', command: 'h' }]), spawnHook: hook });
    const res = await runner.run({ event: 'preTool', toolName: 'bash', cwd: 'C:/x' });
    expect(res.blocked?.reason).toBe('策略');
  });

  it('preTool：updatedInput 改写输入（顶层与 hookSpecificOutput 两形态）', async () => {
    const { hook } = mockSpawn({ stdout: '{"updatedInput":{"command":"echo safe"}}' });
    const runner = createHookRunner({ config: cfg([{ event: 'preTool', command: 'h' }]), spawnHook: hook });
    const res = await runner.run({ event: 'preTool', toolName: 'bash', cwd: 'C:/x' });
    expect(res.updatedInput).toEqual({ command: 'echo safe' });

    const { hook: hook2 } = mockSpawn({
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'preTool', updatedInput: { x: 1 } } }),
    });
    const runner2 = createHookRunner({ config: cfg([{ event: 'preTool', command: 'h' }]), spawnHook: hook2 });
    const res2 = await runner2.run({ event: 'preTool', toolName: 'bash', cwd: 'C:/x' });
    expect(res2.updatedInput).toEqual({ x: 1 });
  });

  it('非 JSON stdout（hook 打印日志）不失败、不解析（fail-open 语义）', async () => {
    const { hook } = mockSpawn({ stdout: 'just a log line' });
    const runner = createHookRunner({ config: cfg([{ event: 'preTool', command: 'h' }]), spawnHook: hook });
    const res = await runner.run({ event: 'preTool', toolName: 'bash', cwd: 'C:/x' });
    expect(res.blocked).toBeUndefined();
    expect(res.invocations[0]!.outcome).toBe('success');
    expect(res.additionalContexts).toEqual([]);
  });

  it('parseHookOutput：非 { 开头/坏 JSON/非对象 → undefined', () => {
    expect(parseHookOutput('plain')).toBeUndefined();
    expect(parseHookOutput('{bad')).toBeUndefined();
    expect(parseHookOutput('[1]')).toBeUndefined();
    expect(parseHookOutput('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('运行器：失败策略（fail-open）+ 拦截（exit 2）+ 超时', () => {
  it('exit 2（preTool）→ 拦截', async () => {
    const { hook } = mockSpawn({ exitCode: 2, stderr: '不允许' });
    const runner = createHookRunner({ config: cfg([{ event: 'preTool', command: 'h' }]), spawnHook: hook });
    const res = await runner.run({ event: 'preTool', toolName: 'bash', cwd: 'C:/x' });
    expect(res.blocked).toEqual({ reason: '不允许' });
    expect(res.invocations[0]!.outcome).toBe('blocked');
    expect(res.invocations[0]!.exitCode).toBe(2);
  });

  it('其它非零退出 → fail-open（不拦截）+ 记录 failed + 告警', async () => {
    const { hook } = mockSpawn({ exitCode: 1, stderr: 'boom' });
    const warn = vi.fn();
    const runner = createHookRunner({ config: cfg([{ event: 'preTool', command: 'h' }]), spawnHook: hook, warn });
    const res = await runner.run({ event: 'preTool', toolName: 'bash', cwd: 'C:/x' });
    expect(res.blocked).toBeUndefined();
    expect(res.invocations[0]!.outcome).toBe('failed');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('超时 → 记录 timeout + fail-open + 告警', async () => {
    const { hook } = mockSpawn({ status: 'timeout', exitCode: null, errorMessage: 'timed out' });
    const warn = vi.fn();
    const runner = createHookRunner({ config: cfg([{ event: 'postTool', command: 'h' }]), spawnHook: hook, warn });
    const res = await runner.run({ event: 'postTool', toolName: 'bash', cwd: 'C:/x' });
    expect(res.invocations[0]!.outcome).toBe('timeout');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('spawn 抛错 → 记录 spawn_error + fail-open', async () => {
    const hook: HookSpawnHook = async () => {
      throw new Error('ENOENT');
    };
    const warn = vi.fn();
    const runner = createHookRunner({ config: cfg([{ event: 'preTool', command: 'h' }]), spawnHook: hook, warn });
    const res = await runner.run({ event: 'preTool', toolName: 'bash', cwd: 'C:/x' });
    expect(res.invocations[0]!.outcome).toBe('spawn_error');
    expect(res.blocked).toBeUndefined();
  });

  it('admit 门控：返回 false 的条目跳过（不执行不记录）', async () => {
    const { hook, calls } = mockSpawn();
    const runner = createHookRunner({
      config: cfg([{ event: 'preTool', command: 'h' }]),
      spawnHook: hook,
      admit: () => false,
    });
    const res = await runner.run({ event: 'preTool', toolName: 'bash', cwd: 'C:/x' });
    expect(calls).toHaveLength(0);
    expect(res.invocations).toEqual([]);
  });

  it('async 条目：不等待、不进 invocations（fire-and-forget）', async () => {
    const calls: HookSpawnInput[] = [];
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    const hook: HookSpawnHook = async (input) => {
      calls.push(input);
      await pending; // 永不主动完成，直到测试释放
      return { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
    };
    const runner = createHookRunner({
      config: cfg([{ event: 'preTool', command: 'h', async: true }]),
      spawnHook: hook,
    });
    const res = await runner.run({ event: 'preTool', toolName: 'bash', cwd: 'C:/x' });
    expect(res.invocations).toEqual([]);
    expect(calls).toHaveLength(1);
    release();
  });
});

describe('执行器安全面：env 白名单 + 输出截断（真实 node -e）', () => {
  it('buildHookEnv：只透传白名单键 + 自注入 HARNESS2_*；宿主密钥不透传', () => {
    const env = buildHookEnv(
      {
        PATH: '/usr/bin',
        SystemRoot: 'C:/Windows',
        SECRET_API_KEY: 'sk-should-not-leak',
        AWS_SECRET_ACCESS_KEY: 'nope',
        HARNESS2_EXISTING: 'x',
      },
      { event: 'preTool', cwd: 'C:/work', sessionId: 's1' },
    );
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['SystemRoot']).toBe('C:/Windows');
    expect(env['HARNESS2_HOOK_EVENT']).toBe('preTool');
    expect(env['HARNESS2_CWD']).toBe('C:/work');
    expect(env['HARNESS2_SESSION_ID']).toBe('s1');
    expect(env['SECRET_API_KEY']).toBeUndefined();
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env['HARNESS2_EXISTING']).toBeUndefined();
  });

  it('默认执行器：真实 node -e 读 stdin 并回显（跨平台轻量真命令）', async () => {
    // 用单引号 JS 字符串（外层双引号由 shell 分组）避免跨平台引号转义问题
    const script =
      "let d='';process.stdin.on('data',(c)=>d+=c);process.stdin.on('end',()=>process.stdout.write('got:'+JSON.parse(d).tool_name));";
    const result = await defaultSpawnHook({
      command: `node -e "${script}"`,
      stdin: '{"tool_name":"read"}\n',
      cwd: process.cwd(),
      env: buildHookEnv(process.env, { event: 'postTool', cwd: process.cwd() }),
      timeoutMs: 20_000,
      maxOutputBytes: 4096,
    });
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('got:read');
  }, 30_000);

  it('默认执行器：输出超过 maxOutputBytes → 截断（不无限缓冲）', async () => {
    const result = await defaultSpawnHook({
      command: 'node -e "process.stdout.write(\'x\'.repeat(100000))"',
      stdin: '{}\n',
      cwd: process.cwd(),
      env: buildHookEnv(process.env, { event: 'turnEnd', cwd: process.cwd() }),
      timeoutMs: 20_000,
      maxOutputBytes: 100,
    });
    expect(result.status).toBe('completed');
    expect(result.stdout.length).toBe(100);
  }, 30_000);

  it('默认执行器：超时被击杀（status=timeout）', async () => {
    const result = await defaultSpawnHook({
      command: 'node -e "setTimeout(()=>{},60000)"',
      stdin: '{}\n',
      cwd: process.cwd(),
      env: buildHookEnv(process.env, { event: 'turnEnd', cwd: process.cwd() }),
      timeoutMs: 300,
      maxOutputBytes: 1024,
    });
    expect(result.status).toBe('timeout');
  }, 20_000);
});

describe('formatHookAdditionalContexts', () => {
  it('带标题与编号', () => {
    expect(formatHookAdditionalContexts(['a', 'b'])).toBe('[Hook additional context]\n#1\na\n#2\nb');
  });
});
