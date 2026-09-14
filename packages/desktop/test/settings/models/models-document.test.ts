// P6-B 主进程模型配置与凭据通道（D-50～D-59）单测：
//   文档读视图（层归属 / 可删性 / 凭据确认三态）· 校验四类拒绝 · revision 并发冲突
//   · 只写不回读密钥 · 「配置文件零密钥值」反向断言 · 删除规则 · 首运行版本化声明 · 发现模型。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ackModelsDeclaration,
  deleteModelsProvider,
  deriveApiKeyRef,
  discoverModelsFor,
  MODELS_OVERLAY_FILE,
  normalizeProviderInput,
  readCredentialStatuses,
  readModelsDocument,
  updateModelsProvider,
  validateApiKeyInput,
  validateProviderInput,
  writeChannelKey,
} from '../../../src/main/models-config.js';
import type { ModelsProviderInputShape, SettingsEventFrame } from '../../../src/shared/protocol.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const HARNESS_DIR = '.harness2';
const KEY_VALUE = 'sk-fixture-secret-abcdef123456';

function writeConfig(home: string, raw: unknown): void {
  mkdirSync(join(home, HARNESS_DIR), { recursive: true });
  writeFileSync(join(home, HARNESS_DIR, 'config.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

function writeProjectConfig(root: string, raw: unknown): void {
  mkdirSync(join(root, HARNESS_DIR), { recursive: true });
  writeFileSync(join(root, HARNESS_DIR, 'config.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

function writeAuth(home: string, raw: unknown): void {
  mkdirSync(join(home, HARNESS_DIR), { recursive: true });
  writeFileSync(join(home, HARNESS_DIR, 'auth.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

function configText(home: string): string {
  return readFileSync(join(home, HARNESS_DIR, 'config.json'), 'utf8');
}

function overlayText(home: string): string {
  const p = join(home, HARNESS_DIR, MODELS_OVERLAY_FILE);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

function providerInput(over: Partial<ModelsProviderInputShape> = {}): ModelsProviderInputShape {
  return {
    id: 'local-oai',
    displayName: '本地统一网关',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:40080/v1',
    models: [{ id: 'big-pickle', contextWindow: 200000, maxOutputTokens: 2048 }],
    ...over,
  };
}

describe('D-57/D-85：校验四类拒绝', () => {
  it('密钥：非可打印 ASCII 拒绝（含空白 / 控制字符 / 非 ASCII）', () => {
    expect(validateApiKeyInput('sk-abc def').ok).toBe(false); // 内嵌空白
    expect(validateApiKeyInput('  ').ok).toBe(false); // 去空白后为空
    expect(validateApiKeyInput('sk-abc\t123').ok).toBe(false); // 控制字符
    expect(validateApiKeyInput('密钥值').ok).toBe(false); // 非 ASCII
    expect(validateApiKeyInput(123).ok).toBe(false); // 非字符串
    expect(validateApiKeyInput('sk-abcDEF0123-_').ok).toBe(true);
    expect(validateApiKeyInput('  sk-abcDEF0123  ').value).toBe('sk-abcDEF0123'); // 去空白后存值
  });

  it('密钥：拒 NAME=value 粘贴（不误伤 base64）', () => {
    const res = validateApiKeyInput('LOCAL_UNIFIED_KEY=sk-abcDEF0123');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('NAME=value');
    expect(validateApiKeyInput('NAME=value').ok).toBe(false);
    expect(validateApiKeyInput('dGVzdEtleTEyMw').ok).toBe(true);
    // P2-8 与上游 ENV_LINE 同口径：`=` 后紧跟 `=` → 不是赋值行，全大写 base64 padding 放行
    expect(validateApiKeyInput('ABCD==')).toEqual({ ok: true, value: 'ABCD==' });
  });

  it('密钥：拒引号包裹（含反引号）；单边/内嵌引号按上游口径放行', () => {
    for (const raw of ['"sk-abcDEF0123"', "'sk-abcDEF0123'", '`sk-abcDEF0123`']) {
      const res = validateApiKeyInput(raw);
      expect(res.ok, raw).toBe(false);
      expect(res.error).toContain('引号');
    }
    // 上游 isQuoted 只认成对包裹；残留单边引号在可打印 ASCII 内 → 放行（P2-8 对齐）
    expect(validateApiKeyInput('"sk-abcDEF0123').ok).toBe(true);
  });

  it('提供方：空 id / 重复 id / 空显示名 / 非正整容量 / 端点语法 / 协议非法', () => {
    const ctx = { existingIds: ['local-oai'] };
    expect(validateProviderInput(providerInput({ id: '   ' }), ctx).map((i) => i.field)).toContain('id');
    expect(
      validateProviderInput(providerInput(), ctx)
        .map((i) => i.message)
        .join(),
    ).toContain('已存在');
    expect(validateProviderInput(providerInput({ id: 'new-one' }), ctx)).toEqual([]);
    const noName = validateProviderInput(providerInput({ id: 'new-one', displayName: ' ' }), ctx);
    expect(noName.map((i) => i.field)).toContain('displayName');
    const badCap = validateProviderInput(
      providerInput({ id: 'new-one', models: [{ id: 'm', contextWindow: 0, maxOutputTokens: -5 }] }),
      ctx,
    );
    expect(badCap.map((i) => i.field)).toEqual(['models.0.contextWindow', 'models.0.maxOutputTokens']);
    expect(
      validateProviderInput(providerInput({ id: 'new-one', models: [{ id: 'm', contextWindow: 1.5 }] }), ctx).map(
        (i) => i.message,
      )[0],
    ).toContain('正整数');
    expect(
      validateProviderInput(providerInput({ id: 'new-one', models: [{ id: ' ' }] }), ctx).map((i) => i.field),
    ).toContain('models.0.id');
    expect(
      validateProviderInput(providerInput({ id: 'new-one', models: [{ id: 'm' }, { id: 'm' }] }), ctx).map(
        (i) => i.message,
      )[0],
    ).toContain('重复');
    expect(
      validateProviderInput(providerInput({ id: 'new-one', baseUrl: 'not a url' }), ctx).map((i) => i.field),
    ).toContain('baseUrl');
    expect(
      validateProviderInput(providerInput({ id: 'new-one', baseUrl: 'ftp://host/v1' }), ctx).map((i) => i.message)[0],
    ).toContain('http');
  });

  it('D-85：localhost / IPv4 / IPv6 字面量 / 自定义端口都合法', () => {
    const ctx = { existingIds: [] };
    for (const url of [
      'http://localhost:40080/v1',
      'http://127.0.0.1:40080/v1',
      'http://[::1]:8080/v1',
      'https://api.example.com',
      'https://api.example.com:8443/v1/',
    ]) {
      expect(validateProviderInput(providerInput({ baseUrl: url }), ctx), url).toEqual([]);
    }
  });

  it('ID 不可改：originalId 与 id 不一致即拒', () => {
    const issues = validateProviderInput(providerInput({ id: 'renamed' }), {
      existingIds: ['local-oai'],
      originalId: 'local-oai',
    });
    expect(issues.map((i) => i.message).join()).toContain('不可修改');
  });

  it('规范化：非对象 / 非字符串字段 / 模型非数组都收集为问题而非抛错', () => {
    expect(normalizeProviderInput(null).issues.length).toBe(1);
    expect(normalizeProviderInput({ id: 1, models: 'x' }).issues.map((i) => i.field)).toEqual(['id', 'models']);
  });
});

describe('D-50/D-52/D-59：文档读视图（层归属 / 凭据确认 / 可删性）', () => {
  it('空 home：空列表 + 无错误 + 指纹非空', () => {
    const home = tmp('h2-m-home-');
    const doc = readModelsDocument(home, home, {});
    expect(doc.providers).toEqual([]);
    expect(doc.sources).toEqual({ global: false, project: false });
    expect(doc.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(doc.declarationAckVersion).toBe(0);
    expect(doc.errors).toEqual([]);
  });

  it('层归属与可删性：用户层独有可删；项目层携带不可删（指名项目路径）', () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    writeConfig(home, {
      providers: { 'user-only': { protocol: 'openai', baseUrl: 'https://u.test/v1' } },
      roles: {},
    });
    writeProjectConfig(root, {
      providers: { 'proj-only': { protocol: 'openai', baseUrl: 'https://p.test/v1' } },
      roles: {},
    });
    const doc = readModelsDocument(home, root, {});
    const byId = Object.fromEntries(doc.providers.map((p) => [p.id, p]));
    expect(byId['user-only']?.layers).toEqual(['user']);
    expect(byId['user-only']?.deletable).toBe(true);
    expect(byId['proj-only']?.layers).toEqual(['project']);
    expect(byId['proj-only']?.deletable).toBe(false);
    expect(byId['proj-only']?.lockedReason).toContain(join(root, HARNESS_DIR, 'config.json'));
    expect(doc.sources).toEqual({ global: true, project: true });
  });

  it('两层同 id：层并列、不可删（删用户层会露出项目层基线）', () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    writeConfig(home, { providers: { both: { protocol: 'openai', baseUrl: 'https://u.test/v1' } }, roles: {} });
    writeProjectConfig(root, {
      providers: { both: { protocol: 'anthropic', baseUrl: 'https://p.test/v1' } },
      roles: {},
    });
    const row = readModelsDocument(home, root, {}).providers.find((p) => p.id === 'both');
    expect(row?.layers).toEqual(['user', 'project']);
    expect(row?.deletable).toBe(false);
    expect(row?.protocol).toBe('anthropic'); // 项目层覆盖（与 core deepMerge 同口径）
  });

  it('D-52 凭据三态：没有引用=unknown；有引用但缺失=missing；auth.json 有条目=confirmed', () => {
    const home = tmp('h2-m-home-');
    writeConfig(home, {
      providers: {
        noRef: { protocol: 'openai', baseUrl: 'https://a.test/v1' },
        withRefMissing: { protocol: 'openai', baseUrl: 'https://b.test/v1', envKey: 'B_KEY' },
        withAuth: { protocol: 'openai', baseUrl: 'https://c.test/v1', envKey: 'C_KEY' },
      },
      roles: {},
    });
    writeAuth(home, { channels: { withAuth: { apiKey: KEY_VALUE } } });
    const doc = readModelsDocument(home, home, {});
    const byId = Object.fromEntries(doc.providers.map((p) => [p.id, p.credential]));
    expect(byId['noRef']).toEqual({ state: 'unknown' });
    expect(byId['withRefMissing']).toEqual({ state: 'missing', reference: 'B_KEY' });
    expect(byId['withAuth']).toEqual({ state: 'confirmed', source: 'auth.json', reference: 'C_KEY' });
  });

  it('D-52 环境变量确认：envKey 指向的环境变量存在 → confirmed(env)，且不暴露值', () => {
    const home = tmp('h2-m-home-');
    writeConfig(home, {
      providers: { envs: { protocol: 'openai', baseUrl: 'https://d.test/v1', envKey: 'H2_TEST_ENV_KEY' } },
      roles: {},
    });
    const doc = readModelsDocument(home, home, {});
    const envDoc = readModelsDocument(home, home, {});
    expect(envDoc.providers[0]?.credential.state).toBe('missing');
    const statuses = readCredentialStatuses(home, home, ['envs'], { H2_TEST_ENV_KEY: KEY_VALUE });
    expect(statuses['envs']).toEqual({ state: 'confirmed', source: 'env', reference: 'H2_TEST_ENV_KEY' });
    expect(JSON.stringify(statuses)).not.toContain(KEY_VALUE);
    void doc;
  });

  it('auth.json 损坏：状态一律 unknown + 错误经脱敏进文档', () => {
    const home = tmp('h2-m-home-');
    writeConfig(home, { providers: { p1: { protocol: 'openai', baseUrl: 'https://e.test/v1' } }, roles: {} });
    writeAuth(home, { channels: { p1: { apiKey: 'broken' } } });
    writeFileSync(join(home, HARNESS_DIR, 'auth.json'), '{ "channels": { "p1": { "apiKey": "" } }', 'utf8');
    const doc = readModelsDocument(home, home, {});
    expect(doc.providers[0]?.credential.state).toBe('unknown');
    expect(doc.errors.join()).toContain('auth.json');
  });

  it('显示名称来自桌面覆层（缺省回退 id）', () => {
    const home = tmp('h2-m-home-');
    writeConfig(home, { providers: { fancy: { protocol: 'openai', baseUrl: 'https://f.test/v1' } }, roles: {} });
    mkdirSync(join(home, HARNESS_DIR), { recursive: true });
    writeFileSync(
      join(home, HARNESS_DIR, MODELS_OVERLAY_FILE),
      JSON.stringify({ displayNames: { fancy: '花名' }, declarationAckVersion: 3 }),
      'utf8',
    );
    const doc = readModelsDocument(home, home, {});
    expect(doc.providers[0]?.displayName).toBe('花名');
    expect(doc.declarationAckVersion).toBe(3);
  });
});

describe('D-51/D-57/D-58：写入路径（revision / 派生引用 / 零密钥值）', () => {
  it('保存提供方：派生 <ROUTE>_API_KEY 写进 config（只有名字），无密钥值；revision 前进', () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    const events: SettingsEventFrame[] = [];
    const before = readModelsDocument(home, root, {});
    const res = updateModelsProvider(home, root, { revision: before.revision, provider: providerInput() }, (f) =>
      events.push(f),
    );
    expect(res.ok).toBe(true);
    const text = configText(home);
    expect(text).toContain('"envKey": "LOCAL_OAI_API_KEY"');
    expect(text).not.toContain('apiKey');
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{6,}/);
    expect(res.document?.providers[0]?.apiKeyRef).toBe(deriveApiKeyRef('local-oai'));
    expect(res.document?.providers[0]?.models).toEqual([
      { id: 'big-pickle', contextWindow: 200000, maxOutputTokens: 2048 },
    ]);
    expect(res.document?.revision).not.toBe(before.revision);
    expect(events.map((e) => e.type)).toEqual(['settings/document-updated', 'llm/adapters-updated']);
  });

  it('D-58 并发写：revision 不符 → settings/conflict，且不落盘（回带最新文档）', () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    const first = readModelsDocument(home, root, {});
    expect(updateModelsProvider(home, root, { revision: first.revision, provider: providerInput() }).ok).toBe(true);
    const stale = updateModelsProvider(home, root, {
      revision: first.revision, // 旧 revision
      provider: providerInput({ displayName: '并发改写' }),
      originalId: 'local-oai',
    });
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe('settings/conflict');
    expect(stale.document?.revision).not.toBe(first.revision);
    expect(configText(home)).not.toContain('并发改写');
    // 用最新 revision 重试即成功（UI 冲突后刷新重试路径）
    const retry = updateModelsProvider(home, root, {
      revision: stale.document!.revision,
      provider: providerInput({ displayName: '并发改写' }),
      originalId: 'local-oai', // 编辑既有行：Provider ID 不可改（UI 同口径）
    });
    expect(retry.ok).toBe(true);
    // 显示名称的落点是桌面覆层（config.json 无 displayName 字段 = core 冻结区），不是 config.json
    expect(overlayText(home)).toContain('并发改写');
    expect(retry.document?.providers[0]?.displayName).toBe('并发改写');
  });

  it('校验失败不落盘：空 id / 重复 id / 非正整容量 / 端点语法 / 非法协议', () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    expect(
      updateModelsProvider(home, root, {
        revision: readModelsDocument(home, root, {}).revision,
        provider: providerInput(),
      }).ok,
    ).toBe(true);
    const rev = readModelsDocument(home, root, {}).revision;
    // 用例里协议故意越界（'gemini' 不在契约联合里）：断言的是**运行期**拒绝而非类型拒绝，
    // 故就地收窄断言（shape 归属 protocol 契约，测试不另造一套联合）。
    const cases: Array<[ModelsProviderInputShape, string]> = [
      [providerInput({ id: '' }), 'id'],
      [providerInput(), 'id'], // 重复
      [providerInput({ id: 'x', displayName: ' ' }), 'displayName'],
      [providerInput({ id: 'x', models: [{ id: 'm', contextWindow: 0 }] }), 'models.0.contextWindow'],
      [providerInput({ id: 'x', models: [{ id: 'm', maxOutputTokens: -1 }] }), 'models.0.maxOutputTokens'],
      [providerInput({ id: 'x', baseUrl: 'nope' }), 'baseUrl'],
      [providerInput({ id: 'x', protocol: 'gemini' as ModelsProviderInputShape['protocol'] }), 'protocol'],
    ];
    for (const [provider, field] of cases) {
      const res = updateModelsProvider(home, root, { revision: rev, provider });
      expect(res.ok, JSON.stringify(provider)).toBe(false);
      expect(res.code, JSON.stringify(provider)).toBe('validation');
      expect(res.field).toBe(field);
    }
    const after = readModelsDocument(home, root, {});
    expect(after.revision).toBe(rev); // 六次拒绝都没有落盘
    expect(after.providers.map((p) => p.id)).toEqual(['local-oai']);
  });

  it('JSONC 损坏：拒绝写入（不静默覆盖），错误可行动且脱敏', () => {
    const home = tmp('h2-m-home-');
    const corrupt = '{ "providers": { ';
    writeConfig(home, {});
    writeFileSync(join(home, HARNESS_DIR, 'config.json'), corrupt, 'utf8');
    const res = updateModelsProvider(home, home, {
      revision: readModelsDocument(home, home, {}).revision,
      provider: providerInput(),
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('io');
    expect(res.error).toContain('无法解析');
    expect(configText(home)).toBe(corrupt);
  });

  it('主模型：mainModel 必须在模型目录内（否则拒），写入后 roles.main 指向新提供方', () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    const rev = readModelsDocument(home, root, {}).revision;
    const bad = updateModelsProvider(home, root, {
      revision: rev,
      provider: providerInput(),
      mainModel: 'not-declared',
    });
    expect(bad.ok).toBe(false);
    expect(bad.field).toBe('mainModel');
    const ok = updateModelsProvider(home, root, {
      revision: readModelsDocument(home, root, {}).revision,
      provider: providerInput(),
      mainModel: 'big-pickle',
    });
    expect(ok.ok).toBe(true);
    expect(configText(home)).toContain('"main"');
    expect(configText(home)).toContain('"big-pickle"');
  });

  it('既有 envKey 保留（不因保存卡而改名）', () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    writeConfig(home, {
      providers: { keep: { protocol: 'openai', baseUrl: 'https://k.test/v1', envKey: 'MY_PERSONAL_KEY' } },
      roles: {},
    });
    const res = updateModelsProvider(home, root, {
      revision: readModelsDocument(home, root, {}).revision,
      provider: providerInput({ id: 'keep', displayName: 'Keep' }),
      originalId: 'keep',
    });
    expect(res.ok).toBe(true);
    expect(configText(home)).toContain('"envKey": "MY_PERSONAL_KEY"');
    expect(configText(home)).not.toContain('KEEP_API_KEY');
  });

  it('显示名称落覆层（= id 时移除条目；覆层永不出现密钥值）', () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    const first = updateModelsProvider(home, root, {
      revision: readModelsDocument(home, root, {}).revision,
      provider: providerInput({ displayName: '网关 A' }),
    });
    expect(first.ok).toBe(true);
    expect(overlayText(home)).toContain('网关 A');
    const second = updateModelsProvider(home, root, {
      revision: readModelsDocument(home, root, {}).revision,
      provider: providerInput({ displayName: 'local-oai' }),
      originalId: 'local-oai',
    });
    expect(second.ok).toBe(true);
    expect(overlayText(home)).not.toContain('"local-oai": "local-oai"');
    expect(overlayText(home)).not.toMatch(/sk-[A-Za-z0-9_-]{6,}/);
  });
});

describe('D-51/D-52：凭据通道（只写、不回读明文、派生引用）', () => {
  it('写密钥：落 auth.json（唯一合法位置），回读只有引用名，绝不回显明文', () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    const events: SettingsEventFrame[] = [];
    const res = writeChannelKey(home, root, 'local-oai', KEY_VALUE, (f) => events.push(f));
    expect(res.ok).toBe(true);
    expect(res.reference).toBe('LOCAL_OAI_API_KEY');
    expect(JSON.stringify(res)).not.toContain(KEY_VALUE);
    expect(readFileSync(join(home, HARNESS_DIR, 'auth.json'), 'utf8')).toContain(KEY_VALUE);
    expect(events.map((e) => e.type)).toContain('credentials/reference-updated');
    // 文档（渲染端可见形态）里没有明文
    expect(JSON.stringify(readModelsDocument(home, root, {}))).not.toContain(KEY_VALUE);
    // 写完后状态变 confirmed（auth.json 优先于 envKey）
    writeConfig(home, { providers: { 'local-oai': { protocol: 'openai', baseUrl: 'https://x.test/v1' } }, roles: {} });
    expect(readModelsDocument(home, root, {}).providers[0]?.credential.state).toBe('confirmed');
  });

  it('四类密钥拒绝：非 ASCII / NAME=value / 引号包裹 / 空——一律不写 auth.json', () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    for (const bad of ['sk-a b', 'LOCAL_KEY=sk-abc', '"sk-abc"', '   ', 'sk-中文', 'sk-a\tb']) {
      const res = writeChannelKey(home, root, 'local-oai', bad);
      expect(res.ok, bad).toBe(false);
      expect(res.code).toBe('validation');
      expect(res.field).toBe('key');
    }
    expect(existsSync(join(home, HARNESS_DIR, 'auth.json'))).toBe(false);
  });

  it('出口脱敏（redactSecrets 纵深防御）：拒绝消息绝不回显被拒的密钥值', () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    // 含 sk- 前缀但形态非法（内嵌空白）→ 拒绝；整条返回体不得出现这段值
    const leaky = 'sk-leak-canary-9f3a2b';
    const res = writeChannelKey(home, root, 'local-oai', `${leaky} tail`);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('validation');
    expect(JSON.stringify(res)).not.toContain(leaky);
    expect(existsSync(join(home, HARNESS_DIR, 'auth.json'))).toBe(false);
  });

  it('auth.json 损坏：拒绝写入（不覆盖既有凭据）+ 老渠道保持不变', () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    mkdirSync(join(home, HARNESS_DIR), { recursive: true });
    const broken = '{ "channels": {';
    writeFileSync(join(home, HARNESS_DIR, 'auth.json'), broken, 'utf8');
    const res = writeChannelKey(home, root, 'local-oai', KEY_VALUE);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('io');
    expect(readFileSync(join(home, HARNESS_DIR, 'auth.json'), 'utf8')).toBe(broken);
  });

  it('写其它渠道不丢已有渠道（合并写）', () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    writeChannelKey(home, root, 'a', 'sk-aaa111222');
    writeChannelKey(home, root, 'b', 'sk-bbb111222');
    const auth = JSON.parse(readFileSync(join(home, HARNESS_DIR, 'auth.json'), 'utf8')) as {
      channels: Record<string, { apiKey: string }>;
    };
    expect(Object.keys(auth.channels).sort()).toEqual(['a', 'b']);
  });

  it('缺失 Provider ID 拒绝（凭据必须归属渠道）', () => {
    const home = tmp('h2-m-home-');
    expect(writeChannelKey(home, home, '  ', KEY_VALUE).ok).toBe(false);
  });
});

