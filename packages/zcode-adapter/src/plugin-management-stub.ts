/**
 * plugin-management-stub —— IPluginManagementService（B 类）设置页触达读方法的空态形状。
 *
 * ZS6-T0 审计首要违例（红线⑩双违，zs6-hide-audit.md #1）：hooks 设置页经
 * pluginManagementStore.loadInto 并发调 `listPlugins`+`getPluginsOverview`（ui/src/
 * store/pluginManagementStoreLoading.ts:237-242），原走 B 类默认=任何方法 async throw
 * `ZS1: not implemented (channel=plugin-management, …)`，store 把 error.message **直接
 * 渲染进 DOM**（运行态实读：「用户 · 本机钩子0ZS1: not implemented (channel=plugin-management, m…」，
 * zs6-audit-dump.json settings-section-nav-hooks）。设置页的插件管理读路径属「空态启动
 * 实证触达」类，按计划风险表预案（file-stubs.ts 同源先例：「B 类空态触达方法返回空态
 * 形状并登记」）处置。
 *
 * 形状全部对照 `@zcode/shared` zcode-protocol strict schema（3016-3022 / 3660-3675 /
 * 3085-3092 / 3569+ 行区实证）：
 * - listPlugins → `{plugins: [], diagnostics: []}`
 * - getPluginsOverview → 全数组空 + `capability: {supported: false, reason}`
 *   （false=如实：harness2 无插件市场/安装体系；UI 据此禁用安装面，不留可点必炸）
 * - getPluginReferenceCatalog → `{authority: 'workspace', plugins: []}`
 * - resolveSuggestedPluginReference → `{stableId 回显, status: 'unavailable', diagnostics: []}`
 *   （enum 中唯一非 actionable 态；superRefine 对 unavailable 不要求 install identity）
 *
 * 写/安装/市场方法（13 个显式 throws + 其余 B 默认 throw）保持 throw：点了必炸的入口
 * 由 capability.supported=false 与 T1 后续隐藏处置收口，读路径不再产生异常字面量。
 */
import type { IPluginManagementService } from '@zcode/services';
import { createStubService } from './stub-factory.js';

const pluginManagementImpl: Pick<
  IPluginManagementService,
  'listPlugins' | 'getPluginsOverview' | 'getPluginReferenceCatalog' | 'resolveSuggestedPluginReference'
> = {
  async listPlugins(): Promise<{ plugins: []; diagnostics: [] }> {
    return { plugins: [], diagnostics: [] };
  },
  async getPluginsOverview(): Promise<{
    marketplaces: [];
    availablePlugins: [];
    installedPlugins: [];
    restorableBuiltins: [];
    diagnostics: [];
    capability: { supported: false; reason: string };
  }> {
    return {
      marketplaces: [],
      availablePlugins: [],
      installedPlugins: [],
      restorableBuiltins: [],
      diagnostics: [],
      capability: { supported: false, reason: 'harness2 无插件市场体系（技能/命令/MCP 由本地目录管理）' },
    };
  },
  async getPluginReferenceCatalog(): Promise<{ authority: 'workspace'; plugins: [] }> {
    return { authority: 'workspace', plugins: [] };
  },
  async resolveSuggestedPluginReference(params: unknown): Promise<{
    stableId: string;
    status: 'unavailable';
    diagnostics: [];
  }> {
    const stableId = (params as { stableId?: string })?.stableId;
    return {
      stableId: typeof stableId === 'string' && stableId !== '' ? stableId : 'harness2-plugin-ref',
      status: 'unavailable',
      diagnostics: [],
    };
  },
};

/** B: 插件市场/安装体系不存在；设置页触达的 4 个读方法=空态形状（ZS6-T0 处置），写方法 throw */
export const pluginManagementServiceStub: IPluginManagementService = createStubService<IPluginManagementService>({
  channelName: 'plugin-management',
  classification: 'B',
  impl: pluginManagementImpl,
  throws: [
    'addPluginMarketplace',
    'removePluginMarketplace',
    'updatePluginMarketplace',
    'installPlugin',
    'uninstallPlugin',
    'updatePlugin',
    'restoreBuiltinPlugin',
    'configurePlugin',
    'resetPluginConfig',
    'setPluginEnabled',
    'validatePlugin',
    'describePlugin',
    'cancelPluginOperation',
  ],
});
