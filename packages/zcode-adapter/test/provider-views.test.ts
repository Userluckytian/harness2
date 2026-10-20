import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderSettingsService } from '../src/real/provider-views.js';

describe('provider-views executable (P1-1)', () => {
  it('returns executable=true when config provider has auth apiKey', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-pv-'));
    const hdir = join(home, '.harness2');
    mkdirSync(hdir, { recursive: true });
    writeFileSync(join(hdir, 'config.json'), JSON.stringify({
      providers: { deepseek: { protocol: 'openai', baseUrl: 'https://x', models: { 'm': {} } } },
      roles: { main: { channel: 'deepseek', model: 'm' } },
    }));
    writeFileSync(join(hdir, 'auth.json'), JSON.stringify({ channels: { deepseek: { apiKey: 'sk-test' } } }));
    const svc = createProviderSettingsService({ home });
    const view: any = await (svc as any).getView();
    const p = view.providers.find((x: any) => x.providerId === 'deepseek');
    expect(p.executable).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});
