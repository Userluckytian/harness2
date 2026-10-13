// 设置 / 模型配置的跨壳形状（Z7：随设置页下沉 ui-shared）。
//
// 为什么单列一个文件（而不是塞进 shared/protocol.ts）：本文件的形状是**设置域的读/写契约**
// （config.json 脱敏视图、auth.json 掩码视图、模型配置文档、桌面偏好），既有桌面壳 IPC 也有
// web 壳的设置覆层消费——是「设置端口」的公共类型面，与 serve 线协议（WS/HTTP 帧）无关。
//
// 唯一事实源：本文件。桌面 `shared/protocol.ts` 按名字再导出（`export type *`），既有
// `from '../shared/protocol.js'` 的引用面不变；渲染端零 Node，不 import 任何核心模块。
//
// 红线（HANDOFF §7）：密钥只落 ~/.harness2/auth.json（channels.<route>.apiKey / gateways.<c>.appSecret）
// 或环境变量；config.json 只持有**具名引用**（providers.<id>.envKey = <ROUTE>_API_KEY），永不持有密钥值；
// 渲染端只写不回读明文——回读只有「已确认/已确认缺失/未确认」与具名引用名、以及 appId 掩码态。

// —— 外观 / 偏好 ——

export type SettingsTheme = 'system' | 'zai-light' | 'zai-dark';
export type SettingsNotifyDetails = 'minimal' | 'full';

/**
 * 代码查看器可选语法高亮主题 id（Z10-7 外观「代码设置卡」，对齐 refs-zcode.md:357 的 10 选项）。
 * id 与 shiki 内置主题名**一一对应**（`shiki/themes/<id>.mjs`），渲染端按 id 直取主题对象，
 * 不做二次命名映射（避免两处清单漂移）。浅/深各一支：浅色预览用 `codeThemeLight`，
 * 深色预览用 `codeThemeDark`。
 */
export type CodeThemeId =
  | 'github-light'
  | 'github-dark'
  | 'vitesse-light'
  | 'vitesse-dark'
  | 'min-light'
  | 'min-dark'
  | 'github-dark-high-contrast'
  | 'catppuccin-latte'
  | 'catppuccin-mocha'
  | 'one-dark-pro';

/** 模型声明的推理档位（core `reasoning`；values 按强度从低到高，每模型自声明，非全局枚举） */
export interface SettingsModelReasoningShape {
  values: string[];
  default?: string;
}

/** settings:getConfig 的 provider 条目（脱敏后的可用字段；与 CLI 共用同一份 config.json） */
export interface SettingsProviderShape {
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  envKey?: string;
  models?: Record<
    string,
    { contextWindow?: number; maxOutputTokens?: number; reasoning?: SettingsModelReasoningShape }
  >;
}

export interface SettingsRoleShape {
  channel: string;
  model: string;
  /** 当前推理档位（core `roles.<role>.effort`；未配置 = 用模型缺省档位） */
  effort?: string;
}

/** A09：单条 hook 的只读展示形态（与 core config.schema 的 HookEntry 同源） */
export interface SettingsHookEntryShape {
  /** 触发事件（sessionStart/sessionEnd/turnEnd/preTool/postTool） */
  event: string;
  /** glob matcher（仅 preTool/postTool；缺省 = 全命中） */
  matcher?: string;
  command: string;
  timeoutMs?: number;
  enabled?: boolean;
  async?: boolean;
}

/** A09：hooks 配置段只读视图（config.hooks；缺省未配置 = 分区空态） */
export interface SettingsHooksShape {
  enabled: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  entries: SettingsHookEntryShape[];
}

/** IM 网关单个渠道的 config 视图（config.gateways.<channel>；appId 非密钥，appSecret 只在 auth.json） */
export interface SettingsGatewayChannelShape {
  enabled?: boolean;
  appId?: string;
  dmPolicy?: string;
  groupPolicy?: string;
  allow?: string[];
  [key: string]: unknown;
}

export interface SettingsConfigShape {
  providers: Record<string, SettingsProviderShape>;
  roles: Record<string, SettingsRoleShape>;
  approval: { mode: string; tools?: Record<string, string> };
  memory: { mode: string; nudgeInterval: number };
  browser: { enabled: boolean; idleDestroyMs: number; maxConcurrent: number };
  plugins: { enabled: boolean; allow: string[] };
  mcpServers: Record<string, unknown>;
  subagent: { maxDepth: number; maxTurns: number };
  gateways?: Record<string, unknown>;
  /** A09：hooks 段（config.hooks；未配置 = 缺省，分区显示空态） */
  hooks?: SettingsHooksShape;
  /** 全局/项目配置文件是否存在（供 UI 提示写哪份） */
  sources: { global: boolean; project: boolean };
  /** 校验告警（未知字段/缺省补全） */
  warnings: string[];
  /** 致命错误（config 解析失败时展示） */
  errors: string[];
}

