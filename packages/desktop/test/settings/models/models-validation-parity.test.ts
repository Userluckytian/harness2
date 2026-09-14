// D-57 / D-85 校验**双向一致性**（渲染端 ↔ 主进程）：
// 渲染端的就地阻断只是即时反馈，权威在校验主进程——两边漂移会让「UI 放行、落盘被拒」或反之。
// 本文件对同一批输入断言两边的 ok / field / message 完全一致（不变量，不是快照）。
import { describe, expect, it } from 'vitest';
import type { ModelsProviderInputShape } from '../../../src/shared/protocol.js';
import {
  validateApiKeyInput,
  validateProviderInput,
  type ProviderFieldIssue,
} from '../../../src/main/models-config.js';
import { validateApiKey, validateProviderDraft } from '../../../src/renderer/settings/models/validate.js';

function provider(over: Partial<ModelsProviderInputShape> = {}): ModelsProviderInputShape {
  return {
    id: 'local-oai',
    displayName: '本地统一网关',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:40080/v1',
    models: [{ id: 'big-pickle', contextWindow: 200000 }],
    ...over,
  };
}

const KEY_CASES: unknown[] = [
  'sk-abcDEF0123-_',
  '  sk-padded  ',
  'sk-abc def',
  'sk-abc\t123',
  '密钥值',
  '   ',
  'LOCAL_UNIFIED_KEY=sk-abcDEF0123',
  'NAME=value',
  'dGVzdEtleTEyMw',
  'ABCD==',
  '"sk-abcDEF0123"',
  "'sk-abcDEF0123'",
  '`sk-abcDEF0123`',
  '"sk-abcDEF0123',
  "'sk-abcDEF0123",
  'sk-with"inner',
  123,
  null,
  undefined,
];

const PROVIDER_CASES: Array<{ input: ModelsProviderInputShape; ctx: { existingIds: string[]; originalId?: string } }> =
  [
    { input: provider(), ctx: { existingIds: [] } },
    { input: provider({ id: '   ' }), ctx: { existingIds: [] } },
    { input: provider({ id: '1bad id' }), ctx: { existingIds: [] } },
    { input: provider(), ctx: { existingIds: ['local-oai'] } },
    { input: provider({ displayName: ' ' }), ctx: { existingIds: [] } },
    { input: provider({ baseUrl: '' }), ctx: { existingIds: [] } },
    { input: provider({ baseUrl: 'nope' }), ctx: { existingIds: [] } },
    { input: provider({ baseUrl: 'ftp://host/v1' }), ctx: { existingIds: [] } },
    { input: provider({ models: [] }), ctx: { existingIds: [] } },
    { input: provider({ models: [{ id: ' ' }] }), ctx: { existingIds: [] } },
    { input: provider({ models: [{ id: 'm' }, { id: 'm' }] }), ctx: { existingIds: [] } },
    { input: provider({ models: [{ id: 'm', contextWindow: 0 }] }), ctx: { existingIds: [] } },
    { input: provider({ models: [{ id: 'm', maxOutputTokens: 1.5 }] }), ctx: { existingIds: [] } },
    { input: provider({ id: 'renamed' }), ctx: { existingIds: ['local-oai'], originalId: 'local-oai' } },
    {
      input: provider({ protocol: 'gemini' as ModelsProviderInputShape['protocol'] }),
      ctx: { existingIds: [] },
    },
  ];

const fields = (issues: readonly ProviderFieldIssue[]): string[] => issues.map((i) => i.field);
const messages = (issues: readonly ProviderFieldIssue[]): string[] => issues.map((i) => i.message);

describe('D-57：API 密钥校验两边一致', () => {
  it('ok 与规范化值一致；错误也同判（不出现「这边放行那边拒绝」）', () => {
    for (const raw of KEY_CASES) {
      const main = validateApiKeyInput(raw);
      const renderer = typeof raw === 'string' ? validateApiKey(raw) : { ok: false as const };
      expect(renderer.ok, `ok 判定漂移: ${String(raw)}`).toBe(main.ok);
      if (main.ok) expect(renderer).toEqual({ ok: true, value: main.value });
      else expect(main.error).toBeTruthy();
    }
  });

  it('P2-8 引号规则与上游同口径：只拒**成对包裹**（含反引号）；残留单边引号按上游放行', () => {
    for (const raw of ['"sk-x"', "'sk-x'", '`sk-x`']) {
      expect(validateApiKeyInput(raw).ok, raw).toBe(false);
      expect(validateApiKey(raw).ok, raw).toBe(false);
    }
    // 上游 isQuoted 只认「首尾同引号」；单边/内嵌引号落在 LEGAL_API_KEY（可打印 ASCII）内 → 放行。
    // 这是 P2-8 对齐后的行为（此前本实现额外拒「任何引号」，与上游不一致）。
    for (const raw of ['"sk-x', "'sk-x", 'sk-"x"', 'sk-with"inner']) {
      expect(validateApiKeyInput(raw).ok, raw).toBe(true);
      expect(validateApiKey(raw).ok, raw).toBe(true);
    }
  });

  it('P2-8 ENV_LINE 与上游同口径：NAME=value 拒；全大写 base64 padding（ABCD==）放行', () => {
    for (const raw of ['NAME=value', 'LOCAL_UNIFIED_KEY=sk-abcDEF0123']) {
      expect(validateApiKeyInput(raw).ok, raw).toBe(false);
      expect(validateApiKey(raw).ok, raw).toBe(false);
    }
    // `=` 后紧跟 `=` → 不是赋值行（上游 [^=] 有意放行 base64 padding）
    expect(validateApiKeyInput('ABCD==')).toEqual({ ok: true, value: 'ABCD==' });
    expect(validateApiKey('ABCD==')).toEqual({ ok: true, value: 'ABCD==' });
  });
});

describe('D-57/D-85：提供方草稿校验两边一致', () => {
  it('同一输入 → 同一 field 序列与同一批 message（渲染端只是权威规则的即时映射）', () => {
    for (const { input, ctx } of PROVIDER_CASES) {
      const main = validateProviderInput(input, ctx);
      const renderer = validateProviderDraft(input, ctx);
      expect(fields(renderer), JSON.stringify(input)).toEqual(fields(main));
      expect(messages(renderer), JSON.stringify(input)).toEqual(messages(main));
    }
  });

  it('端点是 http/https 才算合法（localhost / IPv4 / IPv6 字面量 / 自定义端口都放行）', () => {
    for (const url of [
      'http://localhost:40080/v1',
      'http://127.0.0.1:40080/v1',
      'http://[::1]:8080/v1',
      'https://api.example.com',
      'https://api.example.com:8443/v1/',
    ]) {
      expect(validateProviderInput(provider({ baseUrl: url }), { existingIds: [] }), url).toEqual([]);
      expect(validateProviderDraft(provider({ baseUrl: url }), { existingIds: [] }), url).toEqual([]);
    }
  });
});
