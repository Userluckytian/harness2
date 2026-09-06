// MCP 客户端（阶段 8 Task 2）：官方 @modelcontextprotocol/sdk 桥接层。
// 每个 config.mcpServers 条目一条连接（stdio = spawn 子进程 / url = Streamable HTTP）→
// listTools → 以 `mcp__<server>__<tool>` namespaced 工具注册进宿主 ToolRegistry
// （schema 透传、不声明 concurrencySafe = unsafe，走审批默认 ask）。
// 边界（Global Constraints 3）：
//   - 与既有工具重名 → 本地/先注册者优先：跳过该工具 + 告警（不中断、不覆盖）；
//   - 连接失败/中途断开 → 退避重启（上限 maxRestarts=3）→ 仍失败 = 该 server 全部
//     工具下线（disposer）+ 告警；单 server 故障绝不拖垮主进程（所有异常逐点收口）。
// 只依赖 SDK 的 listTools/callTool 两面（适配薄封装，SDK API 变动面最小化）。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CORE_VERSION } from '../version.js';
import { TOOL_NAME_PATTERN, type ToolDefinition, type ToolContext, type ToolOutput } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { McpServerConfig } from '../config/schema.js';

/** MCP 客户端标识（发往 server 的 initialize 信息） */
export const MCP_CLIENT_NAME = 'harness2';

