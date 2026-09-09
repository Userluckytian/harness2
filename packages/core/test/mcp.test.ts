// MCP 客户端测试（阶段 8 Task 2）：枚举注册 / namespaced 工具 / 调用往返 / isError /
// 名称冲突本地优先 / 批次隔离 / 断线退避重启 / flapping 耗尽下线 / stdio 与 url 端到端 /
// config.mcpServers schema 校验。
// 本地 MCP server 全部用同一 SDK 的 server 端构造（InMemory 配对 / stdio 子进程 / Streamable HTTP），
// 零外部依赖、零真实网络。
import { describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { McpManager, mcpResultToOutput, mcpToolName } from '../src/mcp/client.js';
import type { McpServerConfig } from '../src/config/schema.js';
import { parseConfig } from '../src/config/schema.js';

// —— 测试用本地 MCP server（同一 SDK 的 server 端） ——

interface LocalTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** 缺省 = echo 行为 */
  handler?: (args: Record<string, unknown>) => { content: unknown[]; isError?: boolean };
}

async function makeLinkedServer(opts: {
  tools?: LocalTool[];
  /** listTools 响应送达后关闭传输（模拟一次闪断） */
  killAfterList?: boolean;
}): Promise<{ transport: Transport; server: McpServer }> {
  const tools: LocalTool[] = opts.tools ?? [echoTool()];
  const server = new McpServer({ name: 'local-test-server', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (opts.killAfterList === true) {
      // 响应先送达客户端，再关闭传输（微延迟保证响应先出）
      setTimeout(() => {
        void serverTransport.close();
      }, 15);
    }
    return {
      tools: tools.map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (tool?.handler !== undefined) return tool.handler(args);
    return { content: [{ type: 'text', text: `echo:${String(args['msg'] ?? '')}` }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { transport: clientTransport, server };
}

function echoTool(): LocalTool {
  return {
    name: 'echo',
    description: '回显 msg',
    inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 15): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** 测试期 McpManager 公共参数（短退避 + 日志收集） */
function testManagerOptions(
  tools: ToolRegistry,
  lines: string[],
  transportFactory: (server: string, cfg: McpServerConfig) => Transport | Promise<Transport>,
  extra: { stableResetMs?: number } = {},
) {
  return {
    tools,
    logSink: (l: string) => lines.push(l),
    timeoutMs: 3000,
    backoffSchedule: [20, 20, 20] as const,
    maxRestarts: 3,
    stableResetMs: 0,
    transportFactory,
    ...extra,
  };
}

function stateOf(manager: McpManager, server: string) {
  return manager.status().find((s) => s.server === server)!;
}

const CALL_CTX = { signal: new AbortController().signal, cwd: '.' };

// —— 单元：名称空间化与结果文本化 ——

describe('mcpToolName / mcpResultToOutput', () => {
  it('namespaced 工具名 mcp__<server>__<tool>；非法字符折叠为 _（满足工具名约束）', () => {
    expect(mcpToolName('filesystem', 'read_file')).toBe('mcp__filesystem__read_file');
    expect(mcpToolName('My-Server', 'Do Thing!')).toBe('mcp__my_server__do_thing_');
    expect(/^[a-z0-9_]+$/.test(mcpToolName('A.B/C', 'X Y'))).toBe(true);
  });

  it('结果文本化：text 块拼接、非文本块占位、非数组容错', () => {
    expect(mcpResultToOutput([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toEqual({ output: 'a\nb' });
    expect(mcpResultToOutput([{ type: 'image', data: '...' }])).toEqual({ output: '[非文本内容 image]' });
    expect(mcpResultToOutput(undefined)).toEqual({ output: '' });
  });
});

// —— InMemory 端到端（同一 SDK server 端） ——

describe('McpManager 连接与工具注册（本地内存 server）', () => {
  it('枚举注册：namespaced 工具进注册表，schema 透传，unsafe（无 concurrencySafe）', async () => {
    const tools = new ToolRegistry();
    const lines: string[] = [];
    const linked = await makeLinkedServer({});
    const manager = new McpManager(testManagerOptions(tools, lines, () => linked.transport));
    const report = await manager.connectAll({ demo: { command: 'unused' } });
    expect(report.connected).toEqual(['demo']);
    expect(report.warnings).toEqual([]);
    const def = tools.get('mcp__demo__echo')!;
    expect(def).toBeDefined();
    expect(def.description).toBe('回显 msg');
    expect(def.parameters).toEqual({ type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] });
    expect(def.concurrencySafe).toBeUndefined(); // unsafe：串行 + 审批默认 ask
    const out = await def.execute({ msg: 'hello' }, CALL_CTX);
    expect(out).toEqual({ output: 'echo:hello' });
    await manager.close();
  });

  it('isError 结果 → ToolOutput.error；服务器名重复连接 → 告警不重复', async () => {
    const tools = new ToolRegistry();
    const lines: string[] = [];
    const linked = await makeLinkedServer({
      tools: [
        {
          name: 'fail_tool',
          handler: () => ({ content: [{ type: 'text', text: 'boom happened' }], isError: true }),
        },
      ],
    });
    const manager = new McpManager(testManagerOptions(tools, lines, () => linked.transport));
    await manager.connectAll({ demo: { command: 'unused' } });
    const out = await tools.get('mcp__demo__fail_tool')!.execute({}, CALL_CTX);
    expect(out).toEqual({ error: 'boom happened' });
    const again = await manager.connectAll({ demo: { command: 'unused' } });
    expect(again.connected).toEqual([]);
    expect(again.warnings.join()).toContain('已连接');
    await manager.close();
  });

  it('名称冲突：既有工具（本地/插件）优先，MCP 版本跳过 + 告警，不中断其余工具', async () => {
    const tools = new ToolRegistry();
    const localDef: ToolDefinition = {
      name: 'mcp__demo__echo',
      description: 'local version',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ output: 'local-wins' }),
    };
    tools.register(localDef);
    const lines: string[] = [];
    const linked = await makeLinkedServer({
      tools: [echoTool(), { name: 'other', description: '另一个工具' }],
    });
    const manager = new McpManager(testManagerOptions(tools, lines, () => linked.transport));
    const report = await manager.connectAll({ demo: { command: 'unused' } });
    expect(report.connected).toEqual(['demo']);
    expect(lines.join('\n')).toContain('"mcp__demo__echo" 与既有工具重名');
    expect(tools.get('mcp__demo__echo')!.execute({}, CALL_CTX)).toEqual({ output: 'local-wins' });
    expect(tools.get('mcp__demo__other')).toBeDefined();
    await manager.close();
  });

  it('批次隔离：一个 server 连接失败不影响其他 server', async () => {
    const tools = new ToolRegistry();
    const lines: string[] = [];
    const good = await makeLinkedServer({});
    const manager = new McpManager(
      testManagerOptions(tools, lines, (name) => {
        if (name === 'bad') throw new Error('connection refused');
        return good.transport;
      }),
    );
    const report = await manager.connectAll({
      bad: { command: 'unused' },
      good: { command: 'unused' },
    });
    expect(report.connected).toEqual(['good']);
    expect(report.failed).toEqual([{ server: 'bad', error: 'connection refused' }]);
    expect(report.warnings.join()).toContain('退避重启');
    expect(tools.get('mcp__good__echo')).toBeDefined();
    // bad server 退避重启耗尽后 down（不拖垮主进程：manager 不抛出）
    await waitFor(() => stateOf(manager, 'bad').state === 'down');
    expect(stateOf(manager, 'bad').restarts).toBe(3);
    await manager.close();
  });
});

describe('McpManager 断线退避重启', () => {
  it('中途断开 → 退避重启成功：工具刷新、恢复 connected、计数清零、可再调用', async () => {
    const tools = new ToolRegistry();
    const lines: string[] = [];
    let spawns = 0;
    const manager = new McpManager(
      testManagerOptions(tools, lines, async () => {
        spawns += 1;
        // 第一次连接后闪断一次；之后保持稳定
        const linked = await makeLinkedServer({ killAfterList: spawns === 1 });
        return linked.transport;
      }),
    );
    await manager.connectAll({ demo: { command: 'unused' } });
    expect(stateOf(manager, 'demo').state).toBe('connected');
    // 等待断开 → 重启 → 恢复
    await waitFor(() => stateOf(manager, 'demo').state === 'connected' && spawns >= 2 && stateOf(manager, 'demo').restarts === 0);
    expect(spawns).toBeGreaterThanOrEqual(2);
    const def = tools.get('mcp__demo__echo')!;
    expect(def).toBeDefined();
    expect((await def.execute({ msg: 'again' }, CALL_CTX)).output).toBe('echo:again');
    expect(lines.join('\n')).toContain('重连成功');
    await manager.close();
  });

  it('flapping（连上即断）→ 重启 3 次耗尽 → down：工具全部下线 + 告警，主进程不受影响', async () => {
    const tools = new ToolRegistry();
    const lines: string[] = [];
    const manager = new McpManager(
      testManagerOptions(tools, lines, async () => (await makeLinkedServer({ killAfterList: true })).transport, {
        stableResetMs: 3_600_000, // 永不稳定 → 计数累计
      }),
    );
    await manager.connectAll({ demo: { command: 'unused' } });
    expect(tools.get('mcp__demo__echo')).toBeDefined(); // 首次注册成功
    await waitFor(() => stateOf(manager, 'demo').state === 'down');
    expect(stateOf(manager, 'demo').restarts).toBe(3);
    expect(tools.get('mcp__demo__echo')).toBeUndefined(); // 工具已全部下线
    expect(lines.join('\n')).toContain('工具全部下线');
    expect(lines.join('\n')).toContain('主进程不受影响');
    await manager.close();
  });

  it('close()：停重启定时器、工具下线、状态 down，幂等不抛', async () => {
    const tools = new ToolRegistry();
    const lines: string[] = [];
    const linked = await makeLinkedServer({});
    const manager = new McpManager(testManagerOptions(tools, lines, () => linked.transport));
    await manager.connectAll({ demo: { command: 'unused' } });
    expect(tools.size).toBe(1);
    await manager.close();
    expect(tools.size).toBe(0);
    expect(stateOf(manager, 'demo').state).toBe('down');
    await manager.close(); // 幂等
    expect(lines.join('\n')).not.toContain('重启');
  });

  it('P1-1 回归：断开落在 listTools 窗口（onerror + send reject 同发）→ 只调度一个 timer、单一重连链、无僵尸 client', async () => {
    const tools = new ToolRegistry();
    const lines: string[] = [];
    let created = 0;
    let closed = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const manager = new McpManager(
      testManagerOptions(tools, lines, () => {
        created += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // 自定义 transport：initialize 正常应答；tools/list 时同时触发 onerror + send reject
        //（P1-1 竞态原现场：断开落在 listTools 窗口）
        let isClosed = false;
        const transport: Transport = {
          start: async () => {},
          send: async (message) => {
            const m = message as { method?: string; id?: unknown };
            if (m.method === 'initialize') {
              queueMicrotask(() => {
                transport.onmessage?.({
                  jsonrpc: '2.0',
                  id: m.id as number,
                  result: {
                    protocolVersion: '2025-06-18',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'fake-broken', version: '1.0.0' },
                  },
                } as never);
              });
              return;
            }
            if (m.method === 'tools/list') {
              transport.onerror?.(new Error('transport broken during listTools'));
              throw new Error('send failed: transport closed');
            }
            // notifications 等：无响应
          },
          close: async () => {
            if (isClosed) return;
            isClosed = true;
            closed += 1;
            inFlight -= 1;
          },
        };
        return transport;
      }, { stableResetMs: 3_600_000 }), // 永不稳定 → 重启计数累计（同 flapping 用例口径）
    );
    await manager.connectAll({ demo: { command: 'unused' } });
    await waitFor(() => stateOf(manager, 'demo').state === 'down');
    // 单一重连链：初始连接 + maxRestarts=3 次重连 = 恰 4 次 factory 调用（双 timer 会 > 4）
    expect(created).toBe(4);
    // 无并发重连：任意时刻存活（未 close）的 transport ≤ 1 → 无僵尸 stdio 子进程
    expect(maxInFlight).toBe(1);
    expect(stateOf(manager, 'demo').restarts).toBe(3);
    await manager.close();
    expect(closed).toBe(created); // 全部 transport 均已关闭
  });

  it('P2-2：down 状态恢复路径——connectAll 二次调用对 down entry 重连成功（补测：含工具恢复）', async () => {
    const tools = new ToolRegistry();
    const lines: string[] = [];
    let healthy = false;
    const manager = new McpManager(
      testManagerOptions(tools, lines, async () => {
        if (!healthy) throw new Error('connection refused');
        return (await makeLinkedServer({})).transport;
      }),
    );
    // 首轮：连接失败 → 退避重试耗尽（backoff 20ms×3）→ down（工具未注册）
    const first = await manager.connectAll({ demo: { command: 'unused' } });
    expect(first.connected).toEqual([]);
    await waitFor(() => stateOf(manager, 'demo').state === 'down');
    expect(stateOf(manager, 'demo').restarts).toBe(3);
    expect(tools.size).toBe(0);
    // 二轮：服务器恢复 → down entry 允许重连、重启预算清零、工具注册
    healthy = true;
    const second = await manager.connectAll({ demo: { command: 'unused' } });
    expect(second.connected).toEqual(['demo']);
    expect(stateOf(manager, 'demo').state).toBe('connected');
    expect(stateOf(manager, 'demo').restarts).toBe(0);
    expect(tools.get('mcp__demo__echo')).toBeDefined();
    expect((await tools.get('mcp__demo__echo')!.execute({ msg: 'back' }, CALL_CTX)).output).toBe('echo:back');
  });

  it('P2-6：2 个不可达 server 并行连接——总耗时 < 2×单 server 失败耗时（串行会 ≥ 2×）', async () => {
    const tools = new ToolRegistry();
    const lines: string[] = [];
    const failDelayMs = 400;
    const manager = new McpManager(
      testManagerOptions(tools, lines, async (name) => {
        await new Promise((r) => setTimeout(r, failDelayMs));
        throw new Error(`${name}: connection refused`);
      }),
    );
    const start = Date.now();
    const report = await manager.connectAll({
      slowA: { command: 'unused' },
      slowB: { command: 'unused' },
    });
    const elapsed = Date.now() - start;
    expect(report.connected).toEqual([]);
    expect(report.failed).toHaveLength(2);
    // 并行下界：两个 400ms 失败同时进行 → 远小于串行的 800ms（留抖动余量取 700ms）
    expect(elapsed).toBeLessThan(failDelayMs * 2 - 100);
    await manager.close();
  });
});

// —— stdio / url 生产传输路径 ——

describe('McpManager 生产传输（stdio / Streamable HTTP）', () => {
  it('stdio：spawn 同 SDK 的本地 echo server，connect/listTools/调用往返/close', async () => {
    const tools = new ToolRegistry();
    const lines: string[] = [];
    const manager = new McpManager({
      tools,
      logSink: (l) => lines.push(l),
      timeoutMs: 10_000,
      // 生产工厂（不注入 transportFactory）
    });
    await manager.connectAll({
      fsx: {
        command: process.execPath,
        args: [join(import.meta.dirname, 'fixtures', 'mcp-stdio-server.mjs')],
      },
    });
    expect(stateOf(manager, 'fsx').state).toBe('connected');
    const def = tools.get('mcp__fsx__echo')!;
    expect(def).toBeDefined();
    expect((await def.execute({ msg: 'stdio' }, CALL_CTX)).output).toBe('stdio-echo:stdio');
    await manager.close();
    expect(stateOf(manager, 'fsx').state).toBe('down');
  });

  it('url：Streamable HTTP 本地 server，connect/listTools/调用往返', async () => {
    const { url, close } = await startUrlEchoServer();
    try {
      const tools = new ToolRegistry();
      const lines: string[] = [];
      const manager = new McpManager({ tools, logSink: (l) => lines.push(l), timeoutMs: 10_000 });
      await manager.connectAll({ remote: { url } });
      expect(stateOf(manager, 'remote').state).toBe('connected');
      const def = tools.get('mcp__remote__echo')!;
      expect(def).toBeDefined();
      expect((await def.execute({ msg: 'http' }, CALL_CTX)).output).toBe('echo:http');
      await manager.close();
    } finally {
      await close();
    }
  });
});

/** 本地 Streamable HTTP echo server（同一 SDK server 端 + node:http，127.0.0.1 随机端口）。
 *  stateless 官方模式：每请求新建 transport（web-standard 传输禁止跨请求复用）。 */
async function startUrlEchoServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const mcpServer = new McpServer({ name: 'url-test-server', version: '1.0.0' }, { capabilities: { tools: {} } });
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [(() => { const t = echoTool(); return { name: t.name, description: t.description, inputSchema: t.inputSchema }; })()],
  }));
  mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: 'text', text: `echo:${String((req.params.arguments as Record<string, unknown>)['msg'] ?? '')}` }],
  }));
  let httpServer: HttpServer | null = null;
  let closed = false;
  httpServer = createHttpServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
          void transport.close().catch(() => {});
        });
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    })();
  });
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
  const port = (httpServer!.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    },
  };
}

