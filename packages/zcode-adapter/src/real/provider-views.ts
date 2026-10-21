import { loadConfig, readAuthFile, redactSecrets, resolveHarness2Home } from './core-bridge.js';
import { ProviderWriteStore, reorderRecord, replaceKeyPreserveOrder } from './provider-writes.js';
import type { StoredProviderConfig } from './provider-writes.js';
import { Emitter } from '@zcode/rpc';
import type { IModelSelectionService, IProviderSettingsService } from '@zcode/services';
import { createStubService } from '../stub-factory.js';

export interface ProviderViewsOptions {
  dataRoot?: string;
  home?: string;
}

export function createModelSelectionService(opts: ProviderViewsOptions = {}): IModelSelectionService {
  const home = opts.home ?? resolveHarness2Home();
  const impl = {
    async getView(input?: unknown): Promise<unknown> {
      try {
        const loaded = loadConfig({ root: process.cwd(), home });
        const cfg = loaded.config;
        if (!cfg) return { revision: 0, providers: [] };
        // auth not needed in model-selection view (ZS2 stub)
        const providers: unknown[] = [];
        for (const [channel, pcfg] of Object.entries(cfg.providers ?? {})) {
          const p = pcfg as {
            protocol?: string;
            baseUrl?: string;
            models?: Record<string, { contextWindow?: number }>;
            envKey?: string;
          };
          const models = Object.keys(p.models ?? {});
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
        const inp = input as
          { selection?: { providerId?: string; modelId?: string; options?: { reasoningLevel?: string } } } | undefined;
        if (inp !== undefined) {
          const sel = inp?.selection ?? null;
          if (!sel) {
            result.effectiveSelection = null;
            result.selectionIssue = 'selection-missing';
          } else {
            const provider = (
              providers as {
                providerId: string;
                models: { modelId: string; config: { optionSpecs: { reasoningLevel: { values: string[] } } } }[];
              }[]
            ).find((p) => p.providerId === sel.providerId);
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
  const store = new ProviderWriteStore(home);
  const changeEmitter = new Emitter<unknown>();

  /** 写路径统一出口：重建视图 + 广播 onDidChange（UI commitProviderSettingsView 消费）。 */
  function afterMutation(): unknown {
    const view = buildView();
    changeEmitter.fire(view);
    return view;
  }

  /**
   * 视图从**原始 config.json** 投影（写路径同源，避免归一化丢字段）。
   * 形状：`ProviderSettingsProviderView`（facades.ts:149-163）；`enabled` 与模型 `enabled`
   * 存为条目上的布尔扩展键（core schema 对未知键只告警——已核实 PROVIDER_KNOWN_KEYS 外不报错）。
   */
  function buildView(): unknown {
    try {
      const raw = store.readRaw();
      const providersCfg = raw.providers ?? {};
      const authResult = readAuthFile(store.authPath);
      const auth = authResult.auth;
      let revision = 1;
      if (typeof raw.revision === 'number') revision = raw.revision;
      else if (typeof raw['_h2Revision'] === 'number') revision = raw['_h2Revision'] as number;

      const providers = Object.entries(providersCfg).map(([channel, entry]) => {
        const pcfg = (entry ?? {}) as StoredProviderConfig;
        const models = (pcfg.models ?? {}) as Record<string, unknown>;
        const keyExists = !!auth?.channels?.[channel]?.apiKey;
        const envKey = pcfg.envKey;
        const envExists = typeof envKey === 'string' && envKey.length > 0 ? !!process.env[envKey] : false;
        const executable = keyExists || envExists;
        const enabledValue = pcfg.enabled;
        const enabled = typeof enabledValue === 'boolean' ? enabledValue : true;
        return {
          providerId: channel,
          enabled,
          executable,
          issues: executable ? [] : ['no_api_key'],
          effectiveConfig: {
            protocol: pcfg.protocol,
            baseUrl: pcfg.baseUrl,
            models: Object.keys(models).map((m) => ({ modelId: m })),
          },
          accountState: {
            availability: executable ? 'available' : 'unavailable',
            unavailableReason: executable ? undefined : 'no_api_key',
          },
          models: Object.entries(models).map(([modelId, mv]) => {
            const entryEnabled = (mv as { enabled?: unknown } | null)?.enabled;
            return {
              modelId,
              enabled: typeof entryEnabled === 'boolean' ? entryEnabled : true,
              config: mv && typeof mv === 'object' ? mv : {},
            };
          }),
        };
      });
      return {
        revision,
        providerTemplates: [],
        providerOrder: Object.keys(providersCfg),
        providers,
      };
    } catch (e) {
      const msg = redactSecrets((e as Error).message ?? '');
      throw new Error(msg);
    }
  }

  /** 取原始 provider 条目，不存在抛错（redact 出口）。 */
  function requireProvider(raw: ReturnType<ProviderWriteStore['readRaw']>, providerId: string): StoredProviderConfig {
    const entry = raw.providers?.[providerId];
    if (entry === undefined) {
      throw new Error(`provider 不存在: ${redactSecrets(providerId)}`);
    }
    return entry as StoredProviderConfig;
  }

  function writeRevision(raw: Record<string, unknown>): void {
    const prev = typeof raw['_h2Revision'] === 'number' ? (raw['_h2Revision'] as number) : 1;
    raw['_h2Revision'] = prev + 1;
  }

  const impl = {
    async getView(): Promise<unknown> {
      return buildView();
    },
    async refresh(): Promise<unknown> {
      return buildView();
    },
    // ── ZS4-T4 写路径（十投） ──
    async createPersonalProvider(input?: {
      templateId?: string;
      providerName?: string;
      initialConfig?: StoredProviderConfig;
    }): Promise<unknown> {
      const raw = store.readRaw();
      const taken = new Set(Object.keys(raw.providers ?? {}));
      const providerId = ProviderWriteStore.newProviderId(taken);
      const config: StoredProviderConfig = {
        protocol: 'openai',
        baseUrl: '',
        models: {},
        ...(input?.initialConfig ?? {}),
      };
      // 密钥经 absorbSecrets 摘出（就地删除 config 上的密钥键，写入 auth 0600）
      store.absorbSecrets(providerId, config);
      config.enabled = true;
      raw.providers = { ...raw.providers, [providerId]: config };
      writeRevision(raw);
      store.writeRaw(raw);
      const view = afterMutation();
      return { providerId, view };
    },
    async savePersonalProviderOverlay(providerId: string, config: StoredProviderConfig): Promise<unknown> {
      const raw = store.readRaw();
      const existing = requireProvider(raw, providerId);
      ProviderWriteStore.validateProviderConfig(providerId, config);
      // absorbSecrets 就地剥密钥：非空值写 auth 0600，密钥键绝不落 config
      store.absorbSecrets(providerId, config);
      const enabledValue = config.enabled ?? existing.enabled;
      config.enabled = typeof enabledValue === 'boolean' ? enabledValue : true;
      raw.providers = { ...raw.providers, [providerId]: config };
      writeRevision(raw);
      store.writeRaw(raw);
      return afterMutation();
    },
    async deletePersonalProvider(providerId: string): Promise<unknown> {
      const raw = store.readRaw();
      requireProvider(raw, providerId);
      const { [providerId]: _removed, ...rest } = raw.providers ?? {};
      raw.providers = rest;
      writeRevision(raw);
      store.writeRaw(raw);
      // 密钥不隐式删除（语义偏差登记：ZCode 删 provider 是否清凭据未见上游实现）
      return buildView();
    },
    async reorderPersonalProviders(providerIds: readonly string[]): Promise<unknown> {
      const raw = store.readRaw();
      raw.providers = reorderRecord(raw.providers ?? {}, [...providerIds]);
      writeRevision(raw);
      store.writeRaw(raw);
      return afterMutation();
    },
    async reorderPersonalModels(providerId: string, modelIds: readonly string[]): Promise<unknown> {
      const raw = store.readRaw();
      const entry = requireProvider(raw, providerId);
      entry.models = reorderRecord((entry.models ?? {}) as Record<string, unknown>, [...modelIds]);
      writeRevision(raw);
      store.writeRaw(raw);
      return afterMutation();
    },
    async addPersonalModel(providerId: string, modelId: string, config?: Record<string, unknown>): Promise<unknown> {
      const raw = store.readRaw();
      const entry = requireProvider(raw, providerId);
      ProviderWriteStore.validateModelId(modelId);
      const models = (entry.models ?? {}) as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(models, modelId)) {
        throw new Error(`模型已存在: ${redactSecrets(modelId)}`);
      }
      models[modelId] = { enabled: true, ...(config ?? {}) };
      entry.models = models;
      writeRevision(raw);
      store.writeRaw(raw);
      return afterMutation();
    },
    async renamePersonalModel(providerId: string, currentModelId: string, nextModelId: string): Promise<unknown> {
      const raw = store.readRaw();
      const entry = requireProvider(raw, providerId);
      ProviderWriteStore.validateModelId(nextModelId);
      const models = (entry.models ?? {}) as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(models, currentModelId)) {
        throw new Error(`模型不存在: ${redactSecrets(currentModelId)}`);
      }
      if (currentModelId !== nextModelId && Object.prototype.hasOwnProperty.call(models, nextModelId)) {
        throw new Error(`模型已存在: ${redactSecrets(nextModelId)}`);
      }
      entry.models = replaceKeyPreserveOrder(models, currentModelId, nextModelId, models[currentModelId]);
      writeRevision(raw);
      store.writeRaw(raw);
      return afterMutation();
    },
    async deletePersonalModel(providerId: string, modelId: string): Promise<unknown> {
      const raw = store.readRaw();
      const entry = requireProvider(raw, providerId);
      const models = (entry.models ?? {}) as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(models, modelId)) {
        throw new Error(`模型不存在: ${redactSecrets(modelId)}`);
      }
      const { [modelId]: _removed, ...rest } = models;
      entry.models = rest;
      writeRevision(raw);
      store.writeRaw(raw);
      return afterMutation();
    },
    async savePersonalModelDraft(input: {
      providerId: string;
      originalModelId: string;
      nextModelId: string;
      personalConfig?: Record<string, unknown>;
      basedOnRevision?: number;
    }): Promise<unknown> {
      const raw = store.readRaw();
      const entry = requireProvider(raw, input.providerId);
      ProviderWriteStore.validateModelId(input.nextModelId);
      const currentRevision = typeof raw['_h2Revision'] === 'number' ? (raw['_h2Revision'] as number) : 1;
      if (typeof input.basedOnRevision === 'number' && input.basedOnRevision !== currentRevision) {
        throw new Error(`revision 冲突: 期望 ${input.basedOnRevision}，当前 ${currentRevision}`);
      }
      const models = (entry.models ?? {}) as Record<string, unknown>;
      const original = models[input.originalModelId];
      if (original === undefined) {
        throw new Error(`模型不存在: ${redactSecrets(input.originalModelId)}`);
      }
      if (input.originalModelId !== input.nextModelId && models[input.nextModelId] !== undefined) {
        throw new Error(`模型已存在: ${redactSecrets(input.nextModelId)}`);
      }
      const merged = {
        ...(original as object),
        ...(input.personalConfig ?? {}),
      } as Record<string, unknown>;
      // 草稿里可能带回密钥字段——绝不落 config
      for (const key of Object.keys(merged)) {
        if (/api[_-]?key/i.test(key)) delete merged[key];
      }
      entry.models = replaceKeyPreserveOrder(models, input.originalModelId, input.nextModelId, merged);
      writeRevision(raw);
      store.writeRaw(raw);
      return afterMutation();
    },
    async setPersonalModelEnabled(providerId: string, modelId: string, enabled: boolean): Promise<unknown> {
      const raw = store.readRaw();
      const entry = requireProvider(raw, providerId);
      const models = (entry.models ?? {}) as Record<string, unknown>;
      const mv = models[modelId];
      if (mv === undefined) {
        throw new Error(`模型不存在: ${redactSecrets(modelId)}`);
      }
      models[modelId] = { ...(mv as object), enabled };
      entry.models = models;
      writeRevision(raw);
      store.writeRaw(raw);
      return afterMutation();
    },
    async testModelConnectivity(params: { providerId: string; modelId: string }): Promise<unknown> {
      try {
        const loaded = loadConfig({ root: process.cwd(), home });
        const cfg = loaded.config;
        if (!cfg) {
          return { success: false, error: { code: 'provider-unavailable', message: '配置文件缺失或损坏' } };
        }
        const pcfg = cfg.providers?.[params.providerId];
        if (!pcfg) {
          return {
            success: false,
            error: { code: 'provider-unavailable', message: `provider 不存在: ${params.providerId}` },
          };
        }
        if (pcfg.models && !(params.modelId in pcfg.models)) {
          return { success: false, error: { code: 'model-unavailable', message: `模型未声明: ${params.modelId}` } };
        }
        // 无密钥（auth 无该渠道且 envKey 未设）→ 按 ZCode 口径早退，不发请求
        const envKey = typeof pcfg.envKey === 'string' ? pcfg.envKey : undefined;
        const hasUsableKey = store.hasKey(params.providerId) || (envKey !== undefined ? !!process.env[envKey] : false);
        if (!hasUsableKey) {
          return {
            success: false,
            error: { code: 'provider-unavailable', message: `渠道 "${params.providerId}" 未配置 API key` },
          };
        }
        // 用一次性 role 走 core factory 造 provider 发最小请求（roles 不落盘，仅内存视图）
        const { createProvider: createProviderAny } = await import('./core-bridge.js');
        const viewConfig = {
          ...cfg,
          roles: {
            ...(cfg.roles ?? {}),
            __probe: { channel: params.providerId, model: params.modelId },
          },
        };
        const provider = createProviderAny(viewConfig, '__probe', { authPath: store.authPath });
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 15_000);
        let sawText = false;
        try {
          const stream = provider.streamChat({ messages: [{ role: 'user', content: 'ping' }] }, { signal: ac.signal });
          for await (const chunk of stream) {
            if (chunk.type === 'text-delta' && chunk.text.length > 0) {
              sawText = true;
              break;
            }
            if (chunk.type === 'done') break;
          }
        } finally {
          clearTimeout(timer);
          ac.abort();
        }
        return sawText
          ? { success: true }
          : { success: false, error: { code: 'empty-response', message: '模型无文本响应（可能仅思考或上游截断）' } };
      } catch (e) {
        const message = redactSecrets((e as Error)?.message ?? String(e)).slice(0, 400);
        return { success: false, error: { code: 'request-failed', message } };
      }
    },
    // 契约是静态事件（Event<ProviderSettingsView>）：直接暴露 Emitter 的注册函数
    onDidChange: changeEmitter.event,
  };
  return createStubService<IProviderSettingsService>({
    channelName: 'provider-settings',
    classification: 'A',
    impl: impl as Record<string, unknown>,
  });
}
