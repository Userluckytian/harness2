// 模型配置页**渲染端纯逻辑**单测（D-50/D-52/D-53/D-59）：
//   `src/renderer/settings/models/model-document.ts` 的展示映射与首运行判定此前只被页面级用例间接覆盖，
//   本文件把它拉到单元层（不猜色调 / 自动展开只做一次 / 条件式凭据步）。
//   另加一条**跨端不变量**：凭据引用派生（`<ROUTE>_API_KEY`）在主进程与渲染端各有一份实现，
//   这里逐路由断言两边同结果，防止改名漂移（与 models-validation-parity 同思路）。
import { describe, expect, it } from 'vitest';
import type { ModelsDocumentShape, ModelsProviderRowShape } from '../../../src/shared/protocol.js';
import {
  MODELS_DECLARATION_VERSION,
  credentialPresentation,
  deriveApiKeyRef as rendererDeriveApiKeyRef,
  documentProviderIds,
  firstRunStep,
  isUnconfiguredProvider,
  layerLabel,
  providersNeedingCredential,
  shouldAutoExpand,
} from '../../../src/renderer/settings/models/model-document.js';
import { deriveApiKeyRef as mainDeriveApiKeyRef } from '../../../src/main/models-config.js';
import {
  deselectAll,
  filterDiscovery,
  mergeDiscoveredModels,
  newSelectedCount,
  selectAllVisible,
  toggleDiscoverySelection,
} from '../../../src/renderer/settings/models/discover.js';

function row(over: Partial<ModelsProviderRowShape> = {}): ModelsProviderRowShape {
  return {
    id: 'p',
    displayName: 'P',
    protocol: 'openai',
    baseUrl: 'https://p.test/v1',
    models: [],
    layers: ['user'],
    deletable: true,
    credential: { state: 'unknown' },
    ...over,
  };
}

describe('D-52：状态点文案与色调（保守，不猜）', () => {
  it('confirmed（auth.json / env）→ 绿；detail 只给来源与具名引用', () => {
    const viaAuth = credentialPresentation({ state: 'confirmed', source: 'auth.json', reference: 'P_API_KEY' });
    expect(viaAuth.tone).toBe('ok');
    expect(viaAuth.text).toBe('凭据已配置');
    expect(viaAuth.detail).toContain('auth.json');
    expect(viaAuth.detail).toContain('P_API_KEY');

    const viaEnv = credentialPresentation({ state: 'confirmed', source: 'env', reference: 'P_API_KEY' });
    expect(viaEnv.tone).toBe('ok');
    expect(viaEnv.detail).toContain('环境变量');
  });

  it('missing → 红且点名缺失引用；unknown → 不上色（无确认信息就不猜）', () => {
    const missing = credentialPresentation({ state: 'missing', reference: 'P_API_KEY' });
    expect(missing.tone).toBe('bad');
    expect(missing.text).toBe('凭据缺失');
    expect(missing.detail).toContain('P_API_KEY');

    const unknown = credentialPresentation({ state: 'unknown' });
    expect(unknown.tone).toBe('unknown');
    expect(unknown.text).toBe('凭据未确认');
    expect(unknown.detail).toContain('不猜');
  });
});

describe('D-50：未配置整节判定 + 自动展开只做一次', () => {
  it('未配置 = 凭据未确认 且 尚无模型（有模型就不算「整节未配置」）', () => {
    expect(isUnconfiguredProvider(row())).toBe(true);
    expect(isUnconfiguredProvider(row({ credential: { state: 'missing', reference: 'R' } }))).toBe(true);
    expect(isUnconfiguredProvider(row({ credential: { state: 'confirmed', source: 'auth.json' } }))).toBe(false);
    expect(isUnconfiguredProvider(row({ models: [{ id: 'm' }] }))).toBe(false);
  });

  it('shouldAutoExpand：本会话已渲染过的 id 不再抢焦点（用户收起后不被重新展开）', () => {
    const target = row({ id: 'new-one' });
    expect(shouldAutoExpand(target, new Set())).toBe(true);
    expect(shouldAutoExpand(target, new Set(['new-one']))).toBe(false);
    // 已配置的行本来就不自动展开
    expect(shouldAutoExpand(row({ credential: { state: 'confirmed', source: 'auth.json' } }), new Set())).toBe(false);
  });
});

describe('D-59：首运行顺序与条件式凭据步', () => {
  it('声明版本 = 1；未确认当前版本 → 先过声明，已确认 → none', () => {
    expect(MODELS_DECLARATION_VERSION).toBe(1);
    expect(firstRunStep(0)).toBe('declaration');
    expect(firstRunStep(1)).toBe('none');
    expect(firstRunStep(2)).toBe('none');
  });

  it('providersNeedingCredential 只挑「未确认」的行（凭据步是有条件的，不是每次都弹）', () => {
    const rows = [
      row({ id: 'a', credential: { state: 'unknown' } }),
      row({ id: 'b', credential: { state: 'missing', reference: 'B_API_KEY' } }),
      row({ id: 'c', credential: { state: 'confirmed', source: 'auth.json', reference: 'C_API_KEY' } }),
    ];
    expect(providersNeedingCredential(rows).map((r) => r.id)).toEqual(['a', 'b']);
    expect(providersNeedingCredential([])).toEqual([]);
  });
});

