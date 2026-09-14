// H-43 零开销轮次测试（P7-C，本阶段优先级最高的一条）。
//
// 三段：
//   ① RPC 服务与协议：帧编解码 / 三方法 / 审批不可绕过 / 白名单 / 超时 / 输出上限；
//   ② stdio 桥：流式逐行服务（子进程入口的协议层）；
//   ③ 零开销轮次的**计量证据**：同一任务分别走「模型逐次调工具」与「脚本 RPC 调工具」
//      两条路径，统计每一次模型请求的 prompt 规模（messages + tool schema 全量 JSON/4），
//      并断言 RPC 路径显著更低、且中间工具结果**没有**进入模型上下文。
//
// P0-1（修复棒）：run_script 的执行边界用例——脚本跑在独立 Node 子进程里（旧实现的 node:vm
// 不是安全边界：注入的宿主函数经构造器链可拿宿主 global）。本文件既有「逃逸手法拿不到宿主
// 对象」的正面用例，也有「同款手法对旧的宿主对象直注入形态确实能拿到宿主 global」的反证
// （变异取证：证明断言非空转），外加「内层调用仍受审批拒绝」与「描述如实声明边界」两条。
//
// 计量方式（可复核）：promptTokens = Σ_requests ceil((JSON.stringify(messages).length +
// JSON.stringify(tools ?? []).length) / 4)。取数来源是 MockProvider.requests（每次
// streamChat 收到的原始 ChatRequest），即真正发给模型的东西，不含任何推断。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { runTurn } from '../src/agent/loop.js';
import type { ChatProvider, ChatRequest } from '../src/provider/types.js';
import { MockProvider, type MockScript } from '../src/provider/mock.js';
import { SessionManager } from '../src/session/manager.js';
import { applyToolSelection } from '../src/tools/selection.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { ToolRpcService, TOOL_RPC_DEFAULT_MAX_OUTPUT_CHARS } from '../src/tools/rpc.js';
import {
  TOOL_RPC_PROTOCOL,
  ToolRpcLineServer,
  createInProcessRpcClient,
  decodeToolRpcLine,
  encodeToolRpcLine,
  serveToolRpcStream,
} from '../src/tools/rpc-stdio.js';
import { SCRIPT_TOOL_NAME, createScriptTool } from '../src/tools/script.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-rpc-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ctx = { signal: new AbortController().signal, cwd: process.cwd() };

/** 产出一条大结果（用于 token 计量：2000 字符 ≈ 500 token） */
function heavyReader(): ToolDefinition {
  return {
    name: 'heavy_reader',
    description: '返回一大段带标记的正文（计量用）',
    parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
    execute: (args) => {
      const n = (args as { n?: number })?.n ?? 0;
      return { output: `MARKER-${n}|` + 'x'.repeat(2000) };
    },
  };
}

/** 每次模型请求的真实 prompt 规模（messages + tool schema；单位 = 字符/4，与 core 估算口径一致） */
function requestTokens(req: ChatRequest): number {
  return Math.ceil((JSON.stringify(req.messages).length + JSON.stringify(req.tools ?? []).length) / 4);
}

function sumTokens(requests: readonly ChatRequest[]): number {
  return requests.reduce((acc, r) => acc + requestTokens(r), 0);
}

