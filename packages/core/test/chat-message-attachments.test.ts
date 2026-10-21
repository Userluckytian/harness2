import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildChatMessages } from '../src/agent/loop.js';
import { loadSession } from '../src/session/reader.js';
import { SessionWriter } from '../src/session/writer.js';
import { extensionEventTypes } from '../src/session/extension-events.js';

const ATTACHMENTS_EVENT = 'adapter/user-attachments';

function writeSessionWithAttachment(dir: string): void {
  if (!extensionEventTypes.has(ATTACHMENTS_EVENT)) {
    extensionEventTypes.register({
      type: ATTACHMENTS_EVENT,
      validator: (payload) => typeof payload.turnId === 'string' && Array.isArray(payload.attachments),
      projection: 'opaque',
    });
  }
  const writer = SessionWriter.create(dir, { sessionId: 's1', cwd: dir });
  writer.append('user/message', { text: '看图', turnId: 't1' });
  writer.appendExtension(ATTACHMENTS_EVENT, {
    turnId: 't1',
    attachments: [{ ref: 'D:/a.png', fileName: 'a.png', mime: 'image/png', bytes: 1 }],
  });
  writer.close();
}

describe('buildChatMessages attachment parts (ZS3.5)', () => {
  it('merges logged attachment refs into user message parts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h2-parts-'));
    try {
      writeSessionWithAttachment(dir);
      const messages = buildChatMessages(loadSession(dir), {
        resolveAttachment: (ref, mime) =>
          ref.endsWith('a.png') && mime === 'image/png' ? { type: 'image', mimeType: mime, dataBase64: 'AAAA' } : null,
      });
      expect(messages[0]?.content).toBe('看图');
      expect(messages[0]?.parts).toEqual([
        { type: 'text', text: '看图' },
        { type: 'image', mimeType: 'image/png', dataBase64: 'AAAA' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits an explicit placeholder when the resolver rejects an attachment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h2-parts-'));
    try {
      writeSessionWithAttachment(dir);
      const messages = buildChatMessages(loadSession(dir), {
        resolveAttachment: () => null,
      });
      expect(messages[0]?.parts).toEqual([
        { type: 'text', text: '看图' },
        { type: 'text', text: '[附件未加载: a.png (image/png)]' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves messages unchanged when no resolver is provided', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h2-parts-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeSessionWithAttachment(dir);
      const messages = buildChatMessages(loadSession(dir));
      expect(messages[0]?.content).toBe('看图');
      expect(messages[0]?.parts).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
