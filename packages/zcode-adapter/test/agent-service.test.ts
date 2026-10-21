import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentService } from '../src/real/agent-service.js';

describe('ZS3-T0 command ACK whitelist', () => {
  it('rejects commands outside the whitelist and never fakes accepted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-ack-'));
    try {
      const agent = createAgentService({ home });
      const rejected = await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: { commandId: 'cmd-reject', type: 'resolveInteraction' } as never,
      });
      expect(rejected).toMatchObject({
        commandId: 'cmd-reject',
        status: 'rejected',
        reasonCode: 'proto.commandUnsupported',
      });

      const stop = await agent.sendConversationCommandV4({
        workspacePath: home,
        envelope: { commandId: 'cmd-stop', type: 'stop' } as never,
      });
      expect(stop).toMatchObject({ commandId: 'cmd-stop', status: 'accepted' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
