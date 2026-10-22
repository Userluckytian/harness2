/**
 * ZS4-T4：provider 写路径十投 + testModelConnectivity。
 * 红线证据：密钥永不落 config.json（只进 auth.json）；错误消息不泄漏密钥。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderSettingsService } from '../src/real/provider-views.js';

const SECRET = 'sk-unified-local';

function makeHome(cfg?: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'h2-pw-'));
  const hdir = join(home, '.harness2');
  mkdirSync(hdir, { recursive: true });
  writeFileSync(
    join(hdir, 'config.json'),
    JSON.stringify(
      cfg ?? {
        providers: {
          alpha: { protocol: 'openai', baseUrl: 'https://a.example/v1', models: { 'm-a': {} } },
          beta: { protocol: 'openai', baseUrl: 'https://b.example/v1', models: { 'm-b': {}, 'm-b2': {} } },
        },
        roles: { main: { channel: 'alpha', model: 'm-a' } },
      },
    ),
  );
  return home;
}

function readConfig(home: string): Record<string, any> {
  return JSON.parse(readFileSync(join(home, '.harness2', 'config.json'), 'utf8'));
}

function readAuth(home: string): Record<string, any> {
  const p = join(home, '.harness2', 'auth.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

describe('provider 写路径（ZS4-T4）', () => {
  it('createPersonalProvider → 视图含新 provider，config 落盘且无密钥', async () => {
    const home = makeHome();
    const svc: any = createProviderSettingsService({ home });
    const res: any = await svc.createPersonalProvider({
      providerName: '我的渠道',
      initialConfig: { protocol: 'openai', baseUrl: 'https://p.example/v1' },
    });
    expect(typeof res.providerId).toBe('string');
    expect(res.providerId).toMatch(/^personal-/);
    expect(res.view.providers.some((p: any) => p.providerId === res.providerId)).toBe(true);
    const cfg = readConfig(home);
    expect(cfg.providers[res.providerId].baseUrl).toBe('https://p.example/v1');
    expect(cfg.providers[res.providerId].enabled).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it('savePersonalProviderOverlay 携带 apiKey → 进 auth 不进 config；无密钥保存保留既有密钥', async () => {
    const home = makeHome();
    const svc: any = createProviderSettingsService({ home });
    const view: any = await svc.savePersonalProviderOverlay('alpha', {
      protocol: 'openai',
      baseUrl: 'https://new.example/v1',
      apiKey: SECRET,
      models: { 'm-a': {} },
    });
    const cfg = readConfig(home);
    expect(JSON.stringify(cfg)).not.toContain(SECRET);
    expect(cfg.providers.alpha.baseUrl).toBe('https://new.example/v1');
    expect('apiKey' in cfg.providers.alpha).toBe(false);
    expect(readAuth(home).channels.alpha.apiKey).toBe(SECRET);
    const alpha = view.providers.find((p: any) => p.providerId === 'alpha');
    expect(alpha.executable).toBe(true);

    // 不带密钥再保存一次：auth 既有密钥不动
    await svc.savePersonalProviderOverlay('alpha', {
      protocol: 'openai',
      baseUrl: 'https://newer.example/v1',
      models: { 'm-a': {} },
    });
    expect(readAuth(home).channels.alpha.apiKey).toBe(SECRET);
    rmSync(home, { recursive: true, force: true });
  });

  it('overlay 校验：坏 protocol 拒绝；空 baseUrl=编辑草稿（不落盘防炸全盘，ZS4-T6 语义）', async () => {
    const home = makeHome();
    const svc: any = createProviderSettingsService({ home });
    await expect(svc.savePersonalProviderOverlay('alpha', { protocol: 'grpc', baseUrl: 'x' })).rejects.toThrow(
      /protocol/,
    );
    // 空 baseUrl：不 throw（UI 表单空值自动保存流），但**不落盘**——磁盘保持旧合法值
    const view: any = await svc.savePersonalProviderOverlay('alpha', { protocol: 'openai', baseUrl: '  ' });
    expect(readConfig(home).providers.alpha.baseUrl).toBe('https://a.example/v1');
    const alpha = view.providers.find((p: any) => p.providerId === 'alpha');
    expect(alpha.effectiveConfig.api.baseUrl).toBe('  '); // 视图含草稿（表单不丢编辑值）
    rmSync(home, { recursive: true, force: true });
  });

  it('形状翻译（ZS4-T6 e2e 实证缺口）：UI 嵌套形入参 ↔ 磁盘 core 扁平形 ↔ 视图嵌套形', async () => {
    const home = makeHome();
    const svc: any = createProviderSettingsService({ home });
    // UI 嵌套形保存（providerPersonalSave 负载：api/access，无扁平键）
    await svc.savePersonalProviderOverlay('alpha', {
      group: 'standard-personal',
      api: { type: 'openai-chat-completions', baseUrl: 'https://nested.example/v1' },
      access: { type: 'api-key', apiKey: SECRET },
    });
    const cfg = readConfig(home);
    expect(cfg.providers.alpha.baseUrl).toBe('https://nested.example/v1'); // 落盘=扁平形
    expect(cfg.providers.alpha.protocol).toBe('openai');
    expect('api' in cfg.providers.alpha).toBe(false);
    expect(JSON.stringify(cfg)).not.toContain(SECRET);
    expect(readAuth(home).channels.alpha.apiKey).toBe(SECRET);
    // 视图出站=嵌套形 + group 判据 + personalConfig 镜像（表单读 config.api.baseUrl）
    const view: any = await svc.getView();
    const alpha = view.providers.find((p: any) => p.providerId === 'alpha');
    expect(alpha.effectiveConfig.group).toBe('standard-personal');
    expect(alpha.effectiveConfig.api.baseUrl).toBe('https://nested.example/v1');
    expect(alpha.effectiveConfig.api.type).toBe('openai-chat-completions');
    expect(alpha.personalConfig.api.baseUrl).toBe('https://nested.example/v1');
    // anthropic 映射
    await svc.savePersonalProviderOverlay('beta', {
      api: { type: 'anthropic-messages', baseUrl: 'https://ant.example' },
    });
    expect(readConfig(home).providers.beta.protocol).toBe('anthropic');
    rmSync(home, { recursive: true, force: true });
  });

  it('create 空 baseUrl 走内存草稿：视图有、盘无、再落盘合法才进 config', async () => {
    const home = makeHome();
    const svc: any = createProviderSettingsService({ home });
    const created: any = await svc.createPersonalProvider({ providerName: 'New provider' });
    const pid: string = created.providerId;
    // 未配置渠道不在视图里出现非法盘态——磁盘仍是原样
    expect(readConfig(home).providers[pid]).toBeUndefined();
    const v1: any = created.view;
    const draft = v1.providers.find((p: any) => p.providerId === pid);
    expect(draft.providerName).toBe('New provider');
    expect(draft.executable).toBe(false);
    // 合法保存 → 落盘 + 草稿出栈
    await svc.savePersonalProviderOverlay(pid, {
      api: { type: 'openai-chat-completions', baseUrl: 'http://127.0.0.1:9/v1' },
    });
    expect(readConfig(home).providers[pid].baseUrl).toBe('http://127.0.0.1:9/v1');
    // 删除草稿态 provider（未落盘）不炸
    const created2: any = await svc.createPersonalProvider({});
    const vdel: any = await svc.deletePersonalProvider(created2.providerId);
    expect(vdel.providers.find((p: any) => p.providerId === created2.providerId)).toBeUndefined();
    rmSync(home, { recursive: true, force: true });
  });

  it('模型 add/rename/delete/enabled/reorder：键序保持，enabled 落条目', async () => {
    const home = makeHome();
    const svc: any = createProviderSettingsService({ home });
    let view: any = await svc.addPersonalModel('beta', 'm-b3', { contextWindow: 100 });
    expect(Object.keys(readConfig(home).providers.beta.models)).toEqual(['m-b', 'm-b2', 'm-b3']);
    await expect(svc.addPersonalModel('beta', 'm-b')).rejects.toThrow(/已存在/);
    await expect(svc.addPersonalModel('beta', 'bad id!!')).rejects.toThrow(/形状/);
    await expect(svc.addPersonalModel('nope', 'x')).rejects.toThrow(/provider 不存在/);

    view = await svc.renamePersonalModel('beta', 'm-b2', 'm-b2x');
    expect(Object.keys(readConfig(home).providers.beta.models)).toEqual(['m-b', 'm-b2x', 'm-b3']);

    view = await svc.setPersonalModelEnabled('beta', 'm-b', false);
    expect(readConfig(home).providers.beta.models['m-b'].enabled).toBe(false);
    let mB = view.providers.find((p: any) => p.providerId === 'beta').models.find((m: any) => m.modelId === 'm-b');
    expect(mB.enabled).toBe(false);

    view = await svc.reorderPersonalModels('beta', ['m-b3', 'm-b']);
    expect(view.providers.find((p: any) => p.providerId === 'beta').models.map((m: any) => m.modelId)).toEqual([
      'm-b3',
      'm-b',
      'm-b2x',
    ]);

    await svc.deletePersonalModel('beta', 'm-b3');
    expect(Object.keys(readConfig(home).providers.beta.models)).toEqual(['m-b', 'm-b2x']);
    await expect(svc.deletePersonalModel('beta', 'm-b3')).rejects.toThrow(/不存在/);
    rmSync(home, { recursive: true, force: true });
  });

  it('reorderPersonalProviders 影响 providerOrder；deletePersonalProvider 同步删密钥与 UI 位', async () => {
    const home = makeHome();
    const svc: any = createProviderSettingsService({ home });
    await svc.savePersonalProviderOverlay('alpha', {
      protocol: 'openai',
      baseUrl: 'https://a.example/v1',
      apiKey: SECRET,
      models: { 'm-a': {} },
    });
    // _h2Ui 位种子（ZS4.5e）：确保删除时一并回收
    await svc.addPersonalModel('alpha', 'm-ui', { properties: { inputFormat: { supportsImage: true } } });
    let view: any = await svc.reorderPersonalProviders(['beta', 'alpha']);
    expect(view.providerOrder).toEqual(['beta', 'alpha']);
    view = await svc.deletePersonalProvider('alpha');
    expect(view.providers.map((p: any) => p.providerId)).toEqual(['beta']);
    // 密钥同步清理（ZS5-T5 A）：auth.json 不再含该 provider 键
    expect(readAuth(home).channels?.alpha).toBeUndefined();
    // config 无幽灵
    expect(readConfig(home).providers.alpha).toBeUndefined();
    // _h2Ui 回收
    expect(readConfig(home)._h2Ui?.alpha).toBeUndefined();
    await expect(svc.deletePersonalProvider('alpha')).rejects.toThrow(/不存在/);
    rmSync(home, { recursive: true, force: true });
  });

  it('savePersonalModelDraft：合并配置 + rename + 剥密钥 + revision 冲突拒绝', async () => {
    const home = makeHome();
    const svc: any = createProviderSettingsService({ home });
    const v0: any = await svc.getView();
    await svc.savePersonalModelDraft({
      providerId: 'beta',
      originalModelId: 'm-b',
      nextModelId: 'm-b-new',
      personalConfig: { contextWindow: 2048, apiKey: SECRET },
      basedOnRevision: v0.revision,
    });
    const cfg = readConfig(home);
    expect(cfg.providers.beta.models['m-b-new'].contextWindow).toBe(2048);
    expect('apiKey' in cfg.providers.beta.models['m-b-new']).toBe(false);
    expect(JSON.stringify(cfg)).not.toContain(SECRET);
    const v1: any = await svc.getView();
    await expect(
      svc.savePersonalModelDraft({
        providerId: 'beta',
        originalModelId: 'm-b2',
        nextModelId: 'm-b2',
        personalConfig: {},
        basedOnRevision: v1.revision - 5,
      }),
    ).rejects.toThrow(/revision 冲突/);
    rmSync(home, { recursive: true, force: true });
  });

  it('onDidChange：每次写操作广播最新视图', async () => {
    const home = makeHome();
    const svc: any = createProviderSettingsService({ home });
    const seen: any[] = [];
    const sub: any = svc.onDidChange((view: any) => seen.push(view));
    await svc.addPersonalModel('alpha', 'm-a2');
    await svc.deletePersonalModel('alpha', 'm-a2');
    expect(seen.length).toBe(2);
    expect(seen[0].providers.find((p: any) => p.providerId === 'alpha').models.length).toBe(2);
    expect(seen[1].providers.find((p: any) => p.providerId === 'alpha').models.length).toBe(1);
    sub.dispose();
    await svc.addPersonalModel('alpha', 'm-a3');
    expect(seen.length).toBe(2); // dispose 后不再收
    rmSync(home, { recursive: true, force: true });
  });

  it('testModelConnectivity：provider/model 不存在早退；无密钥早退；坏渠道 request-failed 且消息不含密钥', async () => {
    const home = makeHome({
      providers: {
        dead: { protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: { 'm-d': {} } },
      },
      roles: {},
    });
    writeFileSync(join(home, '.harness2', 'auth.json'), JSON.stringify({ channels: { dead: { apiKey: SECRET } } }));
    const svc: any = createProviderSettingsService({ home });
    let r: any = await svc.testModelConnectivity({ providerId: 'nope', modelId: 'x' });
    expect(r).toEqual({ success: false, error: expect.objectContaining({ code: 'provider-unavailable' }) });
    r = await svc.testModelConnectivity({ providerId: 'dead', modelId: 'not-declared' });
    expect(r.success).toBe(false);
    expect(r.error.code).toBe('model-unavailable');
    r = await svc.testModelConnectivity({ providerId: 'dead', modelId: 'm-d' });
    expect(r.success).toBe(false);
    expect(typeof r.error.message).toBe('string');
    expect(r.error.message).not.toContain(SECRET);
    rmSync(home, { recursive: true, force: true });
  }, 30_000);

  it('resolveModelConfig：缺容量→inherited 注 core 兜底 DEFAULT_CONTEXT_WINDOW（仅返回值不写盘）；effective=磁盘配置；personalConfig 覆盖优先', async () => {
    const home = makeHome();
    const svc: any = createProviderSettingsService({ home });
    const { DEFAULT_CONTEXT_WINDOW } = await import('../src/real/core-bridge.js');
    expect(DEFAULT_CONTEXT_WINDOW).toBe(128 * 1024); // 钉住与 core compaction 兜底同源
    const r: any = await svc.resolveModelConfig({ providerId: 'alpha', modelId: 'm-a' });
    // m-a 磁盘空对象 → ZS4.5e 合成全形状：徽章判据字段恒非空（inputFormat 五模态/
    // outputFormat）+ 容量回退 DEFAULT_CONTEXT_WINDOW + disabled 档位占位。
    expect(r.inheritedConfig).toEqual({
      properties: {
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
      },
      optionSpecs: { reasoningLevel: { values: ['disabled'], map: '{}' } },
    });
    // 徽章完整性谓词（ProviderCardSections.tsx:502-509 同款）必须为真
    const p = r.inheritedConfig.properties;
    const complete =
      p.contextWindow != null &&
      p.inputFormat.supportsText != null &&
      p.inputFormat.supportsImage != null &&
      p.inputFormat.supportsVideo != null &&
      p.inputFormat.supportsAudio != null &&
      p.inputFormat.supportsPdf != null &&
      p.outputFormat.supportsText != null;
    expect(complete).toBe(true);
    expect(r.issues).toEqual([]);
    // 不写盘：config.json 的 m-a 仍空；视图出站=ZS4.5e 合成完整形（徽章判据全字段，
    // contextWindow 回退 DEFAULT——行上不再挂「模型配置不完整」）
    expect(readConfig(home).providers.alpha.models['m-a']).toEqual({});
    const view: any = await svc.getView();
    const ma = view.providers.find((p: any) => p.providerId === 'alpha').models.find((m: any) => m.modelId === 'm-a');
    expect(ma.effectiveConfig.properties.inputFormat.supportsText).toBe(true);
    expect(ma.effectiveConfig.properties.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    const r2: any = await svc.resolveModelConfig({
      providerId: 'beta',
      modelId: 'm-b',
      personalConfig: { properties: { contextWindow: 4096 } },
    });
    // personal 覆盖 contextWindow；inherited 合成全形状（徽章字段+disabled 占位）保留
    expect(r2.effectiveConfig).toEqual({
      properties: {
        contextWindow: 4096,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
      },
      optionSpecs: { reasoningLevel: { values: ['disabled'], map: '{}' } },
    });
    // 编辑保存→内容回放（ZS4.5e bug② 回归钉）：用户显式模态勾选+映射表达式落 `_h2Ui`，
    // 视图出站与对话框基线都回放出来；core 扁平键（contextWindow）走磁盘正路。
    const edited = {
      properties: { contextWindow: 200000, inputFormat: { supportsText: true, supportsImage: true } },
      optionSpecs: { reasoningLevel: { values: ['low', 'high'], map: '{"thinking": true}' } },
    };
    const rev: any = await svc.getView();
    await svc.savePersonalModelDraft({
      providerId: 'beta',
      originalModelId: 'm-b',
      nextModelId: 'm-b',
      personalConfig: edited,
      basedOnRevision: rev.revision,
    });
    const cfgB = readConfig(home).providers.beta.models['m-b'];
    expect(cfgB.contextWindow).toBe(200000); // core 扁平键落盘
    expect('inputFormat' in cfgB).toBe(false); // UI 专属不进 core 条目（零告警纪律）
    const viewB: any = await svc.getView();
    const rowB = viewB.providers.find((p: any) => p.providerId === 'beta').models.find((m: any) => m.modelId === 'm-b');
    expect(rowB.effectiveConfig.properties.inputFormat.supportsImage).toBe(true); // 勾选回放
    expect(rowB.effectiveConfig.optionSpecs.reasoningLevel.values).toEqual(['low', 'high']);
    expect(rowB.effectiveConfig.optionSpecs.reasoningLevel.map).toBe('{"thinking": true}'); // 映射回放
    const r4: any = await svc.resolveModelConfig({ providerId: 'beta', modelId: 'm-b' });
    expect(r4.inheritedConfig.properties.inputFormat.supportsImage).toBe(true);
    await expect(svc.resolveModelConfig({ providerId: 'nope', modelId: 'x' })).rejects.toThrow(/不存在/);
    rmSync(home, { recursive: true, force: true });
  });

  it('revisionClock：草稿 create 不落盘也推视图 revision；乐观并发判据与视图同源（ZS4-T6 P0 钉）', async () => {
    const home = makeHome();
    const svc: any = createProviderSettingsService({ home });
    const v0: any = await svc.getView();
    // 空 baseUrl → 只进内存草稿，config.json 不动
    const v1: any = (await svc.createPersonalProvider({ providerName: 'draft-x' })).view; // 契约返回 {providerId, view}
    expect(readConfig(home).providers.alpha).toBeDefined();
    expect(Object.keys(readConfig(home).providers)).toEqual(['alpha', 'beta']);
    const draft = v1.providers.find((p: any) => p.providerName === 'draft-x');
    expect(draft).toBeDefined();
    expect(v1.revision).toBeGreaterThan(v0.revision);
    // UI 拿到的视图 revision=时钟值；若判据仍拿文件值（没涨）比较 → 误判冲突（P0 回归点）
    await svc.savePersonalModelDraft({
      providerId: 'beta',
      originalModelId: 'm-b',
      nextModelId: 'm-b',
      personalConfig: { properties: { contextWindow: 128 } },
      basedOnRevision: v1.revision,
    });
    await expect(
      svc.savePersonalModelDraft({
        providerId: 'beta',
        originalModelId: 'm-b',
        nextModelId: 'm-b',
        personalConfig: {},
        basedOnRevision: v1.revision, // 已被上一次 mutation 推高 → 必须拒绝
      }),
    ).rejects.toThrow(/revision 冲突/);
    rmSync(home, { recursive: true, force: true });
  });
});
