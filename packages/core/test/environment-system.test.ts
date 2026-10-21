import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTurn } from '../src/agent/loop.js';
import { MockProvider } from '../src/provider/mock.js';
import { SessionWriter } from '../src/session/writer.js';
import { ToolRegistry } from '../src/tools/registry.js';

describe('environment system block (ZS3.5)', () => {
  it('injects cwd/workspace/platform into ChatRequest.system', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h2-env-'));
    const writer = SessionWriter.create(dir, { sessionId: 's1', cwd: dir });
    const provider = new MockProvider([{ text: 'ok' }]);
    try {
      await runTurn(writer, {
        provider,
        tools: new ToolRegistry(),
        cwd: dir,
        userText: 'hi',
        environment: { cwd: dir, workspacePath: 'D:/workspace', platform: 'win32' },
      });
      const system = provider.requests[0]?.system ?? '';
      expect(system).toContain('[环境]');
      expect(system).toContain(dir);
      expect(system).toContain('D:/workspace');
      expect(system).toContain('win32');
    } finally {
      try {
        writer.close();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps system undefined when no environment is provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h2-env-'));
    const writer = SessionWriter.create(dir, { sessionId: 's1', cwd: dir });
    const provider = new MockProvider([{ text: 'ok' }]);
    try {
      await runTurn(writer, {
        provider,
        tools: new ToolRegistry(),
        cwd: dir,
        userText: 'hi',
      });
      expect(provider.requests[0]?.system).toBeUndefined();
    } finally {
      try {
        writer.close();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
