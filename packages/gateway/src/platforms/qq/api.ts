// QQ 官方 Bot API v2 REST 面：token 单飞刷新 + 出站频率限制队列。
// 仅官方端点（bots.qq.com 鉴权 / api.sgroup.qq.com 出站；测试可注入 base 覆盖）。
export interface QqApiOptions {
  appId: string;
  appSecret: string;
  /** 鉴权端点（默认官方；测试注入本地 stub） */
  tokenUrl?: string;
  /** REST 基址（默认官方；测试注入本地 stub） */
  apiBase?: string;
  /** 出站最小间隔 ms（默认 500；平台限速兜底） */
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export class QqApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'QqApiError';
  }
}

interface TokenState {
  token: string;
  expiresAt: number;
}

export class QqApi {
  private tokenState: TokenState | null = null;
  /** token 单飞：并发请求共享同一次刷新 */
  private refreshing: Promise<string> | null = null;
  /** 出站队列：串行 + 最小间隔（平台限速兜底；429 退避） */
  private queue: Promise<void> = Promise.resolve();
  private readonly minIntervalMs: number;
  private lastSentAt = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenUrl: string;
  private readonly apiBase: string;

  constructor(private readonly options: QqApiOptions) {
    this.minIntervalMs = options.minIntervalMs ?? 500;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenUrl = options.tokenUrl ?? 'https://bots.qq.com/app/getAppAccessToken';
    this.apiBase = options.apiBase ?? 'https://api.sgroup.qq.com';
  }

  /** access_token（单飞刷新；到期前 60s 视为过期） */
  async getToken(): Promise<string> {
    if (this.tokenState !== null && Date.now() < this.tokenState.expiresAt - 60_000) {
      return this.tokenState.token;
    }
    if (this.refreshing === null) {
      this.refreshing = this.refreshToken().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async refreshToken(): Promise<string> {
    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: this.options.appId, clientSecret: this.options.appSecret }),
    });
    if (!res.ok) throw new QqApiError(res.status, `token 刷新失败（status ${res.status}）`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new QqApiError(res.status, 'token 响应缺少 access_token');
    }
    const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 60 ? body.expires_in : 3600;
    this.tokenState = { token: body.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return this.tokenState.token;
  }

  /** 入队出站（串行 + 最小间隔）；fn 抛 429 时按 retryAfterMs 退避重试一次 */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastSentAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        const result = await fn();
        this.lastSentAt = Date.now();
        return result;
      } catch (e) {
        if (e instanceof QqApiError && e.status === 429) {
          await sleep(2000);
          const result = await fn();
          this.lastSentAt = Date.now();
          return result;
        }
        throw e;
      }
    });
    // 队列容错：单次失败不阻塞后续出站
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** REST 出站（自动带 token；调用方包 enqueue 做限速） */
  async request(path: string, body: Record<string, unknown>): Promise<void> {
    const token = await this.getToken();
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `QQBot ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new QqApiError(res.status, `出站失败（status ${res.status}）: ${text.slice(0, 200)}`);
    }
    await res.arrayBuffer().catch(() => {});
  }

  /** 获取 WS 网关地址（官方 /gateway） */
  async getGatewayUrl(): Promise<string> {
    const token = await this.getToken();
    const res = await this.fetchImpl(`${this.apiBase}/gateway`, {
      headers: { authorization: `QQBot ${token}` },
    });
    if (!res.ok) throw new QqApiError(res.status, `gateway 获取失败（status ${res.status}）`);
    const body = (await res.json()) as { url?: unknown };
    if (typeof body.url !== 'string') throw new QqApiError(res.status, 'gateway 响应缺少 url');
    return body.url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
