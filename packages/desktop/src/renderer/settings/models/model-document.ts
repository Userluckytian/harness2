// 模型配置页的纯逻辑（D-50/D-52/D-53/D-59 的状态与展示映射）+ 窗口 API 取用。
// 组件只调这些纯函数与 window.harness2，不做文件系统/密钥想象（渲染进程零 Node）。
import type {
  CredentialStatusShape,
  ModelsDocumentShape,
  ModelsModelRowShape,
  ModelsProviderInputShape,
  ModelsProviderLayerShape,
  ModelsProviderRowShape,
  ModelsSettingsApi,
} from '../../../shared/protocol.js';

/** D-59 首运行声明版本（版本升级会让声明确认重新出现） */
export const MODELS_DECLARATION_VERSION = 1;

/** 取模型配置通道面（缺失 = 该外壳未装配，如实降级不摆假入口） */
export function getModelsApi(): Partial<ModelsSettingsApi> {
  const w = window as unknown as { harness2?: Partial<ModelsSettingsApi> };
  return w.harness2 ?? {};
}

export function modelsApiReady(api: Partial<ModelsSettingsApi>): api is ModelsSettingsApi {
  return (
    typeof api.settingsGetModels === 'function' &&
    typeof api.settingsUpdateModels === 'function' &&
    typeof api.settingsDeleteProvider === 'function' &&
    typeof api.settingsWriteChannelKey === 'function' &&
    typeof api.settingsDiscoverModels === 'function' &&
    typeof api.settingsAckModelsDeclaration === 'function' &&
    typeof api.settingsGetCredentialStatus === 'function'
  );
}

/** 行 → 表单输入（Provider ID 只读回带；models 拷贝避免共享引用） */
export function rowToInput(row: ModelsProviderRowShape): ModelsProviderInputShape {
  return {
    id: row.id,
    displayName: row.displayName,
    protocol: row.protocol,
    baseUrl: row.baseUrl,
    ...(row.apiKeyRef !== undefined ? { apiKeyRef: row.apiKeyRef } : {}),
    models: row.models.map((m) => ({ ...m })),
  };
}

/** 新增提供方草稿（Provider ID 可编辑；无端点/模型） */
export function newProviderDraft(): ModelsProviderInputShape {
  return { id: '', displayName: '', protocol: 'openai', baseUrl: '', models: [] };
}

export function emptyModelRow(): ModelsModelRowShape {
  return { id: '' };
}

/** D-50：未配置的整节提供方（无确认凭据且尚无模型）——首次直接渲染为展开卡 */
export function isUnconfiguredProvider(row: ModelsProviderRowShape): boolean {
  return row.credential.state !== 'confirmed' && row.models.length === 0;
}

/** 首次渲染的自动展开判定（seen = 本次会话已渲染过的 id，避免用户收起后被重新展开） */
export function shouldAutoExpand(row: ModelsProviderRowShape, seen: ReadonlySet<string>): boolean {
  return !seen.has(row.id) && isUnconfiguredProvider(row);
}

/** D-52：状态点文案与色调（unknown = 不上色；不猜） */
export function credentialPresentation(credential: CredentialStatusShape): {
  tone: 'ok' | 'bad' | 'unknown';
  text: string;
  detail: string;
} {
  if (credential.state === 'confirmed') {
    const via = credential.source === 'env' ? '环境变量' : 'auth.json';
    const ref = credential.reference !== undefined ? `（引用 ${credential.reference}）` : '';
    return { tone: 'ok', text: '凭据已配置', detail: `已确认：${via} 中可解析到该渠道密钥${ref}` };
  }
  if (credential.state === 'missing') {
    const ref = credential.reference ?? '(未命名引用)';
    return {
      tone: 'bad',
      text: '凭据缺失',
      detail: `已确认具名引用 ${ref} 缺失：auth.json 无该渠道密钥且环境变量未设置`,
    };
  }
  return {
    tone: 'unknown',
    text: '凭据未确认',
    detail: '既无配置内具名引用、也无 auth.json 渠道条目的确认信息——不猜测（保存密钥后即为已配置）',
  };
}

export function layerLabel(layers: readonly ModelsProviderLayerShape[]): string {
  const parts: string[] = [];
  if (layers.includes('user')) parts.push('用户层');
  if (layers.includes('project')) parts.push('项目层');
  return parts.length > 0 ? parts.join(' + ') : '未知层';
}

/** 便于 UI 提示：派生引用名（仅展示用途；真实派生在主进程） */
export function deriveApiKeyRef(route: string): string {
  const stem = route
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (stem.length === 0) return 'ROUTE_API_KEY';
  return `${/^[0-9]/.test(stem) ? `_${stem}` : stem}_API_KEY`;
}

/** 需要凭据的提供方（首运行条件式凭据步据此判定是否为条件真） */
export function providersNeedingCredential(rows: readonly ModelsProviderRowShape[]): ModelsProviderRowShape[] {
  return rows.filter((r) => r.credential.state !== 'confirmed');
}

/** D-59 首运行第一步：已确认当前版本 → none；否则必须先过版本化声明 */
export function firstRunStep(ackVersion: number): 'none' | 'declaration' {
  return ackVersion >= MODELS_DECLARATION_VERSION ? 'none' : 'declaration';
}

export function documentProviderIds(doc: ModelsDocumentShape, extra: readonly string[] = []): string[] {
  const ids = doc.providers.map((p) => p.id);
  for (const id of extra) if (!ids.includes(id)) ids.push(id);
  return ids;
}
