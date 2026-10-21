import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

/** 协议单块上限（attachmentChunkMaxBytes = 512 KiB）；UI 实际按 384 KiB 切片。 */
export const ATTACHMENT_CHUNK_MAX_BYTES = 512 * 1024;

export interface AttachmentBeginParams {
  /** wire 层由 trusted carrier 注入；service 接口不携带，adapter 不需要它。 */
  connectionId?: string;
  uploadId: string;
  sessionId: string;
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
}

export type AttachmentBeginResult =
  | { uploadId: string; state: 'staging'; nextChunkIndex: number }
  | { uploadId: string; state: 'committed'; nextChunkIndex: number; ref: string };

export interface AttachmentChunkParams {
  connectionId?: string;
  uploadId: string;
  sessionId: string;
  chunkIndex: number;
  dataBase64: string;
}

export interface AttachmentTerminalParams {
  connectionId?: string;
  uploadId: string;
  sessionId: string;
}

export interface AttachmentReadParams {
  sessionId: string;
  ref: string;
  offset: number;
  limit: number;
}

export interface AttachmentReadResult {
  dataBase64: string;
  mediaType: string;
  totalBytes: number;
  nextOffset: number | null;
}

interface UploadRecord {
  uploadId: string;
  sessionId: string;
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
  nextChunkIndex: number;
  dir: string;
  committedRef?: string;
}