describe('H-43 RPC 服务与协议', () => {
  it('帧编解码：请求/响应一行 JSON；坏行/缺 method 明确报错（不抛给传输层）', () => {
    const line = encodeToolRpcLine({ id: 7, method: 'tools.list' });
    expect(line.endsWith('\n')).toBe(true);
    const decoded = decodeToolRpcLine(line);
    expect('error' in decoded).toBe(false);
    expect(decoded).toMatchObject({ id: 7, method: 'tools.list' });
    expect(decodeToolRpcLine('')).toMatchObject({ error: expect.stringContaining('空行') });
    expect(decodeToolRpcLine('{oops')).toMatchObject({ error: expect.stringContaining('合法 JSON') });
    expect(decodeToolRpcLine('[1,2]')).toMatchObject({ error: expect.stringContaining('JSON 对象') });
    expect(decodeToolRpcLine('{"id":1}')).toMatchObject({ error: expect.stringContaining('method') });
  });

  it('协议往返：tools.list / tools.describe / tool.call（进程内客户端走真实帧编解码）', async () => {
    const registry = new ToolRegistry();
    registry.register(heavyReader());
    const service = new ToolRpcService({ registry, cwd: process.cwd() });
    const client = createInProcessRpcClient(service);
    const list = (await client.list()) as Array<{ name: string; category: string }>;
    expect(list.map((t) => t.name)).toEqual(['heavy_reader']);
    expect(list[0]?.category).toBe('plugin'); // 未登记名字 → 插件来源（诚实归类）
    const described = (await client.describe('heavy_reader')) as { description: string };
    expect(described.description).toContain('计量用');
    const call = (await client.call('heavy_reader', { n: 5 })) as { ok: boolean; output: string };
    expect(call.ok).toBe(true);
    expect(call.output.startsWith('MARKER-5|')).toBe(true);
    await expect(client.describe('ghost')).rejects.toThrow(/未找到工具/);
  });

  it('未知方法与坏行都回协议错误帧（服务不崩、不抛）', async () => {
    const registry = new ToolRegistry();
    const service = new ToolRpcService({ registry, cwd: process.cwd() });
    const server = new ToolRpcLineServer(service);
    const bad = await server.handleLine('not-json');
    expect(JSON.parse(bad!)).toMatchObject({ ok: false });
    const unknown = JSON.parse((await server.handleLine('{"id":3,"method":"nope"}'))!) as {
      ok: boolean;
      error: string;
    };
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('未知 RPC 方法');
    expect(await server.handleLine('  ')).toBeUndefined(); // 空行无响应
  });

  it('审批不可绕过：decide=deny → 工具不执行，返回 denied', async () => {
    let executed = 0;
    const registry = new ToolRegistry();
    registry.register({
      ...heavyReader(),
      execute: () => {
        executed += 1;
        return { output: 'should-not-run' };
      },
    });
    const service = new ToolRpcService({ registry, cwd: process.cwd(), approval: { decide: () => 'deny' } });
    const result = await service.call('heavy_reader', { n: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('denied by approval policy');
    expect(executed).toBe(0);
    // ask 无 onAsk 回调 → 按拒绝处理（与执行器同口径）
    const askService = new ToolRpcService({ registry, cwd: process.cwd(), approval: { decide: () => 'ask' } });
    const askRes = await askService.call('heavy_reader', { n: 1 });
    expect(askRes.ok).toBe(false);
    expect(executed).toBe(0);
  });

  it('白名单：被 tools 配置剔除的工具在 RPC 侧就是 unknown tool，脚本也拿不到', async () => {
    const registry = new ToolRegistry();
    registry.register(heavyReader());
    registry.register({
      name: 'bash',
      description: 'dummy',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ output: 'nope' }),
    });
    const filtered = applyToolSelection(registry, { enable: { bash: false } });
    const service = new ToolRpcService({ registry: filtered, cwd: process.cwd() });
    expect(service.list().map((t) => t.name)).toEqual(['heavy_reader']);
    expect((await service.call('bash', {})).error).toContain('unknown tool: bash');
  });

  it('超时：工具超服务级 timeoutMs → 明确报错且工具被中止（signal aborted）', async () => {
    let aborted = false;
    const registry = new ToolRegistry();
    registry.register({
      name: 'sleepy',
      description: '永不返回（除非被中止）',
      parameters: { type: 'object', properties: {} },
      cancelGuaranteed: true,
      execute: (_args, toolCtx) =>
        new Promise((resolve) => {
          toolCtx.signal.addEventListener('abort', () => {
            aborted = true;
            resolve({ error: 'aborted' });
          });
        }),
    });
    const service = new ToolRpcService({ registry, cwd: process.cwd(), timeoutMs: 60 });
    const result = await service.call('sleepy', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('超时');
    expect(aborted).toBe(true);
  });

  it('输出上限：超过 maxOutputChars 截断并标记 truncated', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'chatty',
      description: 'big',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ output: 'y'.repeat(500) }),
    });
    const service = new ToolRpcService({ registry, cwd: process.cwd(), maxOutputChars: 100 });
    const result = await service.call('chatty', {});
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.output).toContain('[rpc 输出截断');
    expect(result.output!.length).toBeLessThan(200);
    // 缺省上限开得足够大（不误伤普通工具输出）
    expect(TOOL_RPC_DEFAULT_MAX_OUTPUT_CHARS).toBe(100_000);
  });

  it('stdio 桥：逐行读取请求、逐行写回响应（子进程入口的协议层）', async () => {
    const registry = new ToolRegistry();
    registry.register(heavyReader());
    const service = new ToolRpcService({ registry, cwd: process.cwd() });
    const out: string[] = [];
    const input = (async function* () {
      yield encodeToolRpcLine({ id: 1, method: 'tools.list' });
      yield encodeToolRpcLine({ id: 2, method: 'tool.call', params: { name: 'heavy_reader', args: { n: 9 } } });
      yield '{"id":3'; // 无换行尾部：EOF 语义也要处理
    })();
    await serveToolRpcStream(service, input, {
      write: (chunk: string) => {
        out.push(chunk);
        return true;
      },
    });
    const responses = out
      .join('')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l)) as Array<{ id: number; ok: boolean }>;
    expect(responses.map((r) => r.id)).toEqual([1, 2, 0]);
    expect(responses[0]?.ok).toBe(true);
    expect(responses[1]?.ok).toBe(true);
    expect(responses[2]?.ok).toBe(false); // 尾部坏行 → 协议错误帧
  });
});