describe('D-53：层归属文案与既有 id 集合', () => {
  it('layerLabel：用户层 / 项目层 / 并列 / 未知', () => {
    expect(layerLabel(['user'])).toBe('用户层');
    expect(layerLabel(['project'])).toBe('项目层');
    expect(layerLabel(['user', 'project'])).toBe('用户层 + 项目层');
    expect(layerLabel([])).toBe('未知层');
  });

  it('documentProviderIds：合入额外 id 且不产生重复（新建草稿 id 与既有行去重）', () => {
    const doc = {
      revision: 'r',
      providers: [row({ id: 'a' }), row({ id: 'b' })],
      declarationAckVersion: 1,
      sources: { global: true, project: false },
      warnings: [],
      errors: [],
    } as ModelsDocumentShape;
    expect(documentProviderIds(doc)).toEqual(['a', 'b']);
    expect(documentProviderIds(doc, ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });
});

describe('凭据引用派生：主进程 ↔ 渲染端同结果（防漂移）', () => {
  it('同一路由在两处派生出同名引用（含数字开头 / 空 / 分隔符归一）', () => {
    for (const route of ['local-oai', 'my.route_x', 'UPPER', '9x', '  9x  ', '', '   ', 'a--b', '中文']) {
      expect(rendererDeriveApiKeyRef(route), route).toBe(mainDeriveApiKeyRef(route));
    }
    // 具名口径抽检（不依赖实现的等价性）
    expect(rendererDeriveApiKeyRef('local-oai')).toBe('LOCAL_OAI_API_KEY');
    expect(rendererDeriveApiKeyRef('9x')).toBe('_9X_API_KEY');
    expect(rendererDeriveApiKeyRef('')).toBe('ROUTE_API_KEY');
  });
});

describe('D-55/D-56：发现模型选择器纯逻辑（搜索 / 勾选 / 全选 / 合并）', () => {
  const catalog = [
    { id: 'big-pickle', displayName: 'Big Pickle' },
    { id: 'plain', displayName: 'plain' },
    { id: 'gamma', displayName: '伽马' },
  ];

  it('搜索同时匹配 id 与显示名（大小写不敏感）；空查询返回全集', () => {
    expect(filterDiscovery(catalog, 'pickle').map((m) => m.id)).toEqual(['big-pickle']); // 显示名命中
    expect(filterDiscovery(catalog, 'PLAIN').map((m) => m.id)).toEqual(['plain']); // id 命中 + 忽略大小写
    expect(filterDiscovery(catalog, '伽马').map((m) => m.id)).toEqual(['gamma']); // 显示名（非 ASCII）
    expect(filterDiscovery(catalog, '  ')).toEqual(catalog); // 空查询 = 全集
    expect(filterDiscovery(catalog, 'nope')).toEqual([]);
  });

  it('勾选作用于全集：搜索隐藏项不改变其勾选', () => {
    let selected: ReadonlySet<string> = new Set<string>();
    selected = toggleDiscoverySelection(selected, 'gamma', true);
    // 搜索只影响可见列表，不动 selected
    expect(filterDiscovery(catalog, 'pickle').map((m) => m.id)).toEqual(['big-pickle']);
    expect(selected.has('gamma')).toBe(true);
    selected = toggleDiscoverySelection(selected, 'gamma', false);
    expect(selected.has('gamma')).toBe(false);
  });

  it('全选仅加可见结果（不碰其它项）；取消全选清空全部（语义刻意不对称）', () => {
    const visible = filterDiscovery(catalog, 'pickle'); // 只有 big-pickle 可见
    let selected: ReadonlySet<string> = new Set(['gamma']); // 先勾一个隐藏项
    selected = selectAllVisible(selected, visible);
    expect([...selected].sort()).toEqual(['big-pickle', 'gamma']); // 隐藏的 gamma 仍在
    selected = deselectAll();
    expect([...selected]).toEqual([]); // 取消全选清空全部（含隐藏项）
  });

  it('合并：已有行原样保留（用户调过的容量不被覆盖），只追加勾选的新 id', () => {
    const existing = [{ id: 'big-pickle', contextWindow: 123456 }];
    const merged = mergeDiscoveredModels(existing, catalog, new Set(['big-pickle', 'plain']));
    expect(merged).toEqual([{ id: 'big-pickle', contextWindow: 123456 }, { id: 'plain' }]);
    // 未勾选的不追加；容量未知就留空（不臆造默认值）
    expect(merged.some((m) => m.id === 'gamma')).toBe(false);
    expect(merged[1]).toEqual({ id: 'plain' });
    // 参数不共享引用（返回新对象）
    expect(merged[0]).not.toBe(existing[0]);
  });

  it('newSelectedCount 只数「尚未在目录里」的勾选项（按钮计数不虚高）', () => {
    const existing = [{ id: 'big-pickle' }];
    expect(newSelectedCount(existing, new Set(['big-pickle']))).toBe(0);
    expect(newSelectedCount(existing, new Set(['big-pickle', 'plain', 'gamma']))).toBe(2);
    expect(newSelectedCount([], new Set(['plain']))).toBe(1);
  });
});