function fault(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`);
  (error as Error & { code?: string }).code = code;
  return error;
}

function decodeBase64(dataBase64: string): Buffer {
  // Buffer.from 对非法 base64 会静默截断；先按长度/字符做一次严格校验。
  if (dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
    throw fault('fault.attachment.invalidBase64', 'invalid base64 payload');
  }
  return Buffer.from(dataBase64, 'base64');
}

function mediaTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    case '.pdf':
      return 'application/pdf';
    case '.txt':
    case '.md':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

/**
 * ZS3-T5 附件上传事务（begin → chunk* → commit / abort）+ 分块回读。
 *
 * 约束：
 * - chunk 必须严格按 nextChunkIndex 顺序到达（乱序/重复一律 fault，不猜测补洞）；
 * - 单块解码字节 ≤ 512 KiB；
 * - commit 前必须收齐所有块，sha256 与 begin 声明一致才落定；
 * - 暂存目录 `~/.harness2/zs/attachments/<uploadId>/`，abort 清理，commit 保留。
 */
export class AttachmentStore {
  private readonly uploads = new Map<string, UploadRecord>();

  constructor(private readonly options: { home: string }) {}

  private root(): string {
    return join(this.options.home, '.harness2', 'zs', 'attachments');
  }

  private uploadDir(uploadId: string): string {
    return join(this.root(), uploadId);
  }

  begin(params: AttachmentBeginParams): AttachmentBeginResult {
    if ((params.totalBytes === 0) !== (params.totalChunks === 0)) {
      throw fault('fault.attachment.invalidBegin', 'zero-byte upload must declare zero chunks');
    }
    const existing = this.uploads.get(params.uploadId);
    if (existing) {
      const same =
        existing.sessionId === params.sessionId &&
        existing.fileName === params.fileName &&
        existing.mime === params.mime &&
        existing.totalBytes === params.totalBytes &&
        existing.totalChunks === params.totalChunks &&
        existing.checksum === params.checksum;
      if (!same) {
        throw fault('fault.attachment.uploadConflict', 'uploadId reused with different metadata');
      }
      if (existing.committedRef) {
        return {
          uploadId: existing.uploadId,
          state: 'committed',
          nextChunkIndex: existing.totalChunks,
          ref: existing.committedRef,
        };
      }
      return { uploadId: existing.uploadId, state: 'staging', nextChunkIndex: existing.nextChunkIndex };
    }

    const dir = this.uploadDir(params.uploadId);
    mkdirSync(dir, { recursive: true });
    const record: UploadRecord = {
      uploadId: params.uploadId,
      sessionId: params.sessionId,
      fileName: params.fileName,
      mime: params.mime,
      totalBytes: params.totalBytes,
      totalChunks: params.totalChunks,
      checksum: params.checksum,
      nextChunkIndex: 0,
      dir,
    };
    this.uploads.set(params.uploadId, record);
    return { uploadId: params.uploadId, state: 'staging', nextChunkIndex: 0 };
  }

  chunk(params: AttachmentChunkParams): { uploadId: string; nextChunkIndex: number } {
    const upload = this.uploads.get(params.uploadId);
    if (!upload) throw fault('fault.attachment.unknownUpload', 'unknown uploadId');
    if (upload.committedRef) throw fault('fault.attachment.alreadyCommitted', 'upload already committed');
    if (params.chunkIndex !== upload.nextChunkIndex) {
      throw fault('fault.attachment.outOfOrder', `expected chunk ${upload.nextChunkIndex}, got ${params.chunkIndex}`);
    }
    if (params.chunkIndex >= upload.totalChunks) {
      throw fault('fault.attachment.chunkOutOfRange', 'chunk index exceeds totalChunks');
    }
    const bytes = decodeBase64(params.dataBase64);
    if (bytes.byteLength > ATTACHMENT_CHUNK_MAX_BYTES) {
      throw fault('fault.attachment.chunkTooLarge', 'chunk exceeds 512 KiB');
    }
    writeFileSync(join(upload.dir, `chunk-${params.chunkIndex}.bin`), bytes);
    upload.nextChunkIndex += 1;
    return { uploadId: upload.uploadId, nextChunkIndex: upload.nextChunkIndex };
  }

  commit(params: AttachmentTerminalParams): { ref: string } {
    const upload = this.uploads.get(params.uploadId);
    if (!upload) throw fault('fault.attachment.unknownUpload', 'unknown uploadId');
    if (upload.committedRef) return { ref: upload.committedRef };
    if (upload.nextChunkIndex !== upload.totalChunks) {
      throw fault('fault.attachment.incomplete', `received ${upload.nextChunkIndex}/${upload.totalChunks} chunks`);
    }

    const chunks: Buffer[] = [];
    for (let index = 0; index < upload.totalChunks; index += 1) {
      const chunkPath = join(upload.dir, `chunk-${index}.bin`);
      if (!existsSync(chunkPath)) {
        throw fault('fault.attachment.missingChunk', `missing chunk ${index}`);
      }
      chunks.push(readFileSync(chunkPath));
    }
    const content = Buffer.concat(chunks);
    if (content.byteLength !== upload.totalBytes) {
      throw fault('fault.attachment.sizeMismatch', `expected ${upload.totalBytes} bytes, got ${content.byteLength}`);
    }
    const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    if (digest !== upload.checksum) {
      throw fault('fault.attachment.checksumMismatch', 'sha256 does not match begin declaration');
    }

    const ref = join(upload.dir, 'content.bin');
    writeFileSync(ref, content);
    upload.committedRef = ref;
    return { ref };
  }

  abort(params: AttachmentTerminalParams): void {
    const upload = this.uploads.get(params.uploadId);
    // 已提交的内容可能已被 sendText 引用，abort 只清理未完成事务。
    if (!upload || upload.committedRef) return;
    this.uploads.delete(params.uploadId);
    rmSync(upload.dir, { recursive: true, force: true });
  }

  read(params: AttachmentReadParams): AttachmentReadResult {
    const path = resolve(params.ref);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      throw fault('fault.attachment.notFound', 'attachment ref does not exist');
    }
    if (!stat.isFile()) throw fault('fault.attachment.notFound', 'attachment ref is not a file');
    if (params.offset > stat.size) {
      throw fault('fault.attachment.readOutOfRange', 'offset exceeds file size');
    }
    const limit = Math.max(1, Math.min(params.limit, ATTACHMENT_CHUNK_MAX_BYTES));
    const end = Math.min(params.offset + limit, stat.size);
    const bytes = readFileSync(path).subarray(params.offset, end);
    const mediaType = [...this.uploads.values()].find((u) => u.committedRef === path)?.mime ?? mediaTypeForPath(path);
    if (mediaType === 'application/octet-stream') {
      throw fault('fault.attachment.unsupportedMediaType', 'preview only supports image/video/pdf/text');
    }
    return {
      dataBase64: bytes.toString('base64'),
      mediaType,
      totalBytes: stat.size,
      nextOffset: end < stat.size ? end : null,
    };
  }

  previewSource(params: {
    ref: string;
    clientMode: string;
  }): { kind: 'local_path'; path: string; mediaType: string } | { kind: 'chunked' } {
    const path = resolve(params.ref);
    if (!existsSync(path)) return { kind: 'chunked' };
    const mediaType = [...this.uploads.values()].find((u) => u.committedRef === path)?.mime ?? mediaTypeForPath(path);
    if (params.clientMode === 'desktop-continuous' && mediaType.startsWith('video/')) {
      return { kind: 'local_path', path, mediaType };
    }
    return { kind: 'chunked' };
  }
}
