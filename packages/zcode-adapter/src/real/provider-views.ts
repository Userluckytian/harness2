import { DEFAULT_CONTEXT_WINDOW, loadConfig, readAuthFile, redactSecrets, resolveHarness2Home } from './core-bridge.js';
import {
  ProviderWriteStore,
  reorderRecord,
  replaceKeyPreserveOrder,
  toCoreProviderConfig,
  toUiProviderConfig,
} from './provider-writes.js';
import type { StoredProviderConfig } from './provider-writes.js';
import { mergePulledModels, pullModelIds } from './model-pull.js';
import {
  catalogEntryToCoreModel,
  catalogEntryToUiBits,
  enrichModelsFromCatalog,
  extractUiModelBits,
  lookupCatalogEntry,
  lookupCatalogEntryLoose,
  mergeUiModelConfigs,
  peekCatalog,
  synthesizeUiModelConfig,
  toStoredModelConfig,
  type UiModelBits,
} from './model-catalog.js';
import { Emitter } from '@zcode/rpc';
import type { IModelSelectionService, IProviderSettingsService } from '@zcode/services';
import { createStubService } from '../stub-factory.js';

export interface ProviderViewsOptions {
  dataRoot?: string;
  home?: string;
  /** 测试缝：模型列表拉取用的 fetch（单测注入本地假响应；默认真实 fetch）。 */
  fetchImpl?: typeof fetch;
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

  /**
   * 视图 revision 时钟（ZS4-T6 e2e 实证）：UI 快照守卫按 revision 单调性去重
   * （providerSettingsSnapshot.ts:45-46：相等或更小 = 丢弃）。草稿不落盘、不写文件
   * revision，若无内存时钟则 create 草稿的视图被 UI 吞掉（导航不出现新项）。
   * 时钟初值=文件 `_h2Revision`，每次 afterMutation 递增；draft 乐观并发判据也用它。
   */
  let revisionClock = (() => {
    try {
      const v = store.readRaw()['_h2Revision'];
      return typeof v === 'number' ? v : 1;
    } catch {
      return 1;
    }
  })();

  /** 写路径统一出口：递增 revision 时钟 + 重建视图 + 广播 onDidChange（UI commit 消费）。 */
  function afterMutation(): unknown {
    revisionClock += 1;
    const view = buildView();
    changeEmitter.fire(view);
    return view;
  }

  /**
   * 内存草稿（ZS4-T6 e2e 实证设计）：UI「添加供应商」是先建后填的两步流，
   * 建时 baseUrl 为空。core parseConfig 对任一非法 provider 会**整份 config 归 null**
   * （schema.ts:1348）——若空配置落盘，用户的真实主渠道（roles.main）会连带全灭，
   * 整个应用炸回「No model available」。因此 create 只分配 id 进 `pendingDrafts`（内存），
   * 视图合并渲染；首次**合法**保存才落盘。进程重启草稿消失（可接受：未完成的表单本就无痕）。
   */
  const pendingDrafts = new Map<string, StoredProviderConfig>();