/** auth.json 掩码视图（永不回显明文密钥） */
export interface SettingsAuthMaskedShape {
  channels: Array<{ channel: string; masked: boolean }>;
  gateways: Array<{ channel: string; maskedAppId: boolean; maskedAppSecret: boolean }>;
  /** 损坏时的一行错误（已脱敏） */
  error?: string;
}

/** 桌面偏好（读写 desktop-preferences.json；纯 UI 偏好，不进 config.json） */
export interface SettingsPreferencesShape {
  theme: SettingsTheme;
  defaultPaneCount: number;
  showWelcome: boolean;
  notifyDetails: SettingsNotifyDetails;
  /** Z10-7 代码设置卡：浅色代码主题（缺省 = 桌面归一化补 github-light） */
  codeThemeLight?: CodeThemeId;
  /** Z10-7 代码设置卡：深色代码主题（缺省 = github-dark） */
  codeThemeDark?: CodeThemeId;
  /** Z10-7 代码设置卡：显示行号 */
  codeLineNumbers?: boolean;
  /** Z10-7 代码设置卡：长行自动换行 */
  codeWordWrap?: boolean;
  /** Z10-7 代码设置卡：代码字号（12–20，缺省 13） */
  codeFontSize?: number;
}

/** doctor 六项检查（core runDoctor 响应经 IPC 直传的最小形态） */
export interface SettingsDoctorCheck {
  id: string;
  status: 'ok' | 'warn' | 'fail';
  summary: string;
  details?: string[];
}

export interface SettingsDoctorReportShape {
  checks: SettingsDoctorCheck[];
  exitCode: 0 | 1;
}

export interface SettingsCrashReportShape {
  fileName: string;
  /** 文件修改时间戳（ISO） */
  mtime: string;
  size: number;
}

/** settings:getSkills 的单条技能（A08；主进程 fs 两级扫描，只读） */
export interface SettingsSkillShape {
  name: string;
  description: string;
  /** 来源文件绝对路径（单文件型 = *.md；文件夹型 = <name>/SKILL.md） */
  file: string;
  /** 来源层级（同名时项目级覆盖全局级，与 core SkillStore 同口径） */
  source: 'project' | 'global';
}

/** settings:getSkills 的响应（A08 技能分区数据；core SkillStore 同一扫描实现） */
export interface SettingsSkillsShape {
  skills: SettingsSkillShape[];
  /** 坏文件/覆盖/超限告警（不阻塞，如实展示） */
  warnings: string[];
  /** 两级扫描根（展示用：项目级 <root>/.harness2/skills，全局级 <home>/.harness2/skills） */
  roots: { project: string; global: string };
}

// —— P6-B 模型配置页（D-50～D-59）：提供方行 / 模型目录 / 凭据确认 / 发现模型 ——

/** D-52：凭据状态三态——只在已确认时上色，不猜 */
export type CredentialStateShape = 'confirmed' | 'missing' | 'unknown';

/** 凭据确认信息（不含任何明文；reference 是「具名引用」而非密钥值） */
export interface CredentialStatusShape {
  state: CredentialStateShape;
  /** 具名引用名（provider.envKey，缺省时由主进程派生 <ROUTE>_API_KEY）；无引用时 undefined */
  reference?: string;
  /** confirmed 的确认来源：auth.json 渠道条目 / 环境变量 */
  source?: 'auth.json' | 'env';
}

/** 提供方行的配置层归属（D-59：删除只看用户层是否独自携带该行） */
export type ModelsProviderLayerShape = 'user' | 'project';

