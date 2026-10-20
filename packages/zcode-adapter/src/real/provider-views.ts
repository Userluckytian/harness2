import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig, defaultConfigPaths, readAuthFile, redactSecrets } from '@harness2/core';
import type { IModelSelectionService, IProviderSettingsService } from '@zcode/services';
import { createStubService } from '../stub-factory.js';

export interface ProviderViewsOptions {
  dataRoot?: string;
  home?: string;
}

function readConfig(dataRoot?: string, home?: string) {
  const root = process.cwd();
  const paths = defaultConfigPaths(root, home);
  const loaded = loadConfig({ root, ...(home !== undefined ? { home } : {}) });
  return { loaded, paths };
}

export function createModelSelectionService(opts: ProviderViewsOptions = {}): IModelSelectionService {
  const home = opts.home ?? homedir();
  const impl = {
    async getView(): Promise<unknown> {
      try {
        const loaded = loadConfig({ root: process.cwd(), home });
        const cfg = loaded.config;
        if (!cfg) return { revision: 0, providers: [] };
        const auth = readAuthFile(join(home, '.harness2', 'auth.json'));
        const providers: unknown[] = [];
        for (const [channel, pcfg] of Object.entries(cfg.providers ?? {})) {
          const p = pcfg as { protocol?: string; baseUrl?: string; models?: Record<string, { contextWindow?: number }>; envKey?: string };
          const models = Object.keys(p.models ?? {});
          const keyExists = !!auth.auth?.channels?.[channel]?.apiKey;
          const envKey = p.envKey;
          const envExists = envKey ? !!process.env[envKey] : false;
          const executable = keyExists || envExists;
          providers.push({
            providerId: channel,
            config: p,
            models: models.map((m) => ({ modelId: m, ...(p.models?.[m] ?? {}) })),
          });
        }
        // preferred selection from roles.main
        const mainRole = cfg.roles?.main;
        return {
          revision: 1,
          providers,
          preferredSelection: mainRole ? { providerId: mainRole.channel, modelId: mainRole.model } : undefined,
        };
      } catch (e) {
        // redact secrets in error
        const msg = redactSecrets((e as Error).message ?? '');
        throw new Error(msg);
      }
    },
    async onDidChange(): Promise<unknown> {
      return undefined;
    },
  };
  return createStubService<IModelSelectionService>({
    channelName: 'model-selection',
    classification: 'A',
    impl: impl as Record<string, unknown>,
  });
}

export function createProviderSettingsService(opts: ProviderViewsOptions = {}): IProviderSettingsService {
  const home = opts.home ?? homedir();
  const impl = {
    async getView(): Promise<unknown> {
      try {
        const loaded = loadConfig({ root: process.cwd(), home });
        const cfg = loaded.config;
        if (!cfg) return { revision: 0, providerTemplates: [], providerOrder: [], providers: [] };
        const auth = readAuthFile(join(home, '.harness2', 'auth.json'));
        const providers: unknown[] = [];
        for (const [channel, pcfg] of Object.entries(cfg.providers ?? {})) {
          const p = pcfg as { models?: Record<string, unknown>; envKey?: string };
          const keyExists = !!auth.auth?.channels?.[channel]?.apiKey;
          const envKey = p.envKey;
          const envExists = envKey ? !!process.env[envKey] : false;
          const executable = keyExists || envExists;
          providers.push({
            providerId: channel,
            enabled: true,
            executable,
            issues: executable ? [] : ['no_api_key'],
            models: Object.keys(p.models ?? {}).map((m) => ({ modelId: m })),
          });
        }
        return {
          revision: 1,
          providerTemplates: [],
          providerOrder: Object.keys(cfg.providers ?? {}),
          providers,
        };
      } catch (e) {
        const msg = redactSecrets((e as Error).message ?? '');
        throw new Error(msg);
      }
    },
    async refresh(): Promise<unknown> {
      return this.getView();
    },
  };
  return createStubService<IProviderSettingsService>({
    channelName: 'provider-settings',
    classification: 'A',
    impl: impl as Record<string, unknown>,
    throws: [
      'createPersonalProvider',
      'savePersonalProviderOverlay',
      'deletePersonalProvider',
      'reorderPersonalProviders',
      'reorderPersonalModels',
      'addPersonalModel',
      'renamePersonalModel',
      'deletePersonalModel',
      'savePersonalModelDraft',
      'setPersonalModelEnabled',
      'testModelConnectivity',
    ],
  });
}
