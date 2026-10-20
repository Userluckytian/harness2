import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { AppSettings } from '@zcode/shared';

export interface SettingsStoreOptions {
  /** 数据根；默认 ~/.harness2 */
  dataRoot?: string;
}

export class SettingsStore {
  private readonly filePath: string;

  constructor(opts: SettingsStoreOptions = {}) {
    const root = opts.dataRoot ?? join(homedir(), '.harness2');
    this.filePath = join(root, 'zs', 'setting.json');
  }

  get(): AppSettings {
    try {
      if (existsSync(this.filePath)) {
        const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
        return { recentProjects: [], locale: 'en-US', ...raw };
      }
    } catch {
      // fall through
    }
    return { recentProjects: [], locale: 'en-US', providerFamilyDomain: 'zai', providerFamilyDomainMigrated: true, onboardingOccupation: 'other' } as AppSettings;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const cur = this.get();
    const next = { ...cur, ...patch };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  get path(): string {
    return this.filePath;
  }
}

export function createSettingsStore(opts?: SettingsStoreOptions): SettingsStore {
  return new SettingsStore(opts);
}