  /**
   * 视图从**原始 config.json** + 内存草稿投影（写路径同源，避免归一化丢字段）。
   * 形状：`ProviderSettingsProviderView`（facades.ts:149-163）；`enabled` 与模型 `enabled`
   * 存为条目上的布尔扩展键（core schema 对未知键只告警——已核实 PROVIDER_KNOWN_KEYS 外不报错）。
   */
  function buildView(): unknown {
    try {
      const raw = store.readRaw();
      const providersCfg = { ...raw.providers } as Record<string, StoredProviderConfig>;
      for (const [id, draft] of pendingDrafts) providersCfg[id] = draft;
      const authResult = readAuthFile(store.authPath);
      const auth = authResult.auth;
      let revision = 1;
      if (typeof raw.revision === 'number') revision = raw.revision;
      else if (typeof raw['_h2Revision'] === 'number') revision = raw['_h2Revision'] as number;
      // 视图单调性必须跟内存时钟一致（草稿不落盘也推 revision，UI 快照守卫才不吞更新）
      revision = Math.max(revision, revisionClock);

      const providers = Object.entries(providersCfg).map(([channel, entry]) => {
        const pcfg = (entry ?? {}) as StoredProviderConfig;
        const models = (pcfg.models ?? {}) as Record<string, unknown>;
        const keyExists = !!auth?.channels?.[channel]?.apiKey;
        const envKey = pcfg.envKey;
        const envExists = typeof envKey === 'string' && envKey.length > 0 ? !!process.env[envKey] : false;
        const executable = keyExists || envExists;
        const enabledValue = pcfg.enabled;
        const enabled = typeof enabledValue === 'boolean' ? enabledValue : true;
        // 出站翻译：core 扁平条目 → ZCode UI 嵌套形（表单绑定 config.api.baseUrl /
        // config.access；导航硬判据 group==='standard-personal' 由 toUiProviderConfig 恒定注入）。
        // e2e 实证（2026-10-22）：不翻译则表单打开即空值、导航不显示（T4 原样透传扁平形=契约缺口）。
        const effectiveConfig = toUiProviderConfig(pcfg);
        return {
          providerId: channel,
          providerName:
            typeof pcfg.providerName === 'string' && pcfg.providerName.trim() !== '' ? pcfg.providerName : channel,
          enabled,
          executable,
          issues: executable ? [] : ['no_api_key'],
          effectiveConfig,
          // UI 保存回传 personalConfig（providerPersonalSave.ts:11-18 只发 personal 层），
          // harness2 的整个条目就是用户自撰层 → 与 effective 同值镜像。
          personalConfig: effectiveConfig,
          accountState: {
            availability: executable ? 'available' : 'unavailable',
            unavailableReason: executable ? undefined : 'no_api_key',
          },
          models: Object.entries(models).map(([modelId, mv]) => {
            const entryEnabled = (mv as { enabled?: unknown } | null)?.enabled;
            const mEnabled = typeof entryEnabled === 'boolean' ? entryEnabled : true;
            // ProviderSettingsModelCandidateView（facades.ts:107-120）契约形状。
            // ZS4.5e：出站合成**全形状**（徽章判据要求 inputFormat 五模态/outputFormat
            // 恒非空；缺失=每行红字「模型配置不完整」）；用户在对话框编辑的 UI 专属位
            // （模态勾选/映射表达式）从 `_h2Ui` 命名空间回放 → 保存后内容不再丢。
            const uiBits = (raw['_h2Ui'] as Record<string, Record<string, UiModelBits>> | undefined)?.[channel]?.[
              modelId
            ];
            return {
              kind: 'candidate',
              modelId,
              builtin: false,
              effectiveBuiltinConfig: {},
              effectiveConfig: synthesizeUiModelConfig(
                mv as Record<string, unknown>,
                uiBits ?? null,
                DEFAULT_CONTEXT_WINDOW,
              ),
              enabled: mEnabled,
              executable,
              selectable: executable && mEnabled,
              issues: [],
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

  /** 取 provider 条目（磁盘或内存草稿），不存在抛错（redact 出口）。 */
  function requireProvider(raw: ReturnType<ProviderWriteStore['readRaw']>, providerId: string): StoredProviderConfig {
    const entry = raw.providers?.[providerId] ?? pendingDrafts.get(providerId);
    if (entry === undefined) {
      throw new Error(`provider 不存在: ${redactSecrets(providerId)}`);
    }
    return entry as StoredProviderConfig;
  }

  function writeRevision(raw: Record<string, unknown>): void {
    const prev = typeof raw['_h2Revision'] === 'number' ? (raw['_h2Revision'] as number) : 1;
    raw['_h2Revision'] = prev + 1;
  }

  /**
   * `_h2Ui` 命名空间写缝（ZS4.5e）：UI 专属模型位（模态勾选/映射表达式——core
   * ModelEntry 表达不了、又必须跨保存回放否则「编辑内容丢失」）持久化在 config
   * 顶层，providers.*.models.* 条目本体保持纯 core 形状（先例=_h2Revision；
   * core 加载只报一条顶层「未知字段已忽略」告警）。null=删该位。
   */
  function setUiModelBits(
    raw: Record<string, unknown>,
    providerId: string,
    modelId: string,
    bits: UiModelBits | null,
    merge = false,
  ): void {
    const all = (raw['_h2Ui'] ?? {}) as Record<string, Record<string, UiModelBits>>;
    const per = (all[providerId] ?? {}) as Record<string, UiModelBits>;
    if (bits === null) delete per[modelId];
    else if (merge) {
      const prev = per[modelId] ?? {};
      per[modelId] = {
        ...prev,
        ...bits,
        ...(bits.inputFormat || prev.inputFormat
          ? { inputFormat: { ...(prev.inputFormat ?? {}), ...(bits.inputFormat ?? {}) } }
          : {}),
        ...(bits.outputFormat || prev.outputFormat
          ? { outputFormat: { ...(prev.outputFormat ?? {}), ...(bits.outputFormat ?? {}) } }
          : {}),
      };
    } else per[modelId] = bits;
    if (Object.keys(per).length > 0) all[providerId] = per;
    else delete all[providerId];
    if (Object.keys(all).length > 0) raw['_h2Ui'] = all;
    else delete raw['_h2Ui'];
  }

  /**
   * ZS4.5/4.5b：provider 合法保存后的后台模型拉取+目录富化（fire-and-forget，绝不 throw）。
   * ① mergePulledModels 拿渠道 /models 新增 ID（内存 entry 已含）；
   * ② 富化候选=新增 ID ∪ 既有「空壳」条目（无 contextWindow/maxOutputTokens/reasoning——
   *    早期仅 ID 拉取的产物；重保存时 added=0 也要补，故候选判断独立于 added）；
   * ③ opencode 公开目录命中则填 core 扁平键（只补缺失键，用户手工值不覆盖）；
   * ④ 有任何实际变化才落盘 + afterMutation 广播（UI 经 onDidChange 吸收）。
   * 目录失败/无命中 → 新增 ID 落空条目（退化为 ZS4.5 初版），静默。
   */
  async function pullModelsIntoProvider(providerId: string): Promise<void> {
    try {
      const raw = store.readRaw();
      const entry = (raw.providers?.[providerId] ?? undefined) as StoredProviderConfig | undefined;
      if (!entry || !ProviderWriteStore.isCoreProviderConfigValid(entry)) return;
      const added = await mergePulledModels(
        entry,
        {
          protocol: typeof entry.protocol === 'string' ? entry.protocol : undefined,
          baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : undefined,
          apiKey: store.apiKeyFor(providerId),
        },
        opts.fetchImpl ?? fetch,
      );
      const allModels = { ...(entry.models ?? {}) } as Record<string, unknown>;
      const candidates: string[] = [];
      for (const id of added) candidates.push(id);
      for (const [id, mv] of Object.entries(allModels)) {
        if (candidates.includes(id)) continue;
        const flat = (mv ?? {}) as Record<string, unknown>;
        if (flat.contextWindow === undefined && flat.maxOutputTokens === undefined && flat.reasoning === undefined)
          candidates.push(id); // 空壳 → 补富化机会（仅 enabled/未知键也算空壳）
      }
      if (candidates.length === 0) return;
      const enriched = await enrichModelsFromCatalog(candidates, opts.fetchImpl ?? fetch);
      const raw2 = store.readRaw();
      const target = raw2.providers?.[providerId] as StoredProviderConfig | undefined;
      if (!target) return; // 已被删除——不复活
      const models2 = { ...(target.models ?? {}) } as Record<string, unknown>;
      let dirty = false;
      for (const id of added) {
        if (!Object.prototype.hasOwnProperty.call(models2, id)) {
          models2[id] = {};
          dirty = true;
        }
      }
      for (const [id, add] of enriched) {
        const existing = (models2[id] ?? {}) as Record<string, unknown>;
        let changed = false;
        for (const [k, v] of Object.entries(add)) {
          if (existing[k] === undefined) {
            existing[k] = v;
            changed = true;
          }
        }
        if (changed) {
          models2[id] = existing;
          dirty = true;
        }
        // ZS4.5e：精确命中同时把目录模态/能力 UI 位写 `_h2Ui`（徽章形状持久化；
        // 用户编辑过的位优先，不覆盖 reasoningMap/已存在的 inputFormat 键）
        const cat = peekCatalog();
        const hit = cat ? lookupCatalogEntry(cat, id) : null;
        const bits = hit ? catalogEntryToUiBits(hit) : null;
        if (bits) {
          setUiModelBits(raw2, providerId, id, bits, true);
          dirty = true;
        }
      }
      if (!dirty) return;
      target.models = models2;
      writeRevision(raw2);
      store.writeRaw(raw2);
      afterMutation();
    } catch {
      // best-effort 兜底：任何异常都不能冒到保存路径外（fire-and-forget 的 unhandled rejection）
    }
  }

  const impl = {
    async getView(): Promise<unknown> {
      return buildView();
    },
    async refresh(): Promise<unknown> {
      return buildView();
    },
    /**
     * 模型配置解析（ZS4-T6 缺口；ZS4.5b/c/d/e 基线演进）。添加/编辑模型对话框打开
     * 即调用（ProviderCardSections.tsx:401）。inherited 基线 = `synthesizeUiModelConfig`
     * （徽章完整判定形），数据源按优先级合并：
     * ① 磁盘扁平条目（自动拉取富化过的真实数据）；
     * ② 空壳/无记录 → opencode 目录实时兜底（精确>尾段松配；peek 非阻塞不卡对话框），
     *    含模态/工具能力 UI 位；
     * ③ 用户在对话框显式编辑过的 UI 位（`_h2Ui` 回放，最高优先）；
     * ④ 缺容量 → DEFAULT_CONTEXT_WINDOW（core 运行时真实兜底，仅返回值不写盘）；
     * ⑤ 无真实推理档位 → ZCode「无推理」惯例 disabled/{}（UI 保存硬校验要求 ≥1 档）。
     * effective=inherited ⊕ personalConfig（用户覆盖优先，UI 草稿预览语义）。
     */
    async resolveModelConfig(input: {
      providerId: string;
      modelId: string;
      originalModelId?: string;
      personalConfig?: Record<string, unknown>;
    }): Promise<unknown> {
      const raw = store.readRaw();
      const entry = requireProvider(raw, input.providerId);
      const models = (entry.models ?? {}) as Record<string, unknown>;
      const ownFlat =
        models[input.modelId] && typeof models[input.modelId] === 'object'
          ? (models[input.modelId] as Record<string, unknown>)
          : null;
      // 磁盘空壳/无记录 → 目录实时兜底（精确 > 尾段松配；peek 非阻塞——保存富化路径
      // 已把目录入缓存；冷缓存走默认合成形，不拿 6MB 下载卡对话框）
      let catalogCore: Record<string, unknown> | null = null;
      let catalogBits: UiModelBits | null = null;
      const shellEmpty =
        !ownFlat ||
        (ownFlat.contextWindow === undefined &&
          ownFlat.maxOutputTokens === undefined &&
          ownFlat.reasoning === undefined);
      if (shellEmpty) {
        const catalog = peekCatalog();
        if (catalog) {
          const hit = lookupCatalogEntry(catalog, input.modelId) ?? lookupCatalogEntryLoose(catalog, input.modelId);
          if (hit) {
            catalogCore = catalogEntryToCoreModel(hit);
            catalogBits = catalogEntryToUiBits(hit);
          }
        }
      }
      const effFlat = { ...(catalogCore ?? {}), ...(ownFlat ?? {}) };
      const savedBits = (raw['_h2Ui'] as Record<string, Record<string, UiModelBits>> | undefined)?.[input.providerId]?.[
        input.modelId
      ];
      const uiBits: UiModelBits = { ...(catalogBits ?? {}), ...(savedBits ?? {}) };
      let inherited: Record<string, unknown> = synthesizeUiModelConfig(effFlat, uiBits, DEFAULT_CONTEXT_WINDOW);
      // ZS4.5d：档位基线恒非空（UI 提交校验 ProviderModelMetadata.ts:148-167 无条件
      // 要求 ≥1 档 + 可编译 map）。无真实推理数据时按 ZCode「无推理模型」惯例
      // { values:["disabled"], map:"{}" }（其 facades.test.ts:51 同源，非发明）；
      // 智能模式下与草稿投影相等 → 提交不落个人覆盖，磁盘保持干净。
      const specs = inherited.optionSpecs as Record<string, unknown> | undefined;
      if (specs?.reasoningLevel === undefined) {
        inherited = {
          ...inherited,
          optionSpecs: { ...(specs ?? {}), reasoningLevel: { values: ['disabled'], map: '{}' } },
        };
      }
      const fromPersonal = input.personalConfig && typeof input.personalConfig === 'object';
      const effective = fromPersonal
        ? mergeUiModelConfigs(inherited, input.personalConfig as Record<string, unknown>)
        : inherited;
      return Object.freeze({
        inheritedConfig: Object.freeze({ ...inherited }),
        effectiveConfig: Object.freeze({ ...effective }),
        issues: Object.freeze([]),
      });
    },
    // ── ZS4-T4 写路径（十投） ──
    // 形状契约（ZS4-T6 e2e 实证补）：UI 入参是 ZCode 嵌套形 ProviderConfigObject
    // （config.api.baseUrl / config.access.apiKey / group…，providerPersonalSave.ts:6-29），
    // 一律先 toCoreProviderConfig 翻译再处理；磁盘恒 core 扁平形。
    async createPersonalProvider(input?: {
      templateId?: string;
      providerName?: string;
      initialConfig?: StoredProviderConfig;
    }): Promise<unknown> {
      const raw = store.readRaw();
      const taken = new Set([...Object.keys(raw.providers ?? {}), ...pendingDrafts.keys()]);
      const providerId = ProviderWriteStore.newProviderId(taken);
      const config: StoredProviderConfig = {
        protocol: 'openai',
        baseUrl: '',
        models: {},
        ...(input?.initialConfig ? toCoreProviderConfig(input.initialConfig) : {}),
      };
      const name = typeof input?.providerName === 'string' ? input.providerName.trim() : '';
      if (name !== '') config.providerName = name;
      store.absorbSecrets(providerId, config); // 就地剥密钥 → auth（create 携带密钥的模板流兼容）
      config.enabled = true;
      if (ProviderWriteStore.isCoreProviderConfigValid(config)) {
        raw.providers = { ...raw.providers, [providerId]: config };
        writeRevision(raw);
        store.writeRaw(raw);
      } else {
        // 空 baseUrl（UI 两步建卡的第一步）绝不落盘：core 整份 config 会归 null 炸全盘
        pendingDrafts.set(providerId, config);
      }
      const view = afterMutation();
      return { providerId, view };
    },
    async savePersonalProviderOverlay(
      providerId: string,
      config: StoredProviderConfig,
      metadata?: { providerName?: string; enabled?: boolean },
    ): Promise<unknown> {
      const raw = store.readRaw();
      const existing = requireProvider(raw, providerId);
      const translated = toCoreProviderConfig(config);
      // 显式非法 protocol（非 openai/anthropic 的实际值）= 契约违规 → throw；
      // 空/缺 baseUrl = 编辑中暂存（ZCode personalProviderApiDataSchema 同义）→ 草稿不落盘。
      if (
        translated.protocol !== undefined &&
        translated.protocol !== 'openai' &&
        translated.protocol !== 'anthropic'
      ) {
        throw new Error(`providers.${redactSecrets(providerId)}.protocol 必须是 openai | anthropic`);
      }
      const merged = { ...existing, ...translated } as StoredProviderConfig;
      // absorbSecrets 就地剥密钥：非空值写 auth 0600，密钥键绝不落 config/draft
      store.absorbSecrets(providerId, merged);
      const enabledValue = metadata?.enabled ?? merged.enabled ?? existing.enabled;
      merged.enabled = typeof enabledValue === 'boolean' ? enabledValue : true;
      if (typeof metadata?.providerName === 'string' && metadata.providerName.trim() !== '') {
        merged.providerName = metadata.providerName.trim();
      }
      if (ProviderWriteStore.isCoreProviderConfigValid(merged)) {
        pendingDrafts.delete(providerId);
        raw.providers = { ...raw.providers, [providerId]: merged };
        writeRevision(raw);
        store.writeRaw(raw);
        // ZS4.5（用户批准）：合法保存后台 best-effort 拉取渠道模型列表回填，
        // 成功则再落盘 + afterMutation 二次广播（UI onDidChange 吸收，模型行自动出现）。
        void pullModelsIntoProvider(providerId);
      } else {
        // 编辑中的非法草稿（空 baseUrl 等）留在内存：磁盘永不含半配置（防 core 整份归 null）
        pendingDrafts.set(providerId, merged);
      }
      return afterMutation();
    },
    async deletePersonalProvider(providerId: string): Promise<unknown> {
      const raw = store.readRaw();
      requireProvider(raw, providerId); // 磁盘或草稿任一存在即可删
      pendingDrafts.delete(providerId);
      if (raw.providers?.[providerId] === undefined) return afterMutation(); // 纯草稿删除
      const { [providerId]: _removed, ...rest } = raw.providers ?? {};
      raw.providers = rest;
      // UI 位分片一并回收（ZS4.5e）
      {
        const allUi = raw['_h2Ui'] as Record<string, unknown> | undefined;
        if (allUi && providerId in allUi) {
          const { [providerId]: _drop, ...restUi } = allUi;
          if (Object.keys(restUi).length > 0) raw['_h2Ui'] = restUi;
          else delete raw['_h2Ui'];
        }
      }
      writeRevision(raw);
      store.writeRaw(raw);
      // 密钥不隐式删除（语义偏差登记：ZCode 删 provider 是否清凭据未见上游实现）
      return afterMutation();
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
    /**
     * ZS4.5f（用户拍板的「获取模型」动作，渲染层按钮经 window-controller 转发）：
     * 显式拉取该渠道模型清单，**不落盘**——返回 {modelIds, existingIds} 给面板勾选。
     * 与保存路径的静默兜底相反，这里是显式动作：失败要如实 throw 给用户看。
     */
    async discoverModels(providerId: string): Promise<{ modelIds: string[]; existingIds: string[] }> {
      const raw = store.readRaw();
      const entry = requireProvider(raw, providerId);
      if (!ProviderWriteStore.isCoreProviderConfigValid(entry))
        throw new Error('请先填写有效的 Base URL 并保存，再获取模型');
      const ids = await pullModelIds(
        {
          protocol: typeof entry.protocol === 'string' ? entry.protocol : undefined,
          baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : undefined,
          apiKey: store.apiKeyFor(providerId),
        },
        opts.fetchImpl ?? fetch,
      );
      const existing = new Set(Object.keys((entry.models ?? {}) as Record<string, unknown>));
      return { modelIds: ids, existingIds: [...existing] };
    },
    /**
     * 勾选确认后落盘：只把选中的 ID 写入 models（core 扁平空条目 + 目录精确命中富化
     * + `_h2Ui` 模态位），再广播。未勾选的一律不入库（用户：100 多个模型只用 1-2 个）。
     */
    async addDiscoveredModels(providerId: string, modelIds: readonly string[]): Promise<unknown> {
      const raw = store.readRaw();
      const entry = requireProvider(raw, providerId);
      const picked = [...new Set(modelIds)];
      if (picked.length === 0) return afterMutation();
      for (const id of picked) ProviderWriteStore.validateModelId(id);
      const models = { ...(entry.models ?? {}) } as Record<string, unknown>;
      const toAdd = picked.filter((id) => !Object.prototype.hasOwnProperty.call(models, id));
      if (toAdd.length === 0) return afterMutation();
      const enriched = await enrichModelsFromCatalog(toAdd, opts.fetchImpl ?? fetch);
      for (const id of toAdd) {
        models[id] = { enabled: true, ...(enriched.get(id) ?? {}) };
        const cat = peekCatalog();
        const hit = cat ? lookupCatalogEntry(cat, id) : null;
        const bits = hit ? catalogEntryToUiBits(hit) : null;
        if (bits) setUiModelBits(raw, providerId, id, bits, true);
      }
      entry.models = models;
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
      // UI 添加对话框回传嵌套形（{properties,optionSpecs}）→ 磁盘恒 core 扁平形
      // （ZS4.5b：直存嵌套会污染 schema 未知键 + 破坏扁平读路径）；
      // core 表达不了的 UI 位（模态/映射表达式）进 `_h2Ui` 回放（ZS4.5e）
      models[modelId] = { enabled: true, ...toStoredModelConfig(config) };
      entry.models = models;
      setUiModelBits(raw, providerId, modelId, extractUiModelBits(config));
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
      // UI 位随键迁移（ZS4.5e）
      {
        const carry = ((raw['_h2Ui'] ?? {}) as Record<string, Record<string, UiModelBits>>)[providerId]?.[
          currentModelId
        ];
        if (carry) {
          setUiModelBits(raw, providerId, currentModelId, null);
          setUiModelBits(raw, providerId, nextModelId, carry);
        }
      }
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
      setUiModelBits(raw, providerId, modelId, null); // UI 位一并回收（ZS4.5e）
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
      // 乐观并发判据必须与视图 revision 同源（max(文件, 时钟)）：草稿 create 只拨时钟
      // 不落盘，若仍拿文件值比较，UI 刚收到的视图 revision 会被误判「冲突」。
      const fileRev = typeof raw['_h2Revision'] === 'number' ? (raw['_h2Revision'] as number) : 1;
      const currentRevision = Math.max(fileRev, revisionClock);
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
      // personalConfig 可能是 UI 嵌套形（properties/optionSpecs）→ 归一为 core 扁平形再合
      // （addPersonalModel 同源纪律；直合嵌套会破坏「磁盘恒扁平」不变量并触发 core 未知键告警）
      const merged = {
        ...(original as object),
        ...toStoredModelConfig(input.personalConfig),
      } as Record<string, unknown>;
      // 草稿里可能带回密钥字段——绝不落 config
      for (const key of Object.keys(merged)) {
        if (/api[_-]?key/i.test(key)) delete merged[key];
      }
      entry.models = replaceKeyPreserveOrder(models, input.originalModelId, input.nextModelId, merged);
      // UI 位随键迁移 + 增量合并（ZS4.5e：编辑保存后模态/映射不丢；UI 只回传显式
      // 覆盖项——null 位不得清掉携带值，故 merge=true 且仅在有位时调用）
      {
        const allUi = (raw['_h2Ui'] ?? {}) as Record<string, Record<string, UiModelBits>>;
        const carry = allUi[input.providerId]?.[input.originalModelId];
        if (input.originalModelId !== input.nextModelId && carry)
          setUiModelBits(raw, input.providerId, input.nextModelId, carry);
      }
      const newBits = extractUiModelBits(input.personalConfig);
      if (newBits) setUiModelBits(raw, input.providerId, input.nextModelId, newBits, true);
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