/** 模型目录行（容量元数据可选；未知就不填，不臆造） */
export interface ModelsModelRowShape {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** 提供方行（读视图；含层归属与凭据确认） */
export interface ModelsProviderRowShape {
  /** Provider ID = config.providers 键 + 凭据引用词干（不可改） */
  id: string;
  /** 显示名称（config 无此字段：由桌面覆层 desktop-models.json 承载；缺省回退 id） */
  displayName: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  /** 配置里的具名凭据引用（只有名字，没有值） */
  apiKeyRef?: string;
  models: ModelsModelRowShape[];
  /** 携带该行的配置层（用户层 / 项目层；两层都有 = 两层都列） */
  layers: ModelsProviderLayerShape[];
  /** D-59：仅当用户层独自携带该行时可删（删后恢复组合基线） */
  deletable: boolean;
  /** 不可删除的可行动原因（deletable=false 时必有） */
  lockedReason?: string;
  credential: CredentialStatusShape;
}

/** 模型配置文档（D-58：每次写入须带读到的 revision；并发写报 settings/conflict） */
export interface ModelsDocumentShape {
  /** 不透明版本令牌（用户层 + 项目层 config 原文指纹）；写入必须回带 */
  revision: string;
  providers: ModelsProviderRowShape[];
  /** D-59 首运行：已确认的声明版本（0 = 未确认；UI 与声明版本常量比对） */
  declarationAckVersion: number;
  sources: { global: boolean; project: boolean };
  warnings: string[];
  errors: string[];
}

/** 提供方写入输入（单卡保存：用户层 upsert） */
export interface ModelsProviderInputShape {
  id: string;
  displayName: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  /** 保留既有具名引用用（UI 不提供改名入口；缺省时主进程派生 <ROUTE>_API_KEY） */
  apiKeyRef?: string;
  models: ModelsModelRowShape[];
}

/** 写入失败码（settings/conflict = 并发写；validation = 校验拒绝；locked = 规则不允许；io = 落盘失败） */
export type ModelsWriteCodeShape = 'settings/conflict' | 'validation' | 'locked' | 'io';

export interface ModelsWriteResultShape {
  ok: boolean;
  code?: ModelsWriteCodeShape;
  /** 校验失败字段（就地阻断用；如 id / baseUrl / models.<id>.contextWindow） */
  field?: string;
  error?: string;
  /** 成功后的最新文档；settings/conflict 时也回带（供 UI 刷新后重试，不盲目覆盖） */
  document?: ModelsDocumentShape;
}

/** 密钥写入结果：只回「具名引用」，永不回显明文 */
export interface ModelsCredentialWriteResultShape {
  ok: boolean;
  code?: ModelsWriteCodeShape;
  field?: string;
  error?: string;
  reference?: string;
}

/** 发现模型条目（id + 显示名；搜索同时匹配两者） */
export interface ModelsDiscoveryModelShape {
  id: string;
  displayName: string;
}

export interface ModelsDiscoveryResultShape {
  ok: boolean;
  models?: ModelsDiscoveryModelShape[];
  error?: string;
}

/** 首运行声明确认结果 */
export interface ModelsDeclarationAckShape {
  ok: boolean;
  declarationAckVersion: number;
  error?: string;
}

/** D-58：设置域事件帧（订阅而非轮询） */
export type SettingsEventFrame =
  | { type: 'settings/document-updated'; revision: string }
  | { type: 'credentials/reference-updated'; route: string }
  | { type: 'llm/adapters-updated' }
  | { type: 'connection/reset' };

/**
 * 模型配置页所需的最小通道面（D-50～D-59）。
 * 装配说明：各壳按自身可用通道提供本面（桌面 = window.harness2 的 settings:* IPC；web 未提供时
 * 如实降级，模型分区显示「此壳未提供模型配置通道」，不摆假入口）。
 */
export interface ModelsSettingsApi {
  /** 读模型配置文档（提供方行/模型目录/凭据确认/层归属/revision；不含任何密钥明文） */
  settingsGetModels(): Promise<ModelsDocumentShape>;
  /** 保存单张提供方卡（用户层 upsert；revision 不符 → code='settings/conflict'） */
  settingsUpdateModels(opts: {
    revision: string;
    provider: ModelsProviderInputShape;
    originalId?: string;
    mainModel?: string;
  }): Promise<ModelsWriteResultShape>;
  /** 删除提供方（仅用户层独有可删；confirmRoute 必须与 route 一致 = 确认框指名） */
  settingsDeleteProvider(route: string, confirmRoute: string): Promise<ModelsWriteResultShape>;
  /** 写渠道 API 密钥（只写：唯一的密钥入口；回读只有具名引用，不含明文） */
  settingsWriteChannelKey(route: string, key: string): Promise<ModelsCredentialWriteResultShape>;
  /** 凭据确认查询（只回「已确认/已确认缺失/未确认 + 具名引用」，永不回显明文） */
  settingsGetCredentialStatus(routes: string[]): Promise<Record<string, CredentialStatusShape>>;
  /** 首运行声明「已确认」（版本化落盘 ~/.harness2/desktop-models.json） */
  settingsAckModelsDeclaration(version: number): Promise<ModelsDeclarationAckShape>;
  /** 「获取可用模型」：拿表单当前端点查（密钥取自已存凭据，不经渲染端回传） */
  settingsDiscoverModels(input: {
    route: string;
    baseUrl: string;
    protocol: ModelsProviderInputShape['protocol'];
  }): Promise<ModelsDiscoveryResultShape>;
  /** 订阅设置域事件（D-58：settings/credentials/llm/connection）；返回退订函数 */
  onSettingsEvent(listener: (frame: SettingsEventFrame) => void): () => void;
}
