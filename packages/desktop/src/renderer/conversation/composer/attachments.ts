// attachments.ts — composer 附件（D-37）：图片走 FileReader data URL；文件走 FIFO 上传队列。
//
// 规格依据：docs/refs/refs-deepseek-harness.md D-37，与上游
// `packages/client/ui-conversation/README.zh.md`「输入状态」节：
//   - 图片：浏览器原生 `FileReader` data-URL 路径（读取器注入，便于 headless 测试）；
//   - 文件：选中的通用文件进入**同一个先进先出的后台上传队列**，`maxConcurrentFileUploads`
//     默认允许 **2** 个传输同时运行（上游 `apply.ts`：`z.natural().min(1).default(2)`）；
//   - 保序：附件顺序 = 选择顺序；失败不阻塞后续；失败项留在列表里供重提（不自动重发）。
//
// 本模块零 React；FileReader 与上传 transport 都是注入缝。
import type { MessageReferenceShape } from '../../../shared/protocol.js';

/** 默认文件上传并发上限（D-37：默认 2，可配） */
export const DEFAULT_MAX_CONCURRENT_FILE_UPLOADS = 2;

export type AttachmentKind = 'image' | 'file';
/** queued=排队 / uploading=传输中 / ready=可提交 / failed=失败（留列表供重提） */
export type AttachmentState = 'queued' | 'uploading' | 'ready' | 'failed';

export interface ComposerAttachment {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly state: AttachmentState;
  /** kind=image：FileReader data URL；就绪后可直接渲染缩略图 */
  readonly dataUrl?: string;
  /** kind=file：上传成功后的暂存凭证（命令提交复用同一凭证） */
  readonly token?: string;
  readonly error?: string;
}

/**
 * 附件转出的引用（进入 PendingSubmission.references 时与 chip 引用同形）。
 *
 * **只对「真的能送出去」的附件产引用**（P1-3）：文件上传拿到暂存凭证 → `kind:'file'`；
 * 其余（图片 / 无凭证）返回 `undefined` —— 旧实现把图片伪造成 `kind:'clipboard'`+
 * 文件名（core 只看到「剪贴板文本 = 文件名」，图片字节永远到不了模型，等于骗用户）。
 * 调用方必须跳过 undefined，不伪造 kind。
 */
export function attachmentReference(attachment: ComposerAttachment): MessageReferenceShape | undefined {
  return attachment.kind === 'file' && attachment.token !== undefined
    ? { id: attachment.id, kind: 'file', path: attachment.token }
    : undefined;
}

/**
 * 图片附件在**当前协议**下无法送达模型：`SubmitMessagePayloadShape` 只有 references
 * （无图片字节通道），`MessageReferenceShape` 的 kind 也没有图片语义。
 * 因此图片如实标 failed（本阶段降级，不伪造引用；真实图片通道登记为 P6 项）。
 */
export const IMAGE_TRANSPORT_MISSING = '图片通道未实现：提交协议无图片字节通道（P6 登记），图片不会送达模型';

/**
 * 失败还原时把附件插回草稿头部（上游 `facade.ts:861-868` 同口径）：
 * 去重（已在本地的项不重复放回）、**保留用户期间新加的附件**、顺序 = 提交顺序在前。
 */
export function restoreAttachments(
  restored: readonly ComposerAttachment[],
  current: readonly ComposerAttachment[],
): readonly ComposerAttachment[] {
  const present = new Set(current.map((a) => a.id));
  const head = restored.filter((a) => !present.has(a.id));
  if (head.length === 0) return current;
  return [...head, ...current];
}

// —— 图片：FileReader data URL（注入缝）——

export interface ImageBlobLike {
  readonly size: number;
  readonly type?: string;
}

/** FileReader 最小形状（真机 = window.FileReader；测试 = 假实现） */
export interface FileReaderLike {
  result: string | ArrayBuffer | null;
  error: { message?: string } | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  readAsDataURL(blob: ImageBlobLike): void;
}

export interface ImageReadIO {
  readonly createReader: () => FileReaderLike;
}

/** 浏览器实现（懒构造：模块导入时不触碰 FileReader，node 环境可直接导入） */
export const browserImageReadIO: ImageReadIO = {
  createReader: () => new FileReader() as unknown as FileReaderLike,
};

export interface ImageReadMeta {
  readonly name: string;
  readonly mimeType?: string;
}

export interface ImageReadResult {
  readonly dataUrl: string;
  readonly bytes: number;
  readonly mimeType: string;
}

/** 读一张图片为 data URL（D-37）。读失败/空结果 → reject（调用方标 failed，不阻塞其余附件）。 */
export function readImageAsDataUrl(
  blob: ImageBlobLike,
  meta: ImageReadMeta,
  io: ImageReadIO,
): Promise<ImageReadResult> {
  return new Promise<ImageReadResult>((resolve, reject) => {
    const reader = io.createReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string' || result.length === 0) {
        reject(new Error('FileReader 未返回 data URL'));
        return;
      }
      const fromDataUrl = dataUrlMimeType(result);
      const mimeType = meta.mimeType ?? fromDataUrl ?? blob.type ?? 'application/octet-stream';
      resolve({ dataUrl: result, bytes: blob.size, mimeType });
    };
    reader.onerror = () => {
      reject(new Error(reader.error?.message ?? `图片读取失败：${meta.name}`));
    };
    reader.readAsDataURL(blob);
  });
}

