// @vitest-environment jsdom
// P6-B 模型配置页渲染端验收（D-50～D-59）——**本阶段唯一硬指标：完全不手改文件闭环**。
//
// 手法：渲染真 `ModelsSettings`，通道面 = **真主进程函数**（`src/main/models-config.js`）+
// 临时 home/root 目录；只有网络（发现模型）与设置域事件是桩。于是本文件的断言直接落在
// **真实落盘的文件**上：auth.json 独占密钥、config.json 只有具名引用、覆层只放显示名。
//
// 逐条落点：
//   D-50 提供方行 / 一次只展开一张卡 / 未配置整节首次直接展开
//   D-51 单一密钥输入框、只写、派生 <ROUTE>_API_KEY、配置文件零密钥值（反向断言）
//   D-52 状态点保守规则 + 成功后无障碍消息不回显机密
//   D-53 自定义折叠区（显示名 / baseURL / 模型目录 / 协议），Provider ID 编辑态不可改
//   D-54 提供方级不放推理等级
//   D-55/D-56 获取可用模型 → 可搜索选择器 → 添加所选才写入；搜索匹配 id 与显示名
//   D-57 校验就地阻断（密钥粘贴形态 / 空 id / 端点语法）
//   D-58 revision 冲突 → settings/conflict 且刷新文档重试
//   D-59 删除仅用户层独有 + 确认框指名；项目层携带不可删
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ModelsProviderInputShape, ModelsSettingsApi, SettingsEventFrame } from '../../../src/shared/protocol.js';
import {
  ackModelsDeclaration,
  deleteModelsProvider,
  discoverModelsFor,
  MODELS_OVERLAY_FILE,
  readCredentialStatuses,
  readModelsDocument,
  updateModelsProvider,
  writeChannelKey,
} from '../../../src/main/models-config.js';
import { ModelsSettings } from '../../../src/renderer/settings/models/ModelsSettings.js';

const HARNESS_DIR = '.harness2';
const KEY_VALUE = 'sk-fixture-secret-abcdef123456';

