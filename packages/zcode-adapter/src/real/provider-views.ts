import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig, defaultConfigPaths, readAuthFile, redactSecrets, resolveHarness2Home } from './core-bridge.js';
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
  const home = opts.home ?? resolveHarness2Home();
  const impl = {
    async getView(input?: unknown): Promise<unknown> {
      try {
        const loaded = loadConfig({ root: process.cwd(), home });
        const cfg = loaded.config;
        if (!cfg) return { revision: 0, providers: [] };
        const auth = readAuthFile(join(home, '.harness2', 'auth.json')) as { channels?: Record<string, { apiKey?: string }> };
        const providers: unknown[] = [];
        for (const [channel, pcfg] of Object.entries(cfg.providers ?? {})) {
          const p = pcfg as { protocol?: string; baseUrl?: string; models?: Record<string, { contextWindow?: number }>; envKey?: string };
          const models = Object.keys(p.models ?? {});
          const keyExists = !!auth?.channels?.[channel]?.apiKey;
          const envKey = p.envKey;
          const envExists = envKey ? !!process.env[envKey] : false;
          const executable = keyExists || envExists;
          providers.push({
            providerId: channel,
            config: p,
            models: models.map((m) => ({
              modelId: m,
              config: {
                optionSpecs: {
                  reasoningLevel: { values: ['medium'], map: {} },
                },
              },
              ...(p.models?.[m] ?? {}),
            })),
          });
        }
        // preferred selection from roles.main
        const mainRole = cfg.roles?.main;
        const preferredSelection = mainRole
          ? { providerId: mainRole.channel, modelId: mainRole.model, options: { reasoningLevel: 'medium' } }
          : undefined;

        const result: Record<string, unknown> = {
          revision: 1,
          providers,
          ...(preferredSelection ? { preferredSelection } : {}),
        };

        // Gate B (ZS2): UI 通过 getView(input) 传入当前草稿 selection，服务端必须回填
        // effectiveSelection，否则 useDraftConfigControl 派生的 draftConfig.modelSelection
        // 为空，Composer submissionReady 永远为 false → Send 按钮永久 disabled。
        // 判据来源：refs ZCode packages/ui/src/v4/composer/useDraftConfigControl.ts:265-275
        // 与 packages/provider/src/effective-model-selection.ts。
        const inp = input as { selection?: { providerId?: string; modelId?: string; options?: { reasoningLevel?: string } } } | undefined;
        if (inp !== undefined) {
          const sel = inp?.selection ?? null;
          if (!sel) {
            result.effectiveSelection = null;
            result.selectionIssue = 'selection-missing';
          } else {
            const provider = (providers as { providerId: string; models: { modelId: string; config: { optionSpecs: { reasoningLevel: { values: string[] } } } }[] }[]).find(
              (p) => p.providerId === sel.providerId,
            );
            const model = provider?.models.find((m) => m.modelId === sel.modelId);
            if (!provider) {
              result.effectiveSelection = null;
              result.selectionIssue = 'provider-not-found';
            } else if (!model) {
              result.effectiveSelection = null;
              result.selectionIssue = 'model-not-found';
            } else {
              const reasoningLevel = sel.options?.reasoningLevel;
              const values = model.config.optionSpecs.reasoningLevel.values;
              const valid = reasoningLevel !== undefined && values.includes(reasoningLevel);
              const effective: Record<string, unknown> = {
                providerId: sel.providerId,
                modelId: sel.modelId,
              };
              if (valid && sel.options) {
                effective.options = { ...sel.options };
              }
              result.effectiveSelection = effective;
              if (!valid) {
                result.selectionIssue =
                  reasoningLevel === undefined ? 'reasoning-level-missing' : 'reasoning-level-not-supported';
              }
            }
          }
        }

        return result;
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
  const home = opts.home ?? resolveHarness2Home();
  const impl = {
    async getView(): Promise<unknown> {
      try {
        const loaded = loadConfig({ root: process.cwd(), home });
        const cfg = loaded.config;
        if (!cfg) return { revision: 0, providerTemplates: [], providerOrder: [], providers: [] };
        const auth = readAuthFile(join(home, '.harness2', 'auth.json')) as { channels?: Record<string, { apiKey?: string }> };
        const providers: unknown[] = [];
        for (const [channel, pcfg] of Object.entries(cfg.providers ?? {})) {
          const p = pcfg as { models?: Record<string, unknown>; envKey?: string };
          const keyExists = !!auth?.channels?.[channel]?.apiKey;
          const envKey = p.envKey;
          const envExists = envKey ? !!process.env[envKey] : false;
          const executable = keyExists || envExists;
          providers.push({
            providerId: channel,
            enabled: true,
            executable,
            issues: executable ? [] : ['no_api_key'],
            effectiveConfig: { access: null },
            accountState: { availability: executable ? 'available' : 'unavailable', unavailableReason: executable ? undefined : 'no_api_key' },
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
      'deletePersonalModel',
      'savePersonalModelDraft',
      'setPersonalModelEnabled',
      'testModelConnectivity',
    ],
  });
}