function dataUrlMimeType(dataUrl: string): string | undefined {
  if (!dataUrl.startsWith('data:')) return undefined;
  const semi = dataUrl.indexOf(';');
  const comma = dataUrl.indexOf(',');
  const end = semi >= 0 ? semi : comma;
  if (end <= 5) return undefined;
  return dataUrl.slice(5, end);
}

// —— 文件：FIFO 上传队列（并发上限默认 2）——

export interface UploadTask {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: number;
  /** 浏览器 File / 已暂存句柄；传输层不解释它 */
  readonly file: unknown;
}

export interface UploadTransport {
  upload(task: UploadTask): Promise<{ token: string }>;
}

export interface FileUploadQueueOptions {
  readonly transport: UploadTransport;
  /** 并发上限（缺省 2；必须 >=1 的整数） */
  readonly maxConcurrent?: number;
  /** 每条附件状态变化时回调（待传 → 传输中 → ready/failed） */
  readonly onUpdate?: (attachment: ComposerAttachment) => void;
}

/**
 * 文件上传队列：FIFO 入队、并发上限、失败不阻塞后续、保序。
 * 不负责 UI；调用方以 `attachments()` 顺序拼装提交载荷。
 */
export class FileUploadQueue {
  private readonly transport: UploadTransport;
  private readonly limit: number;
  private readonly onUpdate: ((attachment: ComposerAttachment) => void) | undefined;
  private readonly pending: UploadTask[] = [];
  private readonly order: string[] = [];
  private readonly items = new Map<string, ComposerAttachment>();
  private readonly tasksById = new Map<string, UploadTask>();
  private active = 0;
  private peak = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(options: FileUploadQueueOptions) {
    const limit = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_FILE_UPLOADS;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`maxConcurrentFileUploads 必须是 >=1 的整数：${String(options.maxConcurrent)}`);
    }
    this.transport = options.transport;
    this.limit = limit;
    this.onUpdate = options.onUpdate;
  }

  get maxConcurrent(): number {
    return this.limit;
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** 观测到的峰值并发（并发上限断言的取证位） */
  get peakConcurrency(): number {
    return this.peak;
  }

  /** 是否仍有未落定的传输（queued / uploading） */
  get uploadsPending(): boolean {
    return this.pending.length > 0 || this.active > 0;
  }

  /** 附件列表：**选择顺序**（图片/文件混排也按入队顺序） */
  attachments(): readonly ComposerAttachment[] {
    return this.order.flatMap((id) => {
      const item = this.items.get(id);
      return item === undefined ? [] : [item];
    });
  }

  /** FIFO 追加并立即泵（不超过并发上限） */
  enqueue(tasks: readonly UploadTask[]): void {
    for (const task of tasks) {
      if (this.items.has(task.id)) continue;
      this.order.push(task.id);
      this.tasksById.set(task.id, task);
      const created: ComposerAttachment = {
        id: task.id,
        kind: 'file',
        name: task.name,
        mimeType: task.mimeType,
        bytes: task.bytes,
        state: 'queued',
      };
      this.items.set(task.id, created);
      this.pending.push(task);
      this.onUpdate?.(created); // 入队即上报：调用方的附件顺序在选文件那一刻就落定
    }
    this.pump();
  }

  /**
   * 移除草稿附件：排队中的直接跳过（不再传输），运行中的标记中止（transport 无法真取消——
   * 落定回调对已移除 id 为 no-op），列表里删除该条。
   */
  remove(id: string): void {
    const idx = this.pending.findIndex((t) => t.id === id);
    if (idx >= 0) this.pending.splice(idx, 1);
    this.items.delete(id);
    this.tasksById.delete(id);
    const at = this.order.indexOf(id);
    if (at >= 0) this.order.splice(at, 1);
    this.releaseIfIdle();
  }

  /** 失败重提：failed 项按原顺序重新排队（清错误），其余不受影响 */
  retryFailed(): void {
    for (const id of this.order) {
      const item = this.items.get(id);
      const task = this.tasksById.get(id);
      if (item?.state !== 'failed' || task === undefined) continue;
      this.items.set(id, { ...item, state: 'queued', error: undefined });
      this.pending.push(task);
    }
    this.pump();
  }

  /** 全部传输落定（含失败）后 resolve；空闲时立即 resolve */
  whenIdle(): Promise<void> {
    if (!this.uploadsPending) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private pump(): void {
    while (this.active < this.limit && this.pending.length > 0) {
      const task = this.pending.shift();
      if (task === undefined) return;
      this.active += 1;
      if (this.active > this.peak) this.peak = this.active;
      this.patch(task.id, { state: 'uploading' });
      void this.run(task);
    }
  }

  private async run(task: UploadTask): Promise<void> {
    try {
      const { token } = await this.transport.upload(task);
      this.settle(task.id, { state: 'ready', token });
    } catch (e) {
      this.settle(task.id, { state: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  }

  private settle(id: string, patch: Partial<ComposerAttachment>): void {
    this.active -= 1;
    this.patch(id, patch);
    this.pump(); // 失败也照常泵下一条：一个失败不阻塞后续
    this.releaseIfIdle();
  }

  private patch(id: string, patch: Partial<ComposerAttachment>): void {
    const current = this.items.get(id);
    if (current === undefined) return; // 已从草稿移除：落定回调 no-op
    const next: ComposerAttachment = { ...current, ...patch };
    this.items.set(id, next);
    this.onUpdate?.(next);
  }

  private releaseIfIdle(): void {
    if (this.uploadsPending) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const waiter of waiters) waiter();
  }
}