const dirs: string[] = [];
afterEach(() => {
  cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const homePath = (home: string, file: string): string => join(home, HARNESS_DIR, file);
const configText = (home: string): string =>
  existsSync(homePath(home, 'config.json')) ? readFileSync(homePath(home, 'config.json'), 'utf8') : '';
const overlayText = (home: string): string =>
  existsSync(homePath(home, MODELS_OVERLAY_FILE)) ? readFileSync(homePath(home, MODELS_OVERLAY_FILE), 'utf8') : '';
const authText = (home: string): string =>
  existsSync(homePath(home, 'auth.json')) ? readFileSync(homePath(home, 'auth.json'), 'utf8') : '';

/**
 * 展开某行。注意：D-50 的自动展开是 effect 驱动的，`findByRole` 可能在 effect 提交前就拿到节点，
 * 此时读到 aria-expanded=false 而实际状态已是展开 —— 直接点会把它收起。故用重试式断言收敛到展开态。
 */
async function expandRow(name: RegExp): Promise<void> {
  const head = await screen.findByRole('button', { name });
  await waitFor(() => {
    if (head.getAttribute('aria-expanded') !== 'true') fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
  });
}

/** 首运行的声明弹窗（每个用例都先过一遍：它是真弹窗，不点走不到页面） */
async function passDeclaration(): Promise<void> {
  expect(await screen.findByRole('dialog', { name: '模型配置声明' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '我已了解' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '模型配置声明' })).toBeNull());
}

interface Harness {
  api: Partial<ModelsSettingsApi>;
  home: string;
  root: string;
  fetchCalls: Array<{ url: string; init: RequestInit }>;
  /** 让「获取可用模型」返回固定目录 */
  respondWith?: (url: string) => Response | Promise<Response>;
}

/** 通道面 = 真主进程函数（临时 home/root）；网络是桩（记录 URL 与请求头）
 *
 * P2-4：所有读视图通道**显式注入受控 env（空表）** —— 开发机恰好导出了
 * `LOCAL_OAI_API_KEY` / `B_KEY` 之类的引用名时，凭据三态断言不得翻转；CI 与开发机同结果。
 */
function harness(): Harness {
  const home = tmp('h2-page-home-');
  const root = tmp('h2-page-root-');
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const h: Harness = { home, root, fetchCalls, api: {} };
  h.api = {
    settingsGetModels: () => Promise.resolve(readModelsDocument(home, root, {})),
    settingsUpdateModels: (opts) => Promise.resolve(updateModelsProvider(home, root, opts)),
    settingsDeleteProvider: (route, confirmRoute) =>
      Promise.resolve(deleteModelsProvider(home, root, { route, confirmRoute })),
    settingsWriteChannelKey: (route, key) => Promise.resolve(writeChannelKey(home, root, route, key)),
    settingsGetCredentialStatus: (routes) => Promise.resolve(readCredentialStatuses(home, root, routes, {})),
    settingsAckModelsDeclaration: (version) => Promise.resolve(ackModelsDeclaration(home, version)),
    settingsDiscoverModels: (input) =>
      Promise.resolve(
        discoverModelsFor(
          home,
          root,
          input,
          (url, init) => {
            fetchCalls.push({ url, init });
            return Promise.resolve(
              h.respondWith?.(url) ??
                new Response(
                  JSON.stringify({ data: [{ id: 'big-pickle', display_name: 'Big Pickle' }, { id: 'plain' }] }),
                  {
                    status: 200,
                  },
                ),
            );
          },
          {},
        ),
      ),
    onSettingsEvent: () => () => {},
  };
  return h;
}

/** jsdom 不保证 AbortSignal.timeout（发现模型内部用它做超时）：缺失时换成等价可控信号 */
if (typeof (globalThis.AbortSignal as { timeout?: unknown }).timeout !== 'function') {
  vi.stubGlobal('AbortSignal', { timeout: () => new AbortController().signal });
}

function providerInput(over: Partial<ModelsProviderInputShape> = {}): ModelsProviderInputShape {
  return {
    id: 'local-oai',
    displayName: '本地统一网关',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:40080/v1',
    models: [{ id: 'big-pickle', contextWindow: 200000 }],
    ...over,
  };
}

describe('D-50/D-51/D-55/D-56：完全不手改文件的闭环（UI 内建好并真实生效）', () => {
  it('新增提供方 → 配密钥 → 发现模型 → 保存 → 落盘生效；密钥只进 auth.json', async () => {
    const h = harness();
    render(<ModelsSettings api={h.api} />);
    await passDeclaration();
    expect(readModelsDocument(h.home, h.root, {}).declarationAckVersion).toBe(1); // 声明确实落盘

    // ① 新增提供方（Provider ID 可编辑）
    fireEvent.click(await screen.findByRole('button', { name: '新增提供方' }));
    fireEvent.change(await screen.findByLabelText('Provider ID'), { target: { value: 'local-oai' } });
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '本地统一网关' } });
    fireEvent.change(screen.getByLabelText('端点 baseURL'), { target: { value: 'http://127.0.0.1:40080/v1' } });

    // ② 配密钥：单一输入框，只写不回显
    const keyInput = screen.getByLabelText('API 密钥') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: KEY_VALUE } });
    fireEvent.click(screen.getByRole('button', { name: '保存密钥' }));
    await waitFor(() => expect(authText(h.home)).toContain(KEY_VALUE));
    await waitFor(() => expect((screen.getByLabelText('API 密钥') as HTMLInputElement).value).toBe(''));
    expect(document.body.textContent).not.toContain(KEY_VALUE); // 不回显
    expect(screen.getByRole('status').textContent).toContain('LOCAL_OAI_API_KEY'); // 只报具名引用
    expect(configText(h.home)).not.toContain(KEY_VALUE); // 此刻 config.json 还没建（保存卡才写它）

    // ③ 发现模型：拿表单当前端点 + 已存凭据（渲染端不回传明文）
    fireEvent.click(screen.getByRole('button', { name: '获取可用模型' }));
    const selector = await screen.findByRole('group', { name: /可添加的模型（local-oai）/ });
    expect(selector).toBeTruthy();
    expect(h.fetchCalls[0]?.url).toBe('http://127.0.0.1:40080/v1/models');
    expect((h.fetchCalls[0]?.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${KEY_VALUE}`);

    // D-56 搜索同时匹配 id 与显示名
    fireEvent.change(screen.getByLabelText('搜索模型（id 或显示名）'), { target: { value: 'pickle' } });
    expect(screen.getByLabelText('选择模型 big-pickle')).toBeTruthy();
    expect(screen.queryByLabelText('选择模型 plain')).toBeNull();

    // ④ 添加所选才写入目录
    fireEvent.click(screen.getByLabelText('选择模型 big-pickle'));
    fireEvent.click(screen.getByRole('button', { name: '添加所选' }));
    expect(await screen.findByDisplayValue('big-pickle')).toBeTruthy();

    // ⑤ 保存：写用户层 config.json（只有具名引用）+ 显示名进覆层
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(readModelsDocument(h.home, h.root, {}).providers.map((p) => p.id)).toEqual(['local-oai']),
    );

    const cfg = configText(h.home);
    expect(cfg).toContain('"envKey": "LOCAL_OAI_API_KEY"');
    expect(cfg).not.toContain('本地统一网关'); // config 里没有显示名字段（core 冻结区）
    expect(cfg).not.toContain(KEY_VALUE);
    expect(cfg).not.toMatch(/sk-[A-Za-z0-9_-]{6,}/); // 反向断言：配置文件零密钥值
    expect(overlayText(h.home)).toContain('本地统一网关');
    expect(authText(h.home)).toContain(KEY_VALUE);

    // ⑥ 真实生效：核心读视图确认凭据 + 模型目录 + 首次展开的卡已收起为行
    const doc = readModelsDocument(h.home, h.root, {});
    expect(doc.providers[0]?.credential).toEqual({
      state: 'confirmed',
      source: 'auth.json',
      reference: 'LOCAL_OAI_API_KEY',
    });
    expect(doc.providers[0]?.models).toEqual([{ id: 'big-pickle' }]);
    expect(doc.providers[0]?.deletable).toBe(true);
    // 全流程零手改文件：除 UI 动作外没有别的写入者（文件时间线在断言里已逐项对齐）
  });

  it('D-56：全选只加可见结果、取消全选清空全部、隐藏项勾选不被搜索清掉', async () => {
    const h = harness();
    h.respondWith = () =>
      new Response(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }] }), { status: 200 });
    render(<ModelsSettings api={h.api} />);
    await passDeclaration();
    fireEvent.click(await screen.findByRole('button', { name: '新增提供方' }));
    fireEvent.change(await screen.findByLabelText('Provider ID'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'P1' } });
    fireEvent.change(screen.getByLabelText('端点 baseURL'), { target: { value: 'https://p.test/v1' } });
    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: KEY_VALUE } });
    fireEvent.click(screen.getByRole('button', { name: '保存密钥' }));
    await waitFor(() => expect(authText(h.home)).toContain(KEY_VALUE));
    fireEvent.click(screen.getByRole('button', { name: '获取可用模型' }));
    await screen.findByRole('group', { name: /可添加的模型/ });

    // 搜索隐藏 beta 后勾 alpha，beta 的勾选不受影响
    fireEvent.click(screen.getByLabelText('选择模型 beta'));
    fireEvent.change(screen.getByLabelText('搜索模型（id 或显示名）'), { target: { value: 'alpha' } });
    expect(screen.queryByLabelText('选择模型 beta')).toBeNull();
    fireEvent.click(screen.getByLabelText('全选可见结果'));
    fireEvent.change(screen.getByLabelText('搜索模型（id 或显示名）'), { target: { value: '' } });
    expect((screen.getByLabelText('选择模型 alpha') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('选择模型 beta') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('选择模型 gamma') as HTMLInputElement).checked).toBe(false);

    // 取消全选清空全部（含刚才被隐藏过的项）
    fireEvent.click(screen.getByRole('button', { name: '取消全选' }));
    expect((screen.getByLabelText('选择模型 alpha') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('选择模型 beta') as HTMLInputElement).checked).toBe(false);
  });

  it('D-55：已有行保留用户调过的值（合并只追加新 id，不覆盖容量）', async () => {
    const h = harness();
    // 先落一个带容量的既有行
    const seed = updateModelsProvider(h.home, h.root, {
      revision: readModelsDocument(h.home, h.root, {}).revision,
      provider: providerInput({ models: [{ id: 'big-pickle', contextWindow: 123456 }] }),
    });
    expect(seed.ok).toBe(true);
    writeChannelKey(h.home, h.root, 'local-oai', KEY_VALUE); // 发现模型需要已存凭据
    render(<ModelsSettings api={h.api} />);
    await passDeclaration();
    await expandRow(/本地统一网关/);
    fireEvent.click(screen.getByRole('button', { name: '获取可用模型' }));
    await screen.findByRole('group', { name: /可添加的模型/ });
    fireEvent.click(screen.getByLabelText('选择模型 big-pickle'));
    fireEvent.click(screen.getByLabelText('选择模型 plain'));
    fireEvent.click(screen.getByRole('button', { name: '添加所选' }));

    // 合并只改表单（未保存不落盘）：plain 追加、big-pickle 的容量保持用户值
    expect(await screen.findByDisplayValue('plain')).toBeTruthy();
    expect((screen.getByLabelText('模型 1 上下文窗口') as HTMLInputElement).value).toBe('123456');
    // 保存后容量仍是用户调过的值（未被打回默认）
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(readModelsDocument(h.home, h.root, {}).providers[0]?.models).toEqual([
        { id: 'big-pickle', contextWindow: 123456 },
        { id: 'plain' },
      ]),
    );
  });
});

describe('D-50/D-52/D-53/D-54：卡片形态与保守状态', () => {
  it('未配置的整节提供方首次直接渲染为展开卡；一次只展开一张', async () => {
    const h = harness();
    // 未配置 = 凭据未确认 **且** 尚无模型（D-50 的「整节提供方」口径）
    updateModelsProvider(h.home, h.root, {
      revision: readModelsDocument(h.home, h.root, {}).revision,
      provider: providerInput({ id: 'a', displayName: 'A', models: [] }),
    });
    updateModelsProvider(h.home, h.root, {
      revision: readModelsDocument(h.home, h.root, {}).revision,
      provider: providerInput({ id: 'b', displayName: 'B', models: [] }),
    });
    ackModelsDeclaration(h.home, 1);
    render(<ModelsSettings api={h.api} />);

    // a 自动展开
    expect(await screen.findByLabelText('Provider ID')).toBeTruthy();
    expect((screen.getByLabelText('Provider ID') as HTMLInputElement).value).toBe('a');
    // 展开 b：a 的卡收起（一次只有一张）
    fireEvent.click(screen.getByRole('button', { name: /B/ }));
    expect((screen.getByLabelText('Provider ID') as HTMLInputElement).value).toBe('b');
    expect(screen.getAllByLabelText('Provider ID')).toHaveLength(1);
  });

  it('D-53/D-54：自定义折叠区含显示名/baseURL/模型目录/协议；Provider ID 编辑态不可改；无推理等级', async () => {
    const h = harness();
    updateModelsProvider(h.home, h.root, {
      revision: readModelsDocument(h.home, h.root, {}).revision,
      provider: providerInput(),
    });
    ackModelsDeclaration(h.home, 1);
    render(<ModelsSettings api={h.api} />);
    await expandRow(/本地统一网关/);

    expect((screen.getByLabelText('Provider ID') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByLabelText('显示名称')).toBeTruthy();
    expect(screen.getByLabelText('端点 baseURL')).toBeTruthy();
    expect(screen.getByLabelText('API 协议')).toBeTruthy();
    expect(screen.getByText('模型目录')).toBeTruthy();
    expect(screen.getByLabelText('主模型（roles.main）')).toBeTruthy();
    // D-54：提供方级不放推理等级（它是按模型的能力）
    expect(screen.queryByText(/推理等级|reasoning.?effort/i)).toBeNull();
    // D-52：状态点保守 —— 卡片保存时派生了具名引用但 auth.json 无条目 → 已确认「引用缺失」（红）
    const dot = document.querySelector('.models-dot');
    expect(dot?.className).toContain('models-dot-bad');
    expect(dot?.getAttribute('aria-label')).toContain('凭据缺失');
    expect(dot?.getAttribute('aria-label')).toContain('LOCAL_OAI_API_KEY');
  });

  it('D-52：auth.json 有条目 → 状态点转绿并只报具名引用（不回显明文）', async () => {
    const h = harness();
    writeChannelKey(h.home, h.root, 'local-oai', KEY_VALUE);
    updateModelsProvider(h.home, h.root, {
      revision: readModelsDocument(h.home, h.root, {}).revision,
      provider: providerInput(),
    });
    ackModelsDeclaration(h.home, 1);
    render(<ModelsSettings api={h.api} />);
    await waitFor(() => expect(document.querySelector('.models-dot')?.className).toContain('models-dot-ok'));
    expect(document.querySelector('.models-dot')?.getAttribute('aria-label')).toContain('LOCAL_OAI_API_KEY');
    expect(document.body.textContent).not.toContain(KEY_VALUE);
  });

  it('P2-6 自定义 envKey：保存密钥后以刷新后的 apiKeyRef 为准，不显示派生引用', async () => {
    const h = harness();
    // CLI / 手写既有场景：config.json 里的 envKey 不是派生名
    mkdirSync(join(h.home, HARNESS_DIR), { recursive: true });
    writeFileSync(
      homePath(h.home, 'config.json'),
      JSON.stringify(
        {
          providers: {
            'local-oai': { protocol: 'openai', baseUrl: 'https://x.test/v1', envKey: 'MY_PERSONAL_KEY' },
          },
          roles: {},
        },
        null,
        2,
      ),
      'utf8',
    );
    ackModelsDeclaration(h.home, 1);
    render(<ModelsSettings api={h.api} />);
    await expandRow(/local-oai/);

    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: KEY_VALUE } });
    fireEvent.click(screen.getByRole('button', { name: '保存密钥' }));
    await waitFor(() => expect(authText(h.home)).toContain(KEY_VALUE));

    // 断言点在**卡片自身的凭据展示**（那是 credentialOverride 的消费处；行头状态点只读权威行，覆盖不到本缺陷）
    const cardHint = (): string => document.querySelector('.models-card .models-hint')?.textContent ?? '';
    await waitFor(() => expect(cardHint()).toContain('具名引用 MY_PERSONAL_KEY'));
    expect(cardHint()).not.toContain('具名引用 LOCAL_OAI_API_KEY');

    // 行头状态点（权威行）同样以 config 里的自定义名为准
    await waitFor(() => expect(document.querySelector('.models-dot')?.className).toContain('models-dot-ok'));
    expect(document.querySelector('.models-dot')?.getAttribute('aria-label')).toContain('MY_PERSONAL_KEY');
  });
});

describe('D-57/D-58：校验就地阻断与并发冲突', () => {
  it('D-57 密钥粘贴形态：就地拒绝（不调写通道），错误文案点名 NAME=value', async () => {
    const h = harness();
    const write = vi.fn(h.api.settingsWriteChannelKey!);
    render(<ModelsSettings api={{ ...h.api, settingsWriteChannelKey: write }} />);
    await passDeclaration();
    fireEvent.click(await screen.findByRole('button', { name: '新增提供方' }));
    fireEvent.change(await screen.findByLabelText('Provider ID'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: `LOCAL_KEY=${KEY_VALUE}` } });
    fireEvent.click(screen.getByRole('button', { name: '保存密钥' }));

    expect(await screen.findByText(/NAME=value/)).toBeTruthy();
    expect(write).not.toHaveBeenCalled();
    expect(authText(h.home)).toBe('');
  });

  it('D-57/D-85 保存前的就地阻断：空 id / 端点语法错误都不调写入通道', async () => {
    const h = harness();
    const update = vi.fn(h.api.settingsUpdateModels!);
    render(<ModelsSettings api={{ ...h.api, settingsUpdateModels: update }} />);
    await passDeclaration();
    fireEvent.click(await screen.findByRole('button', { name: '新增提供方' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('Provider ID 不能为空')).toBeTruthy();
    expect(update).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'ok-id' } });
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'OK' } });
    fireEvent.change(screen.getByLabelText('端点 baseURL'), { target: { value: 'not a url' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect((await screen.findAllByText(/可解析的 http\/https URL/)).length).toBeGreaterThan(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('D-58 revision 冲突：外部改写后再保存 → settings/conflict 文案 + 刷新到最新文档（不盲目覆盖）', async () => {
    const h = harness();
    updateModelsProvider(h.home, h.root, {
      revision: readModelsDocument(h.home, h.root, {}).revision,
      provider: providerInput({ models: [] }),
    });
    ackModelsDeclaration(h.home, 1);
    render(<ModelsSettings api={h.api} />);
    await expandRow(/本地统一网关/);

    // 模拟另一个写入者（CLI / 另一个窗口）改了配置 → revision 前进
    const before = readModelsDocument(h.home, h.root, {});
    expect(
      updateModelsProvider(h.home, h.root, {
        revision: before.revision,
        provider: providerInput({ id: 'other', displayName: 'Other' }),
      }).ok,
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/revision 不一致|并发|已被其他修改改动/)).toBeTruthy();
    // 刷新后拿到最新文档：other 出现在行列表里（未被盲目覆盖）
    expect(await screen.findByRole('button', { name: /Other/ })).toBeTruthy();
    expect(readModelsDocument(h.home, h.root, {}).providers.map((p) => p.id)).toEqual(['local-oai', 'other']);
  });
});

describe('D-59：删除（仅用户层独有 + 确认框指名）', () => {
  it('用户层独有：删除按钮可用 → 确认框指名 → 确认后行消失且恢复组合基线', async () => {
    const h = harness();
    updateModelsProvider(h.home, h.root, {
      revision: readModelsDocument(h.home, h.root, {}).revision,
      provider: providerInput(),
    });
    ackModelsDeclaration(h.home, 1);
    render(<ModelsSettings api={h.api} />);
    await expandRow(/本地统一网关/);
    fireEvent.click(screen.getByRole('button', { name: '删除提供方' }));

    const dialog = await screen.findByRole('dialog', { name: '删除提供方确认' });
    expect(dialog.textContent).toContain('本地统一网关');
    expect(dialog.textContent).toContain('local-oai');
    fireEvent.click(screen.getByRole('button', { name: '删除「local-oai」' }));

    await waitFor(() => expect(readModelsDocument(h.home, h.root, {}).providers).toEqual([]));
    expect(configText(h.home)).not.toContain('local-oai');
    expect(screen.queryByRole('button', { name: /本地统一网关/ })).toBeNull();
  });

  it('项目层携带的行：删除按钮禁用并给出可行动原因（不摆可点的假入口）', async () => {
    const h = harness();
    mkdirSync(join(h.root, HARNESS_DIR), { recursive: true });
    writeFileSync(
      join(h.root, HARNESS_DIR, 'config.json'),
      JSON.stringify({ providers: { proj: { protocol: 'openai', baseUrl: 'https://p.test/v1' } }, roles: {} }),
      'utf8',
    );
    ackModelsDeclaration(h.home, 1);
    render(<ModelsSettings api={h.api} />);
    await expandRow(/proj/);

    const del = screen.getByRole('button', { name: '删除提供方' }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(document.body.textContent).toContain('项目配置携带');
  });
});

describe('D-59 首运行：两个有序弹窗', () => {
  it('声明确认后仍有待配凭据的提供方 → 第二步「配置凭据」；点「去配置密钥」展开该提供方', async () => {
    const h = harness();
    updateModelsProvider(h.home, h.root, {
      revision: readModelsDocument(h.home, h.root, {}).revision,
      provider: providerInput({ models: [] }),
    });
    render(<ModelsSettings api={h.api} />);
    fireEvent.click(await screen.findByRole('button', { name: '我已了解' }));

    // P1-1：声明确认会落盘并触发 reload（IPC 往返）→ 第二步弹窗必须**仍然可达**。
    // 等一轮宏任务让 reload 的微任务链与新 doc 的 effect 全部提交，再断言第二步还在。
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() => expect(readModelsDocument(h.home, h.root, {}).declarationAckVersion).toBe(1));
    const step2 = await screen.findByRole('dialog', { name: '配置凭据' });
    expect(step2.textContent).toContain('local-oai');
    fireEvent.click(screen.getByRole('button', { name: '去配置密钥' }));
    expect(await screen.findByLabelText('API 密钥')).toBeTruthy();
    // 用户动作（去配置）才关弹窗链
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '配置凭据' })).toBeNull());
  });

  it('没有待配凭据的提供方 → 声明后直接结束（不打扰）', async () => {
    const h = harness();
    writeChannelKey(h.home, h.root, 'local-oai', KEY_VALUE);
    updateModelsProvider(h.home, h.root, {
      revision: readModelsDocument(h.home, h.root, {}).revision,
      provider: providerInput(),
    });
    render(<ModelsSettings api={h.api} />);
    fireEvent.click(await screen.findByRole('button', { name: '我已了解' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '配置凭据' })).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('诚实性：通道缺失时如实降级', () => {
  it('主进程未提供模型配置通道 → 显式说明，不摆假入口', async () => {
    render(<ModelsSettings api={{}} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/未提供模型配置通道/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '新增提供方' })).toBeNull();
  });

  it('D-51：卡片只问密钥值本身，从不询问环境变量名（引用名由系统派生）', async () => {
    const h = harness();
    ackModelsDeclaration(h.home, 1);
    render(<ModelsSettings api={h.api} />);
    fireEvent.click(await screen.findByRole('button', { name: '新增提供方' }));
    expect(screen.queryByLabelText(/环境变量名/)).toBeNull();
    expect(screen.queryByText(/envKey/)).toBeNull();
    // 提示里给的是派生的引用名（只读展示），不是让用户填的字段
    expect(screen.getByText(/自动派生/)).toBeTruthy();
  });

  it('D-58：订阅设置域事件（无事件时不轮询；事件到达即重新拉文档）', async () => {
    const h = harness();
    const listeners: Array<(frame: SettingsEventFrame) => void> = [];
    const getModels = vi.fn(h.api.settingsGetModels!);
    render(
      <ModelsSettings
        api={{
          ...h.api,
          settingsGetModels: getModels,
          onSettingsEvent: (listener) => {
            listeners.push(listener);
            return () => {
              listeners.splice(listeners.indexOf(listener), 1);
            };
          },
        }}
      />,
    );
    await passDeclaration();
    const afterLoad = getModels.mock.calls.length;
    expect(afterLoad).toBeGreaterThan(0);
    expect(listeners.length).toBe(1);

    // 轮询会随时间自行增长；等一轮宏任务后调用次数不变 = 确实只在事件驱动下取数
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getModels.mock.calls.length).toBe(afterLoad);

    // 四个事件类型都经同一条通道触发重取（这里取其一）
    act(() => {
      for (const listener of [...listeners]) listener({ type: 'settings/document-updated', revision: 'r2' });
    });
    expect(getModels.mock.calls.length).toBeGreaterThan(afterLoad);
  });
});

describe('D-55：发现模型拿表单当前端点（不是已保存端点）', () => {
  it('编辑既有行：已保存端点 ≠ 表单端点 → 发现请求打向表单端点；表单改动不落盘', async () => {
    const h = harness();
    updateModelsProvider(h.home, h.root, {
      revision: readModelsDocument(h.home, h.root, {}).revision,
      provider: providerInput({ baseUrl: 'http://127.0.0.1:1111/v1' }),
    });
    writeChannelKey(h.home, h.root, 'local-oai', KEY_VALUE); // 发现模型需要已存凭据
    ackModelsDeclaration(h.home, 1);
    render(<ModelsSettings api={h.api} />);
    await expandRow(/本地统一网关/);

    // 表单改到另一个端点（尚未保存）后点「获取可用模型」
    fireEvent.change(screen.getByLabelText('端点 baseURL'), { target: { value: 'http://127.0.0.1:2222/v1' } });
    fireEvent.click(screen.getByRole('button', { name: '获取可用模型' }));
    await screen.findByRole('group', { name: /可添加的模型/ });

    expect(h.fetchCalls[0]?.url).toBe('http://127.0.0.1:2222/v1/models'); // 表单端点，不是保存的 1111
    // 表单改动只在内存：权威文档仍是已保存端点（发现不等于保存）
    expect(readModelsDocument(h.home, h.root, {}).providers[0]?.baseUrl).toBe('http://127.0.0.1:1111/v1');
  });
});

describe('D-58：四类设置域事件同一订阅面 + 无轮询', () => {
  it('四类事件各触发一次重取；空转一分钟不产生任何额外拉取', async () => {
    const h = harness();
    ackModelsDeclaration(h.home, 1);
    const listeners: Array<(frame: SettingsEventFrame) => void> = [];
    const getModels = vi.fn(h.api.settingsGetModels!);
    render(
      <ModelsSettings
        api={{
          ...h.api,
          settingsGetModels: getModels,
          onSettingsEvent: (listener) => {
            listeners.push(listener);
            return () => {
              const i = listeners.indexOf(listener);
              if (i >= 0) listeners.splice(i, 1);
            };
          },
        }}
      />,
    );
    await waitFor(() => expect(getModels.mock.calls.length).toBeGreaterThan(0));
    expect(listeners).toHaveLength(1);

    const frames: SettingsEventFrame[] = [
      { type: 'settings/document-updated', revision: 'r2' },
      { type: 'credentials/reference-updated', route: 'local-oai' },
      { type: 'llm/adapters-updated' },
      { type: 'connection/reset' },
    ];
    for (const frame of frames) {
      const before = getModels.mock.calls.length;
      act(() => {
        for (const listener of [...listeners]) listener(frame);
      });
      await waitFor(() => expect(getModels.mock.calls.length).toBe(before + 1));
    }

    // 无轮询：推进假时钟一分钟（无事件），拉取次数一分不涨
    const settled = getModels.mock.calls.length;
    vi.useFakeTimers();
    try {
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(getModels.mock.calls.length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('D-59：组合基线行不可删（页面层）', () => {
  it('两层同 id：行如实标层并列，删除按钮禁用并说明由项目配置携带', async () => {
    const h = harness();
    updateModelsProvider(h.home, h.root, {
      revision: readModelsDocument(h.home, h.root, {}).revision,
      provider: providerInput({ displayName: '两端同 id' }),
    });
    mkdirSync(join(h.root, HARNESS_DIR), { recursive: true });
    writeFileSync(
      join(h.root, HARNESS_DIR, 'config.json'),
      JSON.stringify({ providers: { 'local-oai': { protocol: 'openai', baseUrl: 'https://p.test/v1' } }, roles: {} }),
      'utf8',
    );
    ackModelsDeclaration(h.home, 1);
    render(<ModelsSettings api={h.api} />);
    await expandRow(/两端同 id/);

    const del = screen.getByRole('button', { name: '删除提供方' }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(document.body.textContent).toContain('用户层 + 项目层');
    expect(document.body.textContent).toContain('项目配置携带');
  });
});

describe('D-85：存量端点的就地诊断（编辑器保持打开）', () => {
  it('已保存端点语法错误：行仍可展开，保存被拒后就地展示端点诊断且不调写入通道', async () => {
    const h = harness();
    updateModelsProvider(h.home, h.root, {
      revision: readModelsDocument(h.home, h.root, {}).revision,
      provider: providerInput({ baseUrl: 'https://ok.test/v1' }),
    });
    ackModelsDeclaration(h.home, 1);
    // 外部把端点改坏（模拟存量错误目录；revision 变化不影响本次就地阻断）
    const raw = JSON.parse(configText(h.home)) as { providers: Record<string, { baseUrl: string }> };
    raw.providers['local-oai']!.baseUrl = 'not a url';
    writeFileSync(homePath(h.home, 'config.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    const update = vi.fn(h.api.settingsUpdateModels!);
    render(<ModelsSettings api={{ ...h.api, settingsUpdateModels: update }} />);
    await expandRow(/本地统一网关/);
    expect((screen.getByLabelText('端点 baseURL') as HTMLInputElement).value).toBe('not a url'); // 诊断源可见

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect((await screen.findAllByText(/可解析的 http\/https URL/)).length).toBeGreaterThan(0);
    expect(update).not.toHaveBeenCalled(); // 就地阻断，不调写入通道
    // 编辑器保持打开（仍在编辑态）+ 删除入口仍在（用户层独有）
    expect(screen.getByLabelText('Provider ID')).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除提供方' })).toBeTruthy();
  });
});