describe('H-43 run_script 工具（独立子进程执行边界）', () => {
  it('脚本可列工具、调工具并返回紧凑结果；输出即脚本返回值', async () => {
    const registry = new ToolRegistry();
    registry.register(heavyReader());
    const service = new ToolRpcService({ registry, cwd: process.cwd() });
    const tool = createScriptTool({ service });
    expect(tool.name).toBe(SCRIPT_TOOL_NAME);
    const out = await tool.execute(
      {
        script:
          'const names = (await harness.tools.list()).map((t) => t.name);\n' +
          "const r = await harness.tools.call('heavy_reader', { n: 4 });\n" +
          'return { names, ok: r.ok, bytes: r.output.length };',
      },
      ctx,
    );
    expect(out.error).toBeUndefined();
    expect(JSON.parse(out.output!)).toEqual({ names: ['heavy_reader'], ok: true, bytes: 2009 });
  });

  // —— P0-1：逃逸用例（替换原先只测 `typeof process/require` 的「假沙箱」用例）——
  // 原用例断言 vm context 里没有 process/require，给出的是**虚假保证**：宿主的 client 函数
  // 一旦被注入，构造器链就能取到宿主 global。新口径：脚本在独立 Node 子进程里，逃逸拿到的
  // 只能是**子进程自己**的 realm（拿不到宿主 globalThis/process/registry/审批缝）。
  const HOST_SENTINEL = '__h2HostSentinel__';

  it('逃逸手法（≥4 种构造器链）拿不到宿主 global/process：命中的是子进程自己的 realm', async () => {
    const host = globalThis as Record<string, unknown>;
    host[HOST_SENTINEL] = 'HOST-ONLY';
    try {
      const registry = new ToolRegistry();
      const service = new ToolRpcService({ registry, cwd: process.cwd() });
      const tool = createScriptTool({ service });
      const script = `
        const hostGlobal = globalThis;
        const probe = (g) => ({
          sentinel: typeof g.${HOST_SENTINEL},
          isChildGlobal: g === hostGlobal,
          pid: g !== null && typeof g === 'object' && typeof g.process === 'object' && g.process !== null
            ? g.process.pid
            : null,
          requireOnGlobal: typeof g.require,
          childProcess: g !== null && typeof g === 'object' && typeof g.process === 'object' && g.process !== null
            && typeof g.process.getBuiltinModule === 'function'
            ? typeof g.process.getBuiltinModule('child_process').execSync
            : 'n/a',
        });
        const cheats = [
          harness.tools.call.constructor.constructor('return this')(),
          harness.tools.list.constructor.constructor('return this')(),
          harness.constructor.constructor('return globalThis')(),
          (function () {}).constructor('return this')(),
          Function('return globalThis')(),
          Object.constructor('return this')(),
        ];
        // 异步函数构造器返回的是 Promise，await 后同样是子进程自己的 global
        cheats.push(await Object.getPrototypeOf(async function () {}).constructor('return this')());
        const seen = cheats.map(probe);
        // 报告里的实测逃逸链（P0-1）：现在只在**子进程**里执行命令
        const escaped = harness.tools.call.constructor.constructor('return this')().process
          .getBuiltinModule('child_process').execSync('echo escaped').toString().trim();
        return { seen, escaped, myPid: process.pid };
      `;
      const out = await tool.execute({ script }, ctx);
      expect(out.error).toBeUndefined();
      const parsed = JSON.parse(out.output!) as {
        seen: Array<Record<string, unknown>>;
        escaped: string;
        myPid: number;
      };
      expect(parsed.seen).toHaveLength(7);
      for (const got of parsed.seen) {
        // 宿主 global 上的哨兵不可见（旧 node:vm 形态下这里是 'string'）
        expect(got['sentinel']).toBe('undefined');
        // 拿到的 process 是子进程的（pid 与宿主不同）；子进程自身可起命令（bash 同级，如实声明）
        expect(typeof got['pid']).toBe('number');
        expect(got['pid']).not.toBe(process.pid);
        expect(got['childProcess']).toBe('function');
      }
      // 报告里的实测逃逸链：它现在只在**子进程**里执行命令，绝不落到宿主
      expect(parsed.escaped).toBe('escaped');
      expect(parsed.myPid).not.toBe(process.pid);
    } finally {
      delete host[HOST_SENTINEL];
    }
  });

  it('变异取证（反证非空转）：同款逃逸手法对「宿主对象直注入」的旧 node:vm 形态确实能拿到宿主 global', () => {
    const host = globalThis as Record<string, unknown>;
    host[HOST_SENTINEL] = 'HOST-ONLY';
    try {
      const registry = new ToolRegistry();
      const service = new ToolRpcService({ registry, cwd: process.cwd() });
      // 旧形态：宿主 realm 的 client 函数被直接注入 vm context（P0-1 的漏洞成因）
      const sandbox = {
        harness: Object.freeze({ protocol: TOOL_RPC_PROTOCOL, tools: createInProcessRpcClient(service) }),
      };
      const got = runInContext(
        "(function () { const g = harness.tools.call.constructor.constructor('return this')();" +
          ` return { sentinel: typeof g.${HOST_SENTINEL}, pid: g.process.pid }; })()`,
        createContext(sandbox),
      ) as { sentinel: string; pid: number };
      // 逃逸在旧形态下是真的：拿到宿主 global（哨兵可见）与宿主进程 pid
      expect(got.sentinel).toBe('string');
      expect(got.pid).toBe(process.pid);
    } finally {
      delete host[HOST_SENTINEL];
    }
  });

  it('子进程执行不改变审批语义：脚本内层调用被审批拒绝 → { ok:false }（不可绕过）', async () => {
    let executed = 0;
    const registry = new ToolRegistry();
    registry.register({
      ...heavyReader(),
      execute: () => {
        executed += 1;
        return { output: 'should-not-run' };
      },
    });
    const service = new ToolRpcService({ registry, cwd: process.cwd(), approval: { decide: () => 'deny' } });
    const tool = createScriptTool({ service });
    const out = await tool.execute(
      { script: "const r = await harness.tools.call('heavy_reader', { n: 1 }); return r;" },
      ctx,
    );
    expect(out.error).toBeUndefined();
    expect(JSON.parse(out.output!)).toMatchObject({ ok: false });
    expect(JSON.parse(out.output!).error).toContain('denied by approval policy');
    expect(executed).toBe(0);
  });

  // —— P1-3：声明的边界必须钉死在工具描述里（脚本内改动不可 undo / 不进观察面）——
  it('工具描述如实声明边界：子进程、与 bash 同级代码执行、内层改动不进快照/不可 undo、不进观察面', () => {
    const registry = new ToolRegistry();
    const service = new ToolRpcService({ registry, cwd: process.cwd() });
    const description = createScriptTool({ service }).description;
    expect(description).toContain('separate Node child process');
    expect(description).toContain('code execution equivalent to bash');
    expect(description).toContain('cannot be reverted with /undo');
    expect(description).toContain('stay out of the execution observer');
    expect(description).not.toContain('sandbox'); // 不再有「沙箱」表述
    expect(description).not.toContain('cannot bypass'); // 不再有「无法绕过审批」这类过强表述
  });

  it('脚本异常/语法错误/空脚本：如实返回 error（不击穿 turn）', async () => {
    const registry = new ToolRegistry();
    const service = new ToolRpcService({ registry, cwd: process.cwd() });
    const tool = createScriptTool({ service });
    expect((await tool.execute({ script: '   ' }, ctx)).error).toContain('非空字符串');
    expect((await tool.execute({ script: 'throw new Error("boom")' }, ctx)).error).toContain('boom');
    expect((await tool.execute({ script: 'syntax error here(' }, ctx)).error).toContain('run_script 执行失败');
    // 脚本内放弃的工具调用（不存在）不抛出协议错，而是 { ok:false }
    const out = await tool.execute({ script: "const r = await harness.tools.call('ghost', {}); return r.error;" }, ctx);
    expect(out.output).toContain('unknown tool: ghost');
  });

  it('脚本总时长超时：run_script 返回超时错误并杀掉子进程（不永久挂住 turn）', async () => {
    const registry = new ToolRegistry();
    const service = new ToolRpcService({ registry, cwd: process.cwd() });
    const tool = createScriptTool({ service, timeoutMs: 300 });
    const started = Date.now();
    // 同步死循环：子进程形态下只能靠杀进程兜底（vm timeout 已不再需要）
    const out = await tool.execute({ script: 'while (true) {}' }, ctx);
    expect(out.error).toContain('超时');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('H-43 零开销轮次：token 计量证据（两条路径对比）', () => {
  it('同一任务：模型逐次调工具 vs 脚本 RPC 调工具 —— RPC 路径 prompt 显著更低且工具结果未进上下文', async () => {
    const root = tmpDir();

    // —— 两条路径共用同一份「真实工具面」与同一份 RPC 服务 ——
    const serviceRegistry = new ToolRegistry();
    serviceRegistry.register(heavyReader());
    const service = new ToolRpcService({ registry: serviceRegistry, cwd: root });
    const runTools = new ToolRegistry();
    runTools.register(heavyReader());
    runTools.register(createScriptTool({ service }));

    const script =
      'const rows = [];\n' +
      'for (const n of [1, 2, 3]) {\n' +
      "  const r = await harness.tools.call('heavy_reader', { n });\n" +
      "  rows.push({ n, ok: r.ok, bytes: (r.output ?? '').length });\n" +
      '}\n' +
      'return { checked: rows.length, totalBytes: rows.reduce((a, b) => a + b.bytes, 0) };';

    // —— 路径 A：模型逐次调工具（3 次工具调用 → 3 份完整结果进上下文）——
    const providerA = new MockProvider([
      { toolCalls: [{ id: 'a1', name: 'heavy_reader', arguments: '{"n":1}' }] },
      { toolCalls: [{ id: 'a2', name: 'heavy_reader', arguments: '{"n":2}' }] },
      { toolCalls: [{ id: 'a3', name: 'heavy_reader', arguments: '{"n":3}' }] },
      { text: 'done A' },
    ] satisfies MockScript);
    const managerA = new SessionManager(join(root, 'a'));
    const sessionA = managerA.create(root, { fsync: false });
    const resultA = await runTurn(sessionA.writer, {
      provider: providerA,
      tools: runTools,
      cwd: root,
      userText: '读三份大文件并汇总',
      maxSteps: 10,
      approval: { decide: () => 'allow' },
    });
    sessionA.writer.close();

    // —— 路径 B：一次 run_script，脚本内部 RPC 调 3 次工具，只回紧凑汇总 ——
    const providerB = new MockProvider([
      { toolCalls: [{ id: 'b1', name: 'run_script', arguments: JSON.stringify({ script }) }] },
      { text: 'done B' },
    ] satisfies MockScript);
    const managerB = new SessionManager(join(root, 'b'));
    const sessionB = managerB.create(root, { fsync: false });
    const resultB = await runTurn(sessionB.writer, {
      provider: providerB,
      tools: runTools,
      cwd: root,
      userText: '读三份大文件并汇总',
      maxSteps: 10,
      approval: { decide: () => 'allow' },
    });
    sessionB.writer.close();

    // 前置：两条路径都真实完成（结果等价，代价不同）
    expect(resultA.stopReason).toBe('end_turn');
    expect(resultA.finalText).toBe('done A');
    expect(resultB.stopReason).toBe('end_turn');
    expect(resultB.finalText).toBe('done B');

    // —— 计量 ——
    const tokensA = sumTokens(providerA.requests);
    const tokensB = sumTokens(providerB.requests);
    const messagesA = providerA.requests.reduce((n, r) => n + r.messages.length, 0);
    const messagesB = providerB.requests.reduce((n, r) => n + r.messages.length, 0);

    // 路径 A：3 次模型往返（4 个请求）；路径 B：1 次（2 个请求）
    expect(providerA.requests).toHaveLength(4);
    expect(providerB.requests).toHaveLength(2);
    expect(messagesB).toBeLessThan(messagesA);
    expect(tokensB * 3).toBeLessThan(tokensA); // 「显著更低」的保守断言：不到 1/3
    // 留痕数字（审查者可直接复核）：A 的 prompt 规模随结果份数线性增长
    expect(tokensA).toBeGreaterThan(3000);
    expect(tokensB).toBeLessThan(1500);

    // —— 核心断言：工具结果未进模型上下文 ——
    const dumpA = JSON.stringify(providerA.requests.map((r) => r.messages));
    const dumpB = JSON.stringify(providerB.requests.map((r) => r.messages));
    // A：三份大结果的标记都在上下文里（反证计量不是空转）
    for (const marker of ['MARKER-1', 'MARKER-2', 'MARKER-3']) expect(dumpA).toContain(marker);
    // B：没有任何一份原始工具结果进入上下文；只有脚本的紧凑汇总
    for (const marker of ['MARKER-1', 'MARKER-2', 'MARKER-3']) expect(dumpB).not.toContain(marker);
    expect(dumpB).toContain('totalBytes');
    expect(dumpB).not.toContain('x'.repeat(2000));

    // —— 会话日志侧的证据：B 的父会话只有一条 tool/result（脚本输出），A 有三条大结果 ——
    const { loadSession } = await import('../src/session/reader.js');
    const eventsA = loadSession(sessionA.dir).events.filter((e) => e.event.type === 'tool/result');
    const eventsB = loadSession(sessionB.dir).events.filter((e) => e.event.type === 'tool/result');
    expect(eventsA).toHaveLength(3);
    expect(eventsB).toHaveLength(1);
    expect(eventsA.every((e) => ((e.event.payload as { output?: string }).output ?? '').includes('MARKER'))).toBe(true);
    expect(((eventsB[0]!.event.payload as { output?: string }).output ?? '').includes('MARKER')).toBe(false);

    // 报告口径输出（测试运行时留痕，便于复核）
    console.log(
      `[H-43] path A(tool-per-call): requests=${providerA.requests.length} messages=${messagesA} promptTokens≈${tokensA}` +
        ` | path B(script RPC): requests=${providerB.requests.length} messages=${messagesB} promptTokens≈${tokensB}` +
        ` | saved≈${tokensA - tokensB} tokens (${Math.round((1 - tokensB / tokensA) * 100)}%)`,
    );
  });

  it('计量口径自证：RPC 路径省下的正是"中间工具结果"的体量（等量输出对比）', async () => {
    const root = tmpDir();
    const serviceRegistry = new ToolRegistry();
    serviceRegistry.register(heavyReader());
    const service = new ToolRpcService({ registry: serviceRegistry, cwd: root });
    const runTools = new ToolRegistry();
    runTools.register(heavyReader());
    runTools.register(createScriptTool({ service }));

    const makeSession = (name: string) => {
      const manager = new SessionManager(join(root, name));
      return manager.create(root, { fsync: false });
    };

    // A：一次返回（模型直接拿到 2000 字符结果）
    const providerA = new MockProvider([
      { toolCalls: [{ id: 'x1', name: 'heavy_reader', arguments: '{"n":1}' }] },
      { text: 'ok' },
    ]);
    const sA = makeSession('a');
    await runTurn(sA.writer, {
      provider: providerA,
      tools: runTools,
      cwd: root,
      userText: 'q',
      approval: { decide: () => 'allow' },
    });
    sA.writer.close();

    // B：脚本内部读同一份输出，但只回它的长度
    const providerB = new MockProvider([
      {
        toolCalls: [
          {
            id: 'x2',
            name: 'run_script',
            arguments: JSON.stringify({
              script:
                "const r = await harness.tools.call('heavy_reader', { n: 1 });\n" +
                'return { bytes: r.output.length };',
            }),
          },
        ],
      },
      { text: 'ok' },
    ]);
    const sB = makeSession('b');
    await runTurn(sB.writer, {
      provider: providerB,
      tools: runTools,
      cwd: root,
      userText: 'q',
      approval: { decide: () => 'allow' },
    });
    sB.writer.close();

    // B 的第二请求（带工具结果的那次）显著小于 A 的第二次请求：差值 ≈ 2000 字符 ≈ 500 token
    const secondA = providerA.requests[1];
    const secondB = providerB.requests[1];
    expect(secondA).toBeDefined();
    expect(secondB).toBeDefined();
    const delta = requestTokens(secondA!) - requestTokens(secondB!);
    expect(delta).toBeGreaterThan(400); // ≈ 500（2000 字符 / 4）
    expect(delta).toBeLessThan(700);
  });

  // 口径复核（P7 覆盖矩阵补强，本阶段最高优先项）：
  // 既有计量 requestTokens 把 tools schema 也算进每个请求——路径 A 有 4 个请求、B 有 2 个，
  // 同一份 schema 在 A 里被重复计数 2 次（≈481 token），会**放大**「省下多少」。本条把该成分
  // 显式量化并从结论里剔除：(a) 证明 schema 是受控变量（两路径逐请求字节相同 → 可在差值中抵消），
  // (b) 用 messages-only 计量给出与 tools 序列化无关的硬结论，(c) 证明 schema 重复计数不足以解释
  // 省下的量（< 总节省的 1/5），(d) 逐请求（而非聚合）断言原始工具结果标记不出现。
  it('口径复核：剔除 tools 序列化后结论不变，省下的主体是工具结果而非 schema 重复计数', async () => {
    const root = tmpDir();
    const serviceRegistry = new ToolRegistry();
    serviceRegistry.register(heavyReader());
    const service = new ToolRpcService({ registry: serviceRegistry, cwd: root });
    const runTools = new ToolRegistry();
    runTools.register(heavyReader());
    runTools.register(createScriptTool({ service }));

    const script =
      'const rows = [];\n' +
      'for (const n of [1, 2, 3]) {\n' +
      "  const r = await harness.tools.call('heavy_reader', { n });\n" +
      "  rows.push({ n, ok: r.ok, bytes: (r.output ?? '').length });\n" +
      '}\n' +
      'return { checked: rows.length, totalBytes: rows.reduce((a, b) => a + b.bytes, 0) };';

    const providerA = new MockProvider([
      { toolCalls: [{ id: 'a1', name: 'heavy_reader', arguments: '{"n":1}' }] },
      { toolCalls: [{ id: 'a2', name: 'heavy_reader', arguments: '{"n":2}' }] },
      { toolCalls: [{ id: 'a3', name: 'heavy_reader', arguments: '{"n":3}' }] },
      { text: 'done A' },
    ] satisfies MockScript);
    const sessionA = new SessionManager(join(root, 'a')).create(root, { fsync: false });
    await runTurn(sessionA.writer, {
      provider: providerA,
      tools: runTools,
      cwd: root,
      userText: '读三份大文件并汇总',
      maxSteps: 10,
      approval: { decide: () => 'allow' },
    });
    sessionA.writer.close();

    const providerB = new MockProvider([
      { toolCalls: [{ id: 'b1', name: 'run_script', arguments: JSON.stringify({ script }) }] },
      { text: 'done B' },
    ] satisfies MockScript);
    const sessionB = new SessionManager(join(root, 'b')).create(root, { fsync: false });
    await runTurn(sessionB.writer, {
      provider: providerB,
      tools: runTools,
      cwd: root,
      userText: '读三份大文件并汇总',
      maxSteps: 10,
      approval: { decide: () => 'allow' },
    });
    sessionB.writer.close();

    const chars = (req: ChatRequest, part: 'messages' | 'tools'): number =>
      JSON.stringify(part === 'messages' ? req.messages : (req.tools ?? [])).length;
    const sumChars = (reqs: readonly ChatRequest[], part: 'messages' | 'tools'): number =>
      reqs.reduce((n, r) => n + chars(r, part), 0);

    // ① 受控变量：tools schema 在每个请求里字节数一致（两路径同一份工具面）→ 可在差值中抵消
    const toolsA = providerA.requests.map((r) => chars(r, 'tools'));
    const toolsB = providerB.requests.map((r) => chars(r, 'tools'));
    expect(new Set(toolsA).size).toBe(1);
    expect(new Set(toolsB).size).toBe(1);
    expect(toolsA[0]).toBe(toolsB[0]);
    expect(providerB.requests[0]!.tools).toEqual(providerA.requests[0]!.tools);

    // ② messages-only 计量（与 tools 序列化无关）：B 的上下文规模比 A 小一个数量级
    const msgA = sumChars(providerA.requests, 'messages');
    const msgB = sumChars(providerB.requests, 'messages');
    expect(msgB * 5).toBeLessThan(msgA); // 实测 ≈ 24×（13260 vs 556 字符）

    // ③ schema 重复计数显式量化并设上界：< 总节省的 1/4，且 < messages-only 差值（真正的证据量）
    const totalA = msgA + sumChars(providerA.requests, 'tools');
    const totalB = msgB + sumChars(providerB.requests, 'tools');
    const schemaDoubleCount = toolsA[0]! * (providerA.requests.length - providerB.requests.length);
    // P0-1 起 run_script 描述更长（如实声明子进程/不可 undo 等边界）→ tools schema/请求 由 ≈950
    // 涨到 ≈1600 字符，重复计数占比随之由 ≈13% 升到 ≈20%（实测值见下方留痕），故上界取 1/4。
    expect(schemaDoubleCount).toBeLessThan((totalA - totalB) / 4);
    // 结论仍成立：重复计数 < 消息体量的差值（省下的主体是中间工具结果，不是 schema 重复计数）
    expect(schemaDoubleCount).toBeLessThan(msgA - msgB);

    // ④ 逐请求断言（不只聚合）：B 的**每一次**请求都不含任何原始工具结果标记
    for (const req of providerB.requests) {
      const dump = JSON.stringify(req.messages);
      for (const marker of ['MARKER-1', 'MARKER-2', 'MARKER-3']) expect(dump).not.toContain(marker);
    }
    // 反证标记检查非空转：A 的末次请求累计了三份原始结果
    const dumpALast = JSON.stringify(providerA.requests[providerA.requests.length - 1]!.messages);
    for (const marker of ['MARKER-1', 'MARKER-2', 'MARKER-3']) expect(dumpALast).toContain(marker);

    // B 上下文里最大的单条消息就是脚本紧凑汇总 + 内联脚本体，远小于一份 2000 字符工具结果
    const maxMsgCharsB = Math.max(
      ...providerB.requests.flatMap((r) => r.messages.map((m) => JSON.stringify(m).length)),
    );
    const maxMsgCharsA = Math.max(
      ...providerA.requests.flatMap((r) => r.messages.map((m) => JSON.stringify(m).length)),
    );
    expect(maxMsgCharsB).toBeLessThan(700);
    expect(maxMsgCharsA).toBeGreaterThan(1500); // 一份 ~2000 字符结果确实进过 A 的上下文

    console.log(
      `[H-43 口径复核] messages-only chars: A=${msgA} B=${msgB}（${(msgA / msgB).toFixed(1)}×）` +
        ` | tools schema/请求=${toolsA[0]} chars × (A 4 请求 vs B 2 请求) → 重复计数贡献=${schemaDoubleCount} chars` +
        ` = 总节省 ${totalA - totalB} 的 ${((schemaDoubleCount / (totalA - totalB)) * 100).toFixed(1)}%`,
    );
  });
});

describe('H-43 计量辅助（口径守卫）', () => {
  it('requestTokens 把 messages 与 tool schema 都算进去（不是只数消息条数）', () => {
    const base: ChatRequest = { messages: [{ role: 'user', content: '你好' }] };
    const withTool: ChatRequest = {
      messages: [{ role: 'user', content: '你好' }],
      tools: [{ name: 'x', description: 'd'.repeat(400), parameters: {} }],
    };
    expect(requestTokens(withTool)).toBeGreaterThan(requestTokens(base));
  });

  it('provider 契约：MockProvider 记录的是原始请求（计量取数来源可复核）', async () => {
    const provider: ChatProvider = new MockProvider([{ text: 'hi' }]);
    expect(provider.name).toBe('mock');
    const registry = new ToolRegistry();
    const manager = new SessionManager(join(tmpDir(), 's'));
    const session = manager.create(tmpDir(), { fsync: false });
    await runTurn(session.writer, { provider, tools: registry, cwd: process.cwd(), userText: 'ping' });
    session.writer.close();
    const mock = provider as MockProvider;
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.messages[0]).toEqual({ role: 'user', content: 'ping' });
  });
});
