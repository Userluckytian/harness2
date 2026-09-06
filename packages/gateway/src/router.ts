// 会话路由：<platform>:<chatId> → harness2 会话 id 的持久化映射（~/.harness2/gateway/routes.json）。
// 无映射时由网关调 serve 建新会话并写入路由；每 chat 一个会话（同 chat 串行由 hub 保证）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface RouteEntry {
  sessionId: string;
  createdAt: string;
}

export interface RouteTable {
  map: Record<string, RouteEntry>;
}

export function routeKey(platform: string, chatId: string): string {
  return `${platform}:${chatId}`;
}

export class SessionRouter {
  private table: RouteTable = { map: {} };
  private save: () => void;

  constructor(
    private readonly home: string,
    /** 建新会话（serve API 回调，由网关注入；cwd = serve root） */
    private readonly createSession: (cwd: string) => Promise<{ id: string }>,
    private readonly cwd: string,
    onLoadError?: (message: string) => void,
  ) {
    const path = this.filePath();
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as RouteTable;
        if (typeof parsed.map === 'object' && parsed.map !== null) {
          this.table = { map: parsed.map };
        } else {
          onLoadError?.('routes.json 结构非法，已重置');
        }
      } catch (e) {
        onLoadError?.(`routes.json 损坏（${(e as Error).message}），已重置`);
      }
    }
    this.save = () => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(this.table, null, 2)}\n`, 'utf8');
    };
  }

  private filePath(): string {
    return join(this.home, '.harness2', 'gateway', 'routes.json');
  }

  /** 已映射的会话 id（无则 undefined） */
  get(platform: string, chatId: string): string | undefined {
    return this.table.map[routeKey(platform, chatId)]?.sessionId;
  }

  /** 解析路由：已映射直接返回；未映射创建新会话并持久化 */
  async resolve(platform: string, chatId: string): Promise<string> {
    const existing = this.get(platform, chatId);
    if (existing !== undefined) return existing;
    const created = await this.createSession(this.cwd);
    this.table.map[routeKey(platform, chatId)] = {
      sessionId: created.id,
      createdAt: new Date().toISOString(),
    };
    this.save();
    return created.id;
  }
}
