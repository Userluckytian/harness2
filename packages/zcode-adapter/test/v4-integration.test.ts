import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSessionManager,
  defaultSessionsRoot,
  runTurn,
  loadSession,
  ToolRegistry,
  MockProvider,
  resolveHarness2Home,
} from '../src/real/core-bridge.js';
import { projectEvents } from '../src/real/v4-projection.js';

describe('ZS2 V2 integration: core turn persists and replays', () => {
  it('runs a mock turn, persists JSONL, and projection replays', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-'));
    const root = defaultSessionsRoot(home);
    const manager = createSessionManager(root);
    const created = manager.create(process.cwd());
    const tools = new ToolRegistry();
    const provider = new MockProvider([{ text: 'Hello from harness2 mock provider.' }]);
    await runTurn(created.writer, {
      provider: provider as never,
      tools: tools as never,
      cwd: created.dir,
      userText: 'hi',
      onStream: () => {},
    });
    created.writer.close();
    const session = loadSession(created.dir);
    const events = session.events.map((e: any) => e.event);
    const proj = projectEvents(events);
    expect(proj.rows.some((r: any) => r.kind === 'assistantText')).toBe(true);
    expect(events.some((e: any) => e.type === 'user/message')).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});