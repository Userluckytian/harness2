import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness2Services } from '../src/createHarness2Services.js';
import { loadSession } from '../src/real/core-bridge.js';
import { projectEvents } from '../src/real/v4-projection.js';

describe('ZS2 V2 integration: sendConversationCommandV4 same-source chain', () => {
  it('createSession+firstInput persists JSONL and replays', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-'));
    process.env.HARNESS2_HOME = home;
    const { services } = createHarness2Services({ home });
    const agent = services.getOptional((await import('@zcode/services')).IZCodeAgentService)!;

    const ack = await agent.sendConversationCommandV4({
      workspacePath: process.cwd(),
      envelope: {
        commandId: 'cmd-1',
        clientId: 'test',
        sessionId: null,
        type: 'createSession',
        payload: { firstInput: { text: 'hi' } },
        issuedAt: new Date().toISOString(),
      } as any,
    });
    expect(ack.status).toBe('accepted');

    // wait for async runSession
    await new Promise((r) => setTimeout(r, 3000));

    // find session dir
    const root = join(home, '.harness2', 'sessions');
    let found: string | undefined;
    function walk(d: string) {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === 'session.v1.jsonl') found = p;
      }
    }
    walk(root);
    expect(found).toBeTruthy();

    const dir = join(found!, '..');
    const session = loadSession(dir);
    const events = session.events.map((e: any) => e.event);
    const proj = projectEvents(events);
    expect(events.some((e: any) => e.type === 'user/message')).toBe(true);
    expect(proj.rows.some((r: any) => r.kind === 'assistantText')).toBe(true);

    rmSync(home, { recursive: true, force: true });
  }, 20000);
});
