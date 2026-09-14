// H-43 的传输层：换行分隔 JSON（NDJSON）RPC over stdio。
//
// 为什么单列一层：服务（rpc.ts）与「脚本怎么把请求送进来」解耦，三种消费方式共用同一份
// 服务与同一套帧格式：
//   1. `harness2` 侧的 run_script（tools/script.ts，P0-1 起）：脚本跑在**独立 Node 子进程**里，
//      子进程 stdout → 宿主（ToolRpcLineServer）→ 子进程 stdin，宿主对象不进程间共享；
//      子进程程序内联一份同帧格式的最小客户端（见 script.ts 的 SCRIPT_CHILD_PROGRAM）。
//   2. 宿主内联客户端（createInProcessRpcClient）：同进程内走同一套编解码（测试因此不必
//      spawn 子进程即可覆盖真实帧格式；也可供嵌入式宿主复用）；
//   3. 未来壳层（桌面 IPC / web）可复用编码函数。
//
// 帧格式（v1）：一行一个 JSON 对象，UTF-8，`\n` 结尾；未知字段忽略；坏行回协议错误帧
// （带 id:null），不中断服务——与 H-51/H-53 的错误隔离口径一致。
import type { ToolRpcCallOptions, ToolRpcRequest, ToolRpcResponse } from './rpc.js';

/** 协议版本标识（hello 帧与文档用；不参与路由） */
export const TOOL_RPC_PROTOCOL = 'harness2-tool-rpc/1';

/** 单行字符上限（防御脚本无界输出；超限按坏行处理） */
export const TOOL_RPC_MAX_LINE_CHARS = 1_000_000;

/** 编码一个请求/响应为一行（含结尾换行） */
export function encodeToolRpcLine(message: ToolRpcRequest | ToolRpcResponse): string {
  return `${JSON.stringify(message)}\n`;
}

/** 解析一行：返回消息，或 `{ error }`（坏行/超长行） */
export function decodeToolRpcLine(line: string): ToolRpcRequest | { error: string } {
  const trimmed = line.trim();
  if (trimmed === '') return { error: '空行不是合法 RPC 帧' };
  if (trimmed.length > TOOL_RPC_MAX_LINE_CHARS) {
    return { error: `RPC 帧超限（>${TOOL_RPC_MAX_LINE_CHARS} 字符）` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { error: `RPC 帧不是合法 JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'RPC 帧必须是 JSON 对象' };
  }
  const msg = parsed as { id?: unknown; method?: unknown };
  if (msg.method === undefined || typeof msg.method !== 'string') {
    return { error: 'RPC 帧缺少 method' };
  }
  const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null;
  return { ...(parsed as ToolRpcRequest), id: id ?? 0 };
}

/** 解析响应行：`{ id, ok: true, result }` 或 `{ id, ok: false, error }`；坏行返回 `{ error }` */
export function decodeToolRpcResponseLine(line: string): ToolRpcResponse | { error: string } {
  const trimmed = line.trim();
  if (trimmed === '') return { error: '空行不是合法响应帧' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { error: `响应帧不是合法 JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: '响应帧必须是 JSON 对象' };
  }
  const msg = parsed as { id?: unknown; ok?: unknown; error?: unknown; result?: unknown };
  if (typeof msg.ok !== 'boolean') return { error: '响应帧缺少 ok' };
  const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : 0;
  if (!msg.ok) {
    return { id, ok: false, error: typeof msg.error === 'string' ? msg.error : '未知 RPC 错误' };
  }
  return { id, ok: true, result: msg.result };
}

/** 行协议服务端：一行进 → 一行出（undefined = 该行无需响应，如空行） */
export class ToolRpcLineServer {
  constructor(
    private readonly service: {
      handle: (req: ToolRpcRequest, options?: ToolRpcCallOptions) => Promise<ToolRpcResponse>;
    },
    /** 每次 handle 的默认选项（脚本工具据此透传宿主 turn 的取消信号与超时） */
    private readonly options: ToolRpcCallOptions = {},
  ) {}

  async handleLine(line: string): Promise<string | undefined> {
    if (line.trim() === '') return undefined;
    const decoded = decodeToolRpcLine(line);
    if ('error' in decoded) {
      // 坏行：回 id=0 的错误帧（调用方可按 id 关联），不抛给传输层
      return encodeToolRpcLine({ id: 0, ok: false, error: decoded.error });
    }
    const response = await this.service.handle(decoded, this.options);
    return encodeToolRpcLine(response);
  }
}

/** 脚本可见的 RPC 客户端 API（tools/script.ts 暴露给脚本的就是它） */
export interface ToolRpcClient {
  list(): Promise<unknown>;
  describe(name: string): Promise<unknown>;
  call(name: string, args?: unknown, timeoutMs?: number): Promise<unknown>;
}

/**
 * 用任意「一行进一行出」传输构造客户端。传输抛错/返回空 → 该次调用以 Error 失败
 * （脚本侧看到异常，不会静默拿到 undefined）。
 */
export function createLineRpcClient(transport: (line: string) => Promise<string | undefined>): ToolRpcClient {
  let seq = 0;
  const roundTrip = async (method: string, params?: unknown): Promise<unknown> => {
    const id = ++seq;
    const line = encodeToolRpcLine({ id, method, ...(params !== undefined ? { params } : {}) });
    const replyLine = await transport(line);
    if (replyLine === undefined) throw new Error(`RPC 无响应（method=${method}）`);
    const response = decodeToolRpcResponseLine(replyLine);
    // ok:false 只出现在协议级错误（坏帧/未知方法/参数非法）；工具本身的失败是 ok:true 的 result.ok=false
    if ('error' in response) throw new Error(response.error);
    if (response.id !== id) throw new Error(`RPC 响应 id 不匹配（期望 ${id}，收到 ${String(response.id)}）`);
    return response.result;
  };
  return {
    list: () => roundTrip('tools.list'),
    describe: (name: string) => roundTrip('tools.describe', { name }),
    call: (name: string, args?: unknown, timeoutMs?: number) =>
      roundTrip('tool.call', {
        name,
        args: args ?? {},
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }),
  };
}

/** 进程内客户端：与服务共用同一进程，但**走真实帧编解码**（跑测试即覆盖协议） */
export function createInProcessRpcClient(
  service: { handle: (req: ToolRpcRequest, options?: ToolRpcCallOptions) => Promise<ToolRpcResponse> },
  options: ToolRpcCallOptions = {},
): ToolRpcClient {
  const server = new ToolRpcLineServer(service, options);
  return createLineRpcClient((line) => server.handleLine(line));
}

/** 流形态的 stdio 桥：从 input 逐行读、把响应写进 output（子进程入口用它） */
export async function serveToolRpcStream(
  service: { handle: (req: ToolRpcRequest, options?: ToolRpcCallOptions) => Promise<ToolRpcResponse> },
  input: AsyncIterable<string | Buffer>,
  output: { write(chunk: string): unknown },
): Promise<void> {
  const server = new ToolRpcLineServer(service);
  let buffered = '';
  for await (const chunk of input) {
    buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx: number;
    while ((idx = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, idx);
      buffered = buffered.slice(idx + 1);
      const reply = await server.handleLine(line);
      if (reply !== undefined) output.write(reply);
    }
  }
  // 收尾：最后一行没有换行也要处理（EOF 语义）
  const reply = await server.handleLine(buffered);
  if (reply !== undefined) output.write(reply);
}
