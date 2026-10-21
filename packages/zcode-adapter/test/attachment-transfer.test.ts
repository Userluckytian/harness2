import { describe, expect, it } from 'vitest';
import { createLocalPromptAttachmentTransferService } from '../src/real/attachment-transfer.js';

describe('ZS3-T3 local attachment transfer service', () => {
  it('stages localPath zero-copy and no-ops lifecycle calls', async () => {
    const service = createLocalPromptAttachmentTransferService();
    const staged = await service.stage({
      operationId: 'op-1',
      sessionId: 's1',
      workspacePath: 'D:/workspace',
      localPath: 'D:/tmp/a.png',
      fileName: 'a.png',
      mime: 'image/png',
      sizeBytes: 123,
    });
    expect(staged).toEqual({
      operationId: 'op-1',
      ref: 'D:/tmp/a.png',
      bytes: 123,
      staged: true,
    });
    await expect(service.adopt('op-1')).resolves.toBeUndefined();
    await expect(service.cancel('op-1')).resolves.toBeUndefined();
    await expect(service.cleanup('op-1')).resolves.toBeUndefined();
  });
});
