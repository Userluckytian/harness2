import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderSettingsService } from '../src/real/provider-views.js';

describe('provider-views executable (P1-1)', () => {
  it('returns executable=true when config provider has auth apiKey', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-pv-'));
    const hdir = join(home, '.harness2');
    mkdirSync(hdir, { recursive: true });
    writeFileSync(
      join(hdir, 'config.json'),
      JSON.stringify({
        providers: { deepseek: { protocol: 'openai', baseUrl: 'https://x', models: { m: {} } } },
        roles: { main: { channel: 'deepseek', model: 'm' } },
      }),
    );
    writeFileSync(join(hdir, 'auth.json'), JSON.stringify({ channels: { deepseek: { apiKey: 'sk-test' } } }));
    const svc = createProviderSettingsService({ home });
    const view: any = await (svc as any).getView();
    const p = view.providers.find((x: any) => x.providerId === 'deepseek');
    expect(p.executable).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('provider-views T8', () => {
  it('reorderPersonalProviders unknown id throws', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-pv-reorder-'));
    const svc: any = createProviderSettingsService({ home });
    await expect(svc.reorderPersonalProviders(['ghost-id'])).rejects.toThrow();
    rmSync(home, { recursive: true, force: true });
  });

  it('deletePersonalProvider auth file invalid JSON -> deletion success + console.error', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-pv-delauth-'));
    const hdir = join(home, '.harness2');
    mkdirSync(hdir, { recursive: true });
    const svc: any = createProviderSettingsService({ home });
    const created: any = await svc.createPersonalProvider({ providerName: 'TestProvider' });
    const providerId = created.providerId;
    writeFileSync(join(hdir, 'auth.json'), '{not json');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = await svc.deletePersonalProvider(providerId);
    expect(view).toBeTruthy();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
  });
});