// —— config.mcpServers schema 校验 ——

describe('config.mcpServers schema', () => {
  const base = {
    providers: { ch: { protocol: 'openai', baseUrl: 'https://x' } },
    roles: { main: { channel: 'ch', model: 'm' } },
  };

  it('缺省 = {}；stdio/url 合法形态通过', () => {
    const def = parseConfig(base).config!;
    expect(def.mcpServers).toEqual({});
    const cfg = parseConfig({
      ...base,
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
        remote: { url: 'http://127.0.0.1:8802/mcp', headers: { authorization: 'Bearer x' } },
        local: { command: 'node', args: ['s.js'], env: { A: '1' }, cwd: '/tmp' },
      },
    }).config!;
    expect(cfg.mcpServers['filesystem']).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    });
    expect(cfg.mcpServers['remote']).toMatchObject({ url: 'http://127.0.0.1:8802/mcp' });
    expect(cfg.mcpServers['local']).toMatchObject({ command: 'node' });
  });

  it('非法形态报错：双填 / 都不填 / url 非 http / 服务器名不满足工具名约束 / args 类型', () => {
    const bad = (mcpServers: unknown): string[] =>
      parseConfig({ ...base, mcpServers }).errors;
    expect(bad({ x: { command: 'a', url: 'http://b' } }).join()).toContain('只能二选一');
    expect(bad({ x: {} }).join()).toContain('必须提供 command');
    expect(bad({ x: { url: 'ftp://b' } }).join()).toContain('http(s)');
    expect(bad({ 'Bad Name': { command: 'a' } }).join()).toContain('^[a-z0-9_]+$');
    expect(bad({ x: { command: 'a', args: [1] } }).join()).toContain('args');
    // 未知字段 → 非致命告警
    const warned = parseConfig({ ...base, mcpServers: { x: { command: 'a', extra: 1 } } });
    expect(warned.config).not.toBeNull();
    expect(warned.warnings.join()).toContain('extra');
  });
});