/** namespaced 工具名：mcp__<server>__<tool>（server/tool 名经 sanitize 满足工具名约束） */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizePart(server)}__${sanitizePart(tool)}`;
}

/** 工具名约束 ^[a-z0-9_]+$ 之外的字符折叠为 '_'（并整体小写）；sanitize 后撞名 = 后者跳过 + 告警 */
function sanitizePart(part: string): string {
  return part.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

export type McpServerState = 'connected' | 'restarting' | 'down';

export interface McpServerStatus {
  server: string;
  state: McpServerState;
  /** 已注册的 namespaced 工具名 */
  tools: string[];
  /** 已发生的重启尝试次数（成功重连不清零本轮计数，成功后归零——见 reconnect 实现） */
  restarts: number;
  lastError?: string;
}

export interface McpConnectReport {
  connected: string[];
  failed: Array<{ server: string; error: string }>;
  warnings: string[];
}

export interface McpManagerOptions {
  /** namespaced 工具注册进该表（本地/插件工具先注册 → 冲突时它们优先） */
  tools: ToolRegistry;
  /** 告警/诊断 sink（缺省 console.error，避免污染 serve stdout） */
  logSink?: (line: string) => void;
  /** 连接/工具调用超时 ms（缺省 10_000） */
  timeoutMs?: number;
  /** 退避序列 ms（缺省 [1_000, 5_000, 15_000]；测试注入短间隔） */
  backoffSchedule?: readonly number[];
  /** 重启尝试上限（缺省 3；耗尽 → down + 工具下线） */
  maxRestarts?: number;
  /**
   * 连接稳定多久后清零重启计数 ms（缺省 30_000；防 flapping：反复「连上即断」的服务器
   * 会累计计数直至耗尽上限进入 down；测试注入 0 = 重连成功即清零）。
   */
  stableResetMs?: number;
  /**
   * 传输工厂（生产 = stdio/url 按 config 派生；测试注入 InMemory 配对传输——
   * 同一 SDK 的 server 端起本地内存 server，零外部依赖）。
   */
  transportFactory?: (server: string, cfg: McpServerConfig) => Transport | Promise<Transport>;
}

const DEFAULT_BACKOFF: readonly number[] = [1_000, 5_000, 15_000];

interface ServerEntry {
  name: string;
  cfg: McpServerConfig;
  client: Client | null;
  state: McpServerState;
  /** 本 server 已注册工具：namespaced 名 → disposer */
  toolDisposers: Map<string, () => void>;
  restarts: number;
  timer: NodeJS.Timeout | null;
  /** 稳定清零定时器（连接稳定 stableResetMs 后把 restarts 归零） */
  stableTimer: NodeJS.Timeout | null;
  lastError?: string;
  closing: boolean;
}

/** MCP 工具返回文本化：text 块拼接；非文本块如实占位（不臆造内容） */
export function mcpResultToOutput(content: unknown): { output?: string; error?: string } {
  if (!Array.isArray(content)) return { output: '' };
  const parts = content.map((block) => {
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') return b.text;
    return `[非文本内容 ${b.type ?? 'unknown'}]`;
  });
  return { output: parts.join('\n') };
}

export class McpManager {
  private readonly entries = new Map<string, ServerEntry>();
  private readonly backoff: readonly number[];
  private readonly maxRestarts: number;
  private readonly stableResetMs: number;
  private readonly timeoutMs: number;
  private readonly logSink: (line: string) => void;
  private closed = false;

  constructor(private readonly options: McpManagerOptions) {
    this.backoff = options.backoffSchedule ?? DEFAULT_BACKOFF;
    this.maxRestarts = options.maxRestarts ?? 3;
    this.stableResetMs = options.stableResetMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.logSink = options.logSink ?? ((line: string) => console.error(line));
  }

  /** 全部 server 状态快照（CLI mcp list / 诊断用） */
  status(): McpServerStatus[] {
    return [...this.entries.values()].map((e) => ({
      server: e.name,
      state: e.state,
      tools: [...e.toolDisposers.keys()],
      restarts: e.restarts,
      ...(e.lastError !== undefined ? { lastError: e.lastError } : {}),
    }));
  }

  /**
   * 连接全部配置的 server：逐 server 独立收口（失败 = failed + 告警，不断批、不抛出）。
   * 成功的 server 立即注册 namespaced 工具；失败进入退避重启（tools 未注册，直到连上）。
   */
  async connectAll(config: Record<string, McpServerConfig>): Promise<McpConnectReport> {
    const report: McpConnectReport = { connected: [], failed: [], warnings: [] };
    for (const [name, cfg] of Object.entries(config)) {
      if (this.entries.has(name)) {
        report.warnings.push(`MCP 服务器 "${name}" 已连接（不重复连接）`);
        continue;
      }
      const entry: ServerEntry = {
        name,
        cfg,
        client: null,
        state: 'restarting',
        toolDisposers: new Map(),
        restarts: 0,
        timer: null,
        stableTimer: null,
        closing: false,
      };
      this.entries.set(name, entry);
      try {
        await this.openConnection(entry);
        report.connected.push(name);
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        entry.lastError = msg;
        report.failed.push({ server: name, error: msg });
        report.warnings.push(`MCP 服务器 "${name}" 连接失败（将退避重启，上限 ${this.maxRestarts} 次）: ${msg}`);
        this.scheduleRestart(entry);
      }
    }
    return report;
  }

  /** 优雅关闭：停重启定时器 → 关全部连接 → 工具下线。幂等。 */
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.entries.values()) {
      entry.closing = true;
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (entry.stableTimer !== null) {
        clearTimeout(entry.stableTimer);
        entry.stableTimer = null;
      }
      this.offlineTools(entry);
      await this.closeConnection(entry);
      entry.state = 'down';
    }
  }

  // —— 连接与注册 ——

  private async openConnection(entry: ServerEntry): Promise<void> {
    const transportFactory =
      this.options.transportFactory ??
      ((_, cfg): Transport => createStdioOrUrlTransport(cfg));
    const transport = await transportFactory(entry.name, entry.cfg);
    const client = new Client({ name: MCP_CLIENT_NAME, version: CORE_VERSION });
    client.onerror = (e: Error) => {
      // 传输层错误（断连/协议错误）：退避重启入口；连接已关闭后到达的错误静默吞掉
      if (entry.closing || this.closed) return;
      entry.lastError = e.message;
      this.handleDisconnect(entry);
    };
    client.onclose = () => {
      if (entry.closing || this.closed) return;
      this.handleDisconnect(entry);
    };
    await client.connect(transport, { timeout: this.timeoutMs });
    entry.client = client;
    entry.state = 'connected';
    // 稳定清零：连接保持 stableResetMs 后重置本轮重启计数（flapping 服务器不清零，累计至耗尽）
    if (entry.stableTimer !== null) clearTimeout(entry.stableTimer);
    if (this.stableResetMs <= 0) {
      entry.restarts = 0;
    } else {
      entry.stableTimer = setTimeout(() => {
        entry.stableTimer = null;
        if (entry.state === 'connected') entry.restarts = 0;
      }, this.stableResetMs);
      entry.stableTimer.unref?.();
    }
    // 重连成功：刷新工具（旧工具先下线，按最新 listTools 重新注册）
    await this.registerTools(entry);
  }

  private async closeConnection(entry: ServerEntry): Promise<void> {
    const client = entry.client;
    entry.client = null;
    if (client !== null) {
      client.onclose = undefined;
      client.onerror = undefined;
      try {
        await client.close();
      } catch {
        // 关闭失败不拖垮收尾
      }
    }
  }

  /** listTools → namespaced 注册。冲突（重名）时先注册者优先：跳过 + 告警，不中断。 */
  private async registerTools(entry: ServerEntry): Promise<void> {
    const client = entry.client;
    if (client === null) return;
    const { tools } = await client.listTools(undefined, { timeout: this.timeoutMs });
    // 刷新语义：先下线本 server 旧工具，再按最新清单注册
    this.offlineTools(entry);
    for (const tool of tools) {
      const name = mcpToolName(entry.name, tool.name);
      if (!TOOL_NAME_PATTERN.test(name)) {
        // sanitize 后仍不合法（理论不可达，防御性保留）
        this.logSink(`[mcp:${entry.name}] 工具 "${tool.name}" 名称非法，跳过`);
        continue;
      }
      if (this.options.tools.get(name) !== undefined) {
        this.logSink(`[mcp:${entry.name}] 工具 "${name}" 与既有工具重名，本地优先（跳过 MCP 版本）`);
        continue;
      }
      const def = this.wrapTool(entry, client, tool.name, name, tool.description, tool.inputSchema);
      try {
        const disposer = this.options.tools.register(def);
        entry.toolDisposers.set(name, disposer);
      } catch (e) {
        this.logSink(`[mcp:${entry.name}] 工具 "${name}" 注册失败: ${(e as Error).message}`);
      }
    }
  }

  /** 该 server 工具全部下线（disposer 逐个展开；幂等） */
  private offlineTools(entry: ServerEntry): void {
    for (const dispose of entry.toolDisposers.values()) {
      try {
        dispose();
      } catch {
        // disposer 异常不阻断下线
      }
    }
    entry.toolDisposers.clear();
  }

  /** 中途断开：进入 restarting → 退避重启（上限 maxRestarts）→ 耗尽 = down + 工具下线 + 告警 */
  private handleDisconnect(entry: ServerEntry): void {
    // 仅 connected 状态需要处理断开（onerror/onclose 可能双触发，restarting/down 忽略防重复重启）
    if (entry.state !== 'connected' || entry.closing || this.closed) return;
    if (entry.stableTimer !== null) {
      clearTimeout(entry.stableTimer);
      entry.stableTimer = null;
    }
    void this.closeConnection(entry);
    entry.state = 'restarting';
    this.logSink(`[mcp:${entry.name}] 连接断开，准备退避重启（第 ${entry.restarts + 1}/${this.maxRestarts} 次）`);
    this.scheduleRestart(entry);
  }

  private scheduleRestart(entry: ServerEntry): void {
    if (entry.closing || this.closed) return;
    if (entry.restarts >= this.maxRestarts) {
      entry.state = 'down';
      this.offlineTools(entry);
      this.logSink(`[mcp:${entry.name}] 重启 ${this.maxRestarts} 次仍失败，放弃：该服务器工具全部下线（主进程不受影响）`);
      return;
    }
    const delay = this.backoff[Math.min(entry.restarts, this.backoff.length - 1)] ?? 1_000;
    entry.restarts += 1;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.reconnect(entry);
    }, delay);
    entry.timer.unref?.();
  }

  private async reconnect(entry: ServerEntry): Promise<void> {
    if (entry.closing || this.closed) return;
    try {
      await this.openConnection(entry);
      this.logSink(`[mcp:${entry.name}] 重连成功（${entry.toolDisposers.size} 个工具已注册）`);
    } catch (e) {
      entry.lastError = (e as Error)?.message ?? String(e);
      this.scheduleRestart(entry); // 计数已在 scheduleRestart 递增；耗尽 → down
    }
  }

  /** SDK 工具 → ToolDefinition 适配（只依赖 callTool 一面） */
  private wrapTool(
    entry: ServerEntry,
    client: Client,
    remoteName: string,
    nsName: string,
    description: string | undefined,
    inputSchema: unknown,
  ): ToolDefinition {
    const timeoutMs = this.timeoutMs;
    const manager = this;
    return {
      name: nsName,
      description: description ?? `(MCP ${entry.name}/${remoteName})`,
      // schema 透传（MCP inputSchema 即 JSON Schema）；缺失时给空对象 schema
      parameters:
        inputSchema !== null && typeof inputSchema === 'object'
          ? (inputSchema as Record<string, unknown>)
          : { type: 'object', properties: {} },
      // 不声明 concurrencySafe → unsafe：串行执行 + 审批默认 ask（安全缺省）
      async execute(args: unknown, ctx: ToolContext): Promise<ToolOutput> {
        if (entry.client === null) {
          return { error: `MCP 服务器 "${entry.name}" 未连接（state=${entry.state}）` };
        }
        try {
          const result = (await client.callTool(
            { name: remoteName, arguments: (args ?? {}) as Record<string, unknown> },
            undefined,
            { timeout: timeoutMs },
          )) as { isError?: boolean; content?: unknown };
          const { output, error } = mcpResultToOutput(result.content);
          if (result.isError === true) {
            return { error: error ?? output ?? `MCP 工具 ${remoteName} 返回错误` };
          }
          return { output };
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e);
          // 调用失败若是连接级故障，onerror/onclose 会接手重启；这里只如实返回错误
          manager.logSink(`[mcp:${entry.name}] 工具 ${remoteName} 调用失败: ${msg}`);
          return { error: msg };
        }
      },
    };
  }
}

/** 生产传输工厂：stdio（spawn 子进程，stderr 忽略防噪声）或 Streamable HTTP */
export function createStdioOrUrlTransport(cfg: McpServerConfig): Transport {
  if ('command' in cfg) {
    return new StdioClientTransport({
      command: cfg.command,
      ...(cfg.args !== undefined ? { args: cfg.args } : {}),
      ...(cfg.env !== undefined ? { env: cfg.env } : {}),
      ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
      stderr: 'ignore',
    });
  }
  return new StreamableHTTPClientTransport(new URL(cfg.url), {
    ...(cfg.headers !== undefined ? { requestInit: { headers: cfg.headers } } : {}),
  });
}
