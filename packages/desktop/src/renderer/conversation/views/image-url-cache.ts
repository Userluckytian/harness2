// 图片 URL 缓存（D-39）：`ctx.uiConversation.imageUrl(sessionId, attachment)` 的等价物。
//
// 语义两条：
//   1. **逐会话缓存**：缓存键 = sessionId + attachment.id（同一附件在不同会话互不串味）；
//   2. **一次授权读取共享**：同一 (sessionId, attachment) 的并发请求共用**同一个** in-flight
//      promise 与**同一个** URL —— Chat 与 Trajectory（D-40）看到的是同一次授权读取结果，
//      不会因为两个视图各自要图而重复触发授权。
//
// 授权读取本身由宿主注入（D-37 的图片走 FileReader data URL；P5-A 只定缝，不关心来源）。
// 失败（read 抛错 / promise reject）**不缓存**，返回 null 并允许重试 —— 否则一次瞬时失败会把
// 该图永久钉死为「无图」。本模块不碰任何浏览器端持久化存储（D-14 口径，见 test/layout/no-persistence）。

/** 图片附件引用（缓存键的标识部分；其余字段原样透传给授权读取） */
export interface ConversationImageAttachment {
  /** 附件标识（会话内唯一） */
  readonly id: string;
  /** MIME 类型（可选；透传授权读取） */
  readonly mimeType?: string;
  /** 展示名（可选；透传授权读取） */
  readonly name?: string;
}

/** 缓存契约错误（空 sessionId / 空 attachment.id = 编程错误，须立即暴露而非静默缓存错位） */
export class ImageUrlCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageUrlCacheError';
  }
}

/** 授权读取（唯一入口）：返回图片 URL（如 data URL）或 null（无图 / 拒绝） */
export type ConversationImageReader = (
  sessionId: string,
  attachment: ConversationImageAttachment,
) => string | null | Promise<string | null>;

/** D-39 的 ctx 形态：`imageUrl(sessionId, attachment)` —— 同步返回**已缓存**的 URL（无缓存 = null） */
export type ConversationImageUrlResolver = (
  sessionId: string,
  attachment: ConversationImageAttachment,
) => string | null;

/** 视图内形态：sessionId 已被视图环绑定，视图只传 attachment */
export type SessionImageUrlResolver = (attachment: ConversationImageAttachment) => string | null;

export interface ImageUrlCacheOptions {
  /** 授权读取实现（宿主注入） */
  readonly read: ConversationImageReader;
}

/** 缓存键：用 NUL 分隔，杜绝「sessionId 尾 + attachment.id 头」拼接碰撞 */
function cacheKey(sessionId: string, attachmentId: string): string {
  if (sessionId.length === 0) throw new ImageUrlCacheError('图片 URL 缓存：sessionId 不能为空');
  if (attachmentId.length === 0) throw new ImageUrlCacheError('图片 URL 缓存：attachment.id 不能为空');
  return `${sessionId}\u0000${attachmentId}`;
}

export class ImageUrlCache {
  private readonly read: ConversationImageReader;
  private readonly urls = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly listeners = new Set<() => void>();

  /** D-39 ctx 形态的同步解析器（绑定本缓存实例；可安全解构/传入视图 —— 引用稳定） */
  readonly peekUrl: ConversationImageUrlResolver = (sessionId, attachment) => this.peek(sessionId, attachment);

  constructor(options: ImageUrlCacheOptions) {
    this.read = options.read;
  }

  /**
   * 取图片 URL（D-39 主入口）：命中缓存直接返回；否则触发**唯一一次**授权读取。
   * 并发调用返回**同一个 promise**（引用相等），解析后两个消费者拿到**同一个** URL。
   */
  imageUrl(sessionId: string, attachment: ConversationImageAttachment): Promise<string | null> {
    const key = cacheKey(sessionId, attachment.id);
    const cached = this.urls.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const running = this.inflight.get(key);
    if (running !== undefined) return running;

    let source: string | null | Promise<string | null>;
    try {
      source = this.read(sessionId, attachment);
    } catch {
      // 同步抛错（授权被拒等）不缓存、不 inflight —— 允许后续重试
      return Promise.resolve(null);
    }
    const pending = Promise.resolve(source)
      .then((url) => {
        this.inflight.delete(key);
        if (typeof url === 'string' && url.length > 0) {
          this.urls.set(key, url);
          this.emit();
          return url;
        }
        return null; // 授权读取成功但无图：不缓存，允许下次再问
      })
      .catch(() => {
        this.inflight.delete(key); // 失败不缓存：允许重试
        return null;
      });
    this.inflight.set(key, pending);
    return pending;
  }

  /** 同步读已缓存 URL（不触发授权读取）；无缓存 = null */
  peek(sessionId: string, attachment: ConversationImageAttachment): string | null {
    return this.urls.get(cacheKey(sessionId, attachment.id)) ?? null;
  }

  /**
   * 失效：给了 attachmentId 只清该附件；否则清该会话的全部附件。
   * 连带清掉在飞的请求（其结果不会被写回缓存）。
   */
  invalidate(sessionId: string, attachmentId?: string): void {
    if (sessionId.length === 0) throw new ImageUrlCacheError('图片 URL 缓存：sessionId 不能为空');
    const single = attachmentId === undefined ? null : cacheKey(sessionId, attachmentId);
    const prefix = `${sessionId}\u0000`;
    const matches = (key: string): boolean => (single === null ? key.startsWith(prefix) : key === single);
    let changed = false;
    for (const key of [...this.urls.keys()]) {
      if (matches(key)) {
        this.urls.delete(key);
        changed = true;
      }
    }
    for (const key of [...this.inflight.keys()]) {
      if (matches(key)) {
        this.inflight.delete(key);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** 清空所有会话缓存 */
  clear(): void {
    const had = this.urls.size > 0 || this.inflight.size > 0;
    this.urls.clear();
    this.inflight.clear();
    if (had) this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 已解析 URL 条数（调试/测试） */
  cachedCount(): number {
    return this.urls.size;
  }

  /** 在飞授权读取数（调试/测试；稳态应为 0） */
  pendingCount(): number {
    return this.inflight.size;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** 便捷工厂 */
export function createImageUrlCache(options: ImageUrlCacheOptions): ImageUrlCache {
  return new ImageUrlCache(options);
}