describe('D-59：删除（仅用户层独有 + 确认指名）与首运行声明', () => {
  it('确认名与 route 不一致即拒（确认框必须指名提供方）', () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    updateModelsProvider(home, root, {
      revision: readModelsDocument(home, root, {}).revision,
      provider: providerInput(),
    });
    const res = deleteModelsProvider(home, root, { route: 'local-oai', confirmRoute: 'other' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('validation');
    expect(res.error).toContain('指名');
    expect(readModelsDocument(home, root, {}).providers).toHaveLength(1);
  });

  it('用户层独有可删：删后行消失（恢复组合基线），连带移除指向它的用户层角色', () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    updateModelsProvider(home, root, {
      revision: readModelsDocument(home, root, {}).revision,
      provider: providerInput(),
      mainModel: 'big-pickle',
    });
    const events: SettingsEventFrame[] = [];
    const res = deleteModelsProvider(home, root, { route: 'local-oai', confirmRoute: 'local-oai' }, (f) =>
      events.push(f),
    );
    expect(res.ok).toBe(true);
    expect(res.document?.providers).toEqual([]);
    expect(configText(home)).not.toContain('big-pickle');
    expect(overlayText(home)).not.toContain('本地统一网关');
    expect(events.map((e) => e.type)).toContain('llm/adapters-updated');
  });

  it('项目层携带的行不可删（回可行动原因，不猜）', () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    writeProjectConfig(root, { providers: { proj: { protocol: 'openai', baseUrl: 'https://p.test/v1' } }, roles: {} });
    const res = deleteModelsProvider(home, root, { route: 'proj', confirmRoute: 'proj' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('locked');
    expect(res.error).toContain('项目配置');
  });

  it('组合基线仍引用被删行 → 拒绝（不留下无效配置）', () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    writeConfig(home, {
      providers: { shared: { protocol: 'openai', baseUrl: 'https://s.test/v1', models: { m: {} } } },
      roles: {},
    });
    writeProjectConfig(root, {
      providers: { shared: { protocol: 'openai', baseUrl: 'https://s.test/v1' } },
      roles: { main: { channel: 'shared', model: 'm' } },
    });
    // 两层同 id → 本身不可删
    const res = deleteModelsProvider(home, root, { route: 'shared', confirmRoute: 'shared' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('locked');
  });

  it('首运行声明：版本化落盘（单调不回退；非法版本拒绝）', () => {
    const home = tmp('h2-m-home-');
    expect(readModelsDocument(home, home, {}).declarationAckVersion).toBe(0);
    expect(ackModelsDeclaration(home, 1)).toEqual({ ok: true, declarationAckVersion: 1 });
    expect(readModelsDocument(home, home, {}).declarationAckVersion).toBe(1);
    expect(ackModelsDeclaration(home, 1).declarationAckVersion).toBe(1);
    expect(ackModelsDeclaration(home, 5).declarationAckVersion).toBe(5);
    expect(ackModelsDeclaration(home, 2).declarationAckVersion).toBe(5); // 不回退
    expect(ackModelsDeclaration(home, 0).ok).toBe(false);
    expect(ackModelsDeclaration(home, 'x').ok).toBe(false);
  });
});

describe('D-55：发现模型（拿表单端点去查；密钥不经渲染端回传）', () => {
  it('openai：命中 {baseUrl}/models，带 Bearer 头；id+显示名解析（缺显示名回退 id）', async () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    writeAuth(home, { channels: { 'local-oai': { apiKey: KEY_VALUE } } });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const res = await discoverModelsFor(
      home,
      root,
      { route: 'local-oai', baseUrl: 'http://127.0.0.1:40080/v1/', protocol: 'openai' },
      async (url, init) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({ data: [{ id: 'big-pickle', display_name: 'Big Pickle' }, { id: 'plain' }] }),
          { status: 200 },
        );
      },
      {},
    );
    expect(res.ok).toBe(true);
    expect(res.models).toEqual([
      { id: 'big-pickle', displayName: 'Big Pickle' },
      { id: 'plain', displayName: 'plain' },
    ]);
    expect(calls[0]?.url).toBe('http://127.0.0.1:40080/v1/models');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${KEY_VALUE}`);
    expect(JSON.stringify(res)).not.toContain(KEY_VALUE);
  });

  it('anthropic：走 {baseUrl}/v1/models + x-api-key 头', async () => {
    const home = tmp('h2-m-home-');
    const root = tmp('h2-m-root-');
    writeAuth(home, { channels: { ant: { apiKey: KEY_VALUE } } });
    let seen: { url: string; init: RequestInit } | null = null;
    const res = await discoverModelsFor(
      home,
      root,
      { route: 'ant', baseUrl: 'https://api.anthropic.com', protocol: 'anthropic' },
      async (url, init) => {
        seen = { url, init };
        return new Response(JSON.stringify({ data: [{ id: 'claude-x' }] }), { status: 200 });
      },
      {},
    );
    expect(res.ok).toBe(true);
    expect(seen!.url).toBe('https://api.anthropic.com/v1/models');
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(KEY_VALUE);
    expect(headers['anthropic-version']).toBeDefined();
  });

  it('无凭据：如实拒绝并给可行动提示（不发起网络请求，不让渲染端回传明文）', async () => {
    const home = tmp('h2-m-home-');
    let called = false;
    const res = await discoverModelsFor(
      home,
      home,
      { route: 'nope', baseUrl: 'https://a.test/v1', protocol: 'openai' },
      async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
      {},
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('API 密钥');
    expect(called).toBe(false);
  });

  it('端点语法错误：就地拒绝（不发请求）', async () => {
    const home = tmp('h2-m-home-');
    let called = false;
    const res = await discoverModelsFor(
      home,
      home,
      { route: 'a', baseUrl: 'not a url', protocol: 'openai' },
      async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
      {},
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('http');
    expect(called).toBe(false);
  });

  it('HTTP 失败与网络异常：错误消息经脱敏（不带密钥）', async () => {
    const home = tmp('h2-m-home-');
    writeAuth(home, { channels: { a: { apiKey: KEY_VALUE } } });
    const http = await discoverModelsFor(
      home,
      home,
      { route: 'a', baseUrl: 'https://a.test/v1', protocol: 'openai' },
      async () => new Response(`bad key ${KEY_VALUE}`, { status: 401 }),
      {},
    );
    expect(http.ok).toBe(false);
    expect(http.error).toContain('HTTP 401');
    expect(http.error).not.toContain(KEY_VALUE);
    const net = await discoverModelsFor(
      home,
      home,
      { route: 'a', baseUrl: 'https://a.test/v1', protocol: 'openai' },
      async () => {
        throw new Error(`connect ECONNREFUSED bearer ${KEY_VALUE}`);
      },
      {},
    );
    expect(net.ok).toBe(false);
    expect(net.error).not.toContain(KEY_VALUE);
  });

  it('空列表 / 非 JSON 响应：如实报错（不臆造模型）', async () => {
    const home = tmp('h2-m-home-');
    writeAuth(home, { channels: { a: { apiKey: KEY_VALUE } } });
    const empty = await discoverModelsFor(
      home,
      home,
      { route: 'a', baseUrl: 'https://a.test/v1', protocol: 'openai' },
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
      {},
    );
    expect(empty.ok).toBe(false);
    const notJson = await discoverModelsFor(
      home,
      home,
      { route: 'a', baseUrl: 'https://a.test/v1', protocol: 'openai' },
      async () => new Response('<html>', { status: 200 }),
      {},
    );
    expect(notJson.ok).toBe(false);
  });

  it('登记项加固：服务端错误体/网络异常原样回显**无前缀**密钥时出口也脱敏', async () => {
    // bare 值没有 sk- 前缀、也不带字段名/Bearer 包裹：redactSecrets 单独覆盖不到
    const bare = 'LocalGwSecret42';
    const home = tmp('h2-m-home-');
    writeAuth(home, { channels: { a: { apiKey: bare } } });

    const http = await discoverModelsFor(
      home,
      home,
      { route: 'a', baseUrl: 'https://a.test/v1', protocol: 'openai' },
      async () => new Response(`denied: ${bare} is not allowed`, { status: 401 }),
      {},
    );
    expect(http.ok).toBe(false);
    expect(http.error).toContain('HTTP 401');
    expect(http.error).not.toContain(bare);

    const net = await discoverModelsFor(
      home,
      home,
      { route: 'a', baseUrl: 'https://a.test/v1', protocol: 'openai' },
      async () => {
        throw new Error(`connect ECONNREFUSED with ${bare}`);
      },
      {},
    );
    expect(net.ok).toBe(false);
    expect(net.error).not.toContain(bare);
  });
});
