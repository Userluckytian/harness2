// 本地 HTTP stub server：provider 协议测试专用（127.0.0.1，CI 零真实 API）。
// 可编程响应脚本：SSE 帧序列 / 状态码 / 延迟 / 半帧断流；捕获每个请求的 wire 形态。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** stub 捕获到的一次请求 */
export interface StubRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  /** JSON 解析后的请求体（解析失败为 null） */
  body: unknown;
  rawBody: string;
}

/** 一次响应脚本 */
export interface StubScript {
  /** 默认 200 */
  status?: number;
  headers?: Record<string, string>;
  /** 非 SSE 响应体（未提供 sse 时使用） */
  body?: string;
  /** SSE 帧序列：每帧写完后追加 SSE 事件分隔符 "\n\n" */
  sse?: string[];
  /** 帧间隔 ms（模拟流式节奏，供取消测试） */
  frameDelayMs?: number;
  /** 写响应头前的延迟 ms */
  headersDelayMs?: number;
  /** 帧后追加的原始片段（不加分隔符；用于半帧/跨 chunk 测试） */
  rawTail?: string;
  /** 原始字节段序列（依次 write，不加分隔符；用于多字节跨 chunk / 半帧的精确字节控制） */
  rawBytes?: Uint8Array[];
  /** true = 写完后直接销毁 socket（模拟断流）；false = 正常 end（默认） */
  destroy?: boolean;
}

export interface StubServer {
  url: string;
  port: number;
  readonly requests: StubRequest[];
  /** 排队一次响应脚本（按请求顺序消费；耗尽后返回 500） */
  enqueue(script: StubScript): void;
  enqueueAll(scripts: StubScript[]): void;
  close(): Promise<void>;
}

/** 启动 stub server（监听 127.0.0.1 随机端口；测试结束必须 close） */
export async function startSseStub(): Promise<StubServer> {
  const scripts: StubScript[] = [];
  const requests: StubRequest[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // 客户端 abort 时避免未处理的 'error'/'aborted' 事件噪声
    res.on('error', () => {});
    req.on('error', () => {});

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = null;
      }
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, rawBody });

      const script = scripts.shift();
      if (!script) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'stub script exhausted' } }));
        return;
      }
      void respond(res, script);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;

  async function respond(res: ServerResponse, script: StubScript): Promise<void> {
    if (script.headersDelayMs) await sleep(script.headersDelayMs);
    const headers = { ...script.headers };
    if (script.sse !== undefined) {
      headers['content-type'] = headers['content-type'] ?? 'text/event-stream';
      headers['cache-control'] = 'no-cache';
    }
    res.writeHead(script.status ?? 200, headers);
    if (script.sse !== undefined) {
      for (const frame of script.sse) {
        if (script.frameDelayMs) await sleep(script.frameDelayMs);
        res.write(`${frame}\n\n`);
      }
      if (script.rawTail !== undefined) res.write(script.rawTail);
    } else if (script.rawBytes !== undefined) {
      for (const segment of script.rawBytes) {
        await sleep(script.frameDelayMs ?? 0);
        res.write(segment);
      }
    } else {
      res.write(script.body ?? '');
    }
    if (script.destroy) {
      // 先让已写数据到达客户端，再 RST（否则 RST 会丢弃在途数据，fetch 直接建连失败）
      await sleep(30);
      (res.socket as { destroy: () => void } | null)?.destroy();
    } else {
      res.end();
    }
  }

  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    requests,
    enqueue(script: StubScript) {
      scripts.push(script);
    },
    enqueueAll(list: StubScript[]) {
      scripts.push(...list);
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // 强制断开残留连接（abort 测试会留下半开连接）
        server.closeAllConnections?.();
      });
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
