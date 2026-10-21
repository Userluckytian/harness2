import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AttachmentStore, ATTACHMENT_CHUNK_MAX_BYTES } from '../src/real/attachment-store.js';

const sha256 = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function withStore(run: (store: AttachmentStore, home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'h2-att-'));
  try {
    run(new AttachmentStore({ home }), home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function beginParams(
  uploadId: string,
  bytes: Buffer,
  overrides: Partial<{ checksum: string; mime: string; totalChunks: number }> = {},
) {
  return {
    connectionId: 'conn-1',
    uploadId,
    sessionId: 's1',
    fileName: 'note.txt',
    mime: overrides.mime ?? 'text/plain',
    totalBytes: bytes.byteLength,
    totalChunks: overrides.totalChunks ?? 2,
    checksum: overrides.checksum ?? sha256(bytes),
  };
}

describe('ZS3-T5 attachment upload transaction', () => {
  it('uploads two chunks, commits, and reads back by offset', () => {
    withStore((store, home) => {
      const content = Buffer.from('hello world');
      const first = content.subarray(0, 6);
      const second = content.subarray(6);
      expect(store.begin(beginParams('up-1', content))).toEqual({
        uploadId: 'up-1',
        state: 'staging',
        nextChunkIndex: 0,
      });
      expect(
        store.chunk({
          connectionId: 'conn-1',
          uploadId: 'up-1',
          sessionId: 's1',
          chunkIndex: 0,
          dataBase64: first.toString('base64'),
        }),
      ).toEqual({
        uploadId: 'up-1',
        nextChunkIndex: 1,
      });
      expect(
        store.chunk({
          connectionId: 'conn-1',
          uploadId: 'up-1',
          sessionId: 's1',
          chunkIndex: 1,
          dataBase64: second.toString('base64'),
        }),
      ).toEqual({
        uploadId: 'up-1',
        nextChunkIndex: 2,
      });
      const committed = store.commit({ connectionId: 'conn-1', uploadId: 'up-1', sessionId: 's1' });
      expect(existsSync(committed.ref)).toBe(true);
      expect(committed.ref.startsWith(join(home, '.harness2', 'zs', 'attachments', 'up-1'))).toBe(true);

      const full = store.read({ sessionId: 's1', ref: committed.ref, offset: 0, limit: 100 });
      expect(Buffer.from(full.dataBase64, 'base64').toString()).toBe('hello world');
      expect(full.mediaType).toBe('text/plain');
      expect(full.totalBytes).toBe(content.byteLength);
      expect(full.nextOffset).toBeNull();

      const part = store.read({ sessionId: 's1', ref: committed.ref, offset: 0, limit: 4 });
      expect(Buffer.from(part.dataBase64, 'base64').toString()).toBe('hell');
      expect(part.nextOffset).toBe(4);

      // 幂等 commit
      expect(store.commit({ connectionId: 'conn-1', uploadId: 'up-1', sessionId: 's1' })).toEqual(committed);
    });
  });

  it('rejects out-of-order chunks and oversize chunks with fault codes', () => {
    withStore((store) => {
      const content = Buffer.from('abcdef');
      store.begin(beginParams('up-2', content));
      expect(() =>
        store.chunk({ connectionId: 'c', uploadId: 'up-2', sessionId: 's1', chunkIndex: 1, dataBase64: 'ZGVm' }),
      ).toThrowError(/fault\.attachment\.outOfOrder/);

      const huge = Buffer.alloc(ATTACHMENT_CHUNK_MAX_BYTES + 1);
      expect(() =>
        store.chunk({
          connectionId: 'c',
          uploadId: 'up-2',
          sessionId: 's1',
          chunkIndex: 0,
          dataBase64: huge.toString('base64'),
        }),
      ).toThrowError(/fault\.attachment\.chunkTooLarge/);
    });
  });

  it('aborts and removes staging data; unknown upload faults', () => {
    withStore((store) => {
      const content = Buffer.from('abcdef');
      store.begin(beginParams('up-3', content));
      store.chunk({
        connectionId: 'c',
        uploadId: 'up-3',
        sessionId: 's1',
        chunkIndex: 0,
        dataBase64: Buffer.from('abc').toString('base64'),
      });
      store.abort({ connectionId: 'c', uploadId: 'up-3', sessionId: 's1' });
      expect(() =>
        store.chunk({ connectionId: 'c', uploadId: 'up-3', sessionId: 's1', chunkIndex: 0, dataBase64: 'YWJj' }),
      ).toThrowError(/fault\.attachment\.unknownUpload/);
    });
  });

  it('rejects checksum mismatch at commit', () => {
    withStore((store) => {
      const content = Buffer.from('abcdef');
      store.begin(beginParams('up-4', content, { checksum: sha256(Buffer.from('other')) }));
      store.chunk({
        connectionId: 'c',
        uploadId: 'up-4',
        sessionId: 's1',
        chunkIndex: 0,
        dataBase64: Buffer.from('abc').toString('base64'),
      });
      store.chunk({
        connectionId: 'c',
        uploadId: 'up-4',
        sessionId: 's1',
        chunkIndex: 1,
        dataBase64: Buffer.from('def').toString('base64'),
      });
      expect(() => store.commit({ connectionId: 'c', uploadId: 'up-4', sessionId: 's1' })).toThrowError(
        /fault\.attachment\.checksumMismatch/,
      );
    });
  });

  it('rejects incomplete commit and uploadId metadata conflicts', () => {
    withStore((store) => {
      const content = Buffer.from('abcdef');
      store.begin(beginParams('up-5', content));
      expect(() => store.commit({ connectionId: 'c', uploadId: 'up-5', sessionId: 's1' })).toThrowError(
        /fault\.attachment\.incomplete/,
      );
      expect(() => store.begin(beginParams('up-5', content, { mime: 'image/png' }))).toThrowError(
        /fault\.attachment\.uploadConflict/,
      );
    });
  });

  it('rejects path-traversal uploadIds and reads outside the authorized projection', () => {
    withStore((store, home) => {
      expect(() => store.begin({ ...beginParams('up-6', Buffer.from('x')), uploadId: '../escape' })).toThrowError(
        /fault\.attachment\.invalidUploadId/,
      );

      const file = join(home, 'secret.txt');
      writeFileSync(file, 'secret');
      expect(() => store.read({ sessionId: 's1', ref: file, offset: 0, limit: 10 }, new Set())).toThrowError(
        /fault\.attachment\.notAuthorized/,
      );
    });
  });

  it('materializes a local ref into the attachment store', () => {
    withStore((store, home) => {
      const source = join(home, 'local.png');
      writeFileSync(source, Buffer.from('png-bytes'));
      const ref = store.materialize(source);
      expect(ref.startsWith(join(home, '.harness2', 'zs', 'attachments'))).toBe(true);
      expect(readFileSync(ref)).toEqual(Buffer.from('png-bytes'));
      expect(store.materialize(ref)).toBe(ref);
    });
  });
});
