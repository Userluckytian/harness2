// D-50～D-59 的提供方编辑卡（一次只展开一张，展开/收起由 ModelsSettings 控制）。
//
// 逐条落点：
//   D-51 单一密钥输入框（只写、派生具名引用、配置文件零密钥值；从不询问环境变量名）
//   D-52 状态点保守规则 + 成功后无障碍消息且不回显机密
//   D-53 收起的「自定义设置」折叠区（显示名称 / Provider ID 不可改 / API 协议 / baseURL / 模型目录）
//   D-54 无推理等级控件（它是按模型的能力，提供方级控件只会设出部分模型会拒的值）
//   D-55 获取可用模型 → 可搜索选择器 → 添加所选才写入；已有行保留用户调过的值
//   D-57 校验四类拒绝（就地阻断）
//   D-59 删除仅用户层独有可删 + 确认对话框指名提供方
import { useMemo, useState } from 'react';
import type {
  CredentialStatusShape,
  ModelsDocumentShape,
  ModelsModelRowShape,
  ModelsProviderInputShape,
  ModelsProviderRowShape,
  ModelsSettingsApi,
} from '../../../shared/protocol.js';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog.js';
import { ModelDiscoverSelector } from './ModelDiscoverSelector.js';
import { credentialPresentation, deriveApiKeyRef, emptyModelRow, rowToInput } from './model-document.js';
import { issueFor, validateApiKey, validateProviderDraft, type FieldIssue } from './validate.js';

/** 状态点（D-52）：仅在已确认时标绿、仅在已确认具名引用缺失时标红；未知不上色 */
export function StatusDot({ credential }: { credential: CredentialStatusShape }) {
  const shown = credentialPresentation(credential);
  return (
    <span
      className={`models-dot models-dot-${shown.tone}`}
      role="img"
      aria-label={`${shown.text}：${shown.detail}`}
      title={shown.detail}
    />
  );
}

export interface ProviderCardProps {
  mode: 'create' | 'edit';
  api: Partial<ModelsSettingsApi>;
  revision: string;
  /** 编辑模式的既有行（读视图，含凭据确认与层归属） */
  row: ModelsProviderRowShape | null;
  existingIds: readonly string[];
  /** 保存成功：回带最新文档与本次保存的 Provider ID（新建后父组件据此展开该行） */
  onSaved(document: ModelsDocumentShape, id: string): void;
  onDeleted(document: ModelsDocumentShape): void;
  /** 文档需要刷新（密钥写入成功 / revision 冲突后重新取权威文档） */
  onRefresh(): void;
  onCancel(): void;
}

function emptyDraft(): ModelsProviderInputShape {
  return { id: '', displayName: '', protocol: 'openai', baseUrl: '', models: [] };
}

function parseCapacity(raw: string): number | undefined {
  if (raw.trim().length === 0) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function withCapacity(
  row: ModelsModelRowShape,
  key: 'contextWindow' | 'maxOutputTokens',
  value: number | undefined,
): ModelsModelRowShape {
  const next: ModelsModelRowShape = { ...row };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

export function ProviderCard({
  mode,
  api,
  revision,
  row,
  existingIds,
  onSaved,
  onDeleted,
  onRefresh,
  onCancel,
}: ProviderCardProps) {
  const [form, setForm] = useState<ModelsProviderInputShape>(() => (row !== null ? rowToInput(row) : emptyDraft()));
  const [mainModel, setMainModel] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(mode === 'create');
  const [touched, setTouched] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState<string | null>(null);
  const [credentialOverride, setCredentialOverride] = useState<CredentialStatusShape | null>(null);
  const [discoverState, setDiscoverState] = useState<
    { kind: 'closed' } | { kind: 'busy' } | { kind: 'open'; models: { id: string; displayName: string }[] }
  >({ kind: 'closed' });
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [serverIssue, setServerIssue] = useState<FieldIssue | null>(null);

  const issues = useMemo(
    () =>
      validateProviderDraft(form, {
        existingIds,
        ...(mode === 'edit' && row !== null ? { originalId: row.id } : {}),
      }),
    [form, existingIds, mode, row],
  );
  const showIssues = touched || serverIssue !== null;
  const allIssues = serverIssue !== null ? [...issues, serverIssue] : issues;
  /**
   * P2-6：`credentialOverride` 只在**权威行尚未反映该渠道凭据**时使用。
   * `writeChannelKey` 回的 `reference` 由 route 派生（`<ROUTE>_API_KEY`）；若 config.json 里的
   * `envKey` 是自定义名（CLI / 手写既有场景），覆盖值会显示错误引用。刷新后的
   * `document.providers[i].apiKeyRef` 才是权威 —— 行一旦 confirmed 就放弃覆盖（等效「刷新时清除 override」）。
   * 新建卡（row === null）在保存后、文档刷新前仍需要覆盖值来即时反馈。
   */
  const credential: CredentialStatusShape =
    row?.credential.state === 'confirmed'
      ? row.credential
      : (credentialOverride ?? row?.credential ?? { state: 'unknown' });
  const shownCredential = credentialPresentation(credential);
  const uid = `models-${row?.id ?? 'draft'}`;
  const route = form.id.trim();

  const setField = <K extends keyof ModelsProviderInputShape>(key: K, value: ModelsProviderInputShape[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setServerIssue(null);
  };

  const saveKey = async (): Promise<void> => {
    const valid = validateApiKey(keyInput);
    if (!valid.ok) {
      setKeyError(valid.error ?? '密钥校验未通过');
      return;
    }
    if (route.length === 0) {
      setKeyError('请先填写 Provider ID（密钥归属渠道）');
      return;
    }
    const write = api.settingsWriteChannelKey;
    if (write === undefined) {
      setKeyError('主进程未提供凭据写入通道');
      return;
    }
    setKeyBusy(true);
    setKeyError(null);
    try {
      const res = await write(route, valid.value as string);
      if (!res.ok) {
        setKeyError(res.error ?? '密钥写入失败');
        return;
      }
      const reference = res.reference ?? deriveApiKeyRef(route);
      setKeyInput('');
      setCredentialOverride({ state: 'confirmed', source: 'auth.json', reference });
      // 无障碍消息且不回显机密（D-52）
      setLiveMessage(`「${route}」的 API 密钥已保存到 auth.json（不回显）；具名引用 ${reference}`);
      onRefresh();
    } finally {
      setKeyBusy(false);
    }
  };

  const discover = async (): Promise<void> => {
    const fn = api.settingsDiscoverModels;
    if (fn === undefined) {
      setDiscoverError('主进程未提供模型发现通道');
      return;
    }
    setDiscoverState({ kind: 'busy' });
    setDiscoverError(null);
    const res = await fn({ route, baseUrl: form.baseUrl.trim(), protocol: form.protocol });
    if (!res.ok || res.models === undefined) {
      setDiscoverState({ kind: 'closed' });
      setDiscoverError(res.error ?? '获取模型失败');
      return;
    }
    setDiscoverState({ kind: 'open', models: res.models });
  };

  const save = async (): Promise<void> => {
    setTouched(true);
    setSaveError(null);
    setConflict(null);
    if (issues.length > 0) return; // 就地阻断：不调 IPC
    const fn = api.settingsUpdateModels;
    if (fn === undefined) {
      setSaveError('主进程未提供模型配置写入通道');
      return;
    }
    setBusy(true);
    try {
      const res = await fn({
        revision,
        provider: {
          ...form,
          id: route,
          displayName: form.displayName.trim(),
          baseUrl: form.baseUrl.trim(),
          models: form.models.map((m) => ({ ...m, id: m.id.trim() })),
        },
        ...(mode === 'edit' && row !== null ? { originalId: row.id } : {}),
        ...(mainModel.length > 0 ? { mainModel } : {}),
      });
      if (res.ok && res.document !== undefined) {
        setTouched(false);
        onSaved(res.document, route);
        return;
      }
      if (res.code === 'settings/conflict') {
        setConflict(res.error ?? '配置已被其他修改改动：已拒绝本次写入，请重试');
        onRefresh();
        return;
      }
      if (res.field !== undefined && res.error !== undefined) setServerIssue({ field: res.field, message: res.error });
      else setSaveError(res.error ?? '保存失败');
      setTouched(true);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    const fn = api.settingsDeleteProvider;
    if (fn === undefined || row === null) {
      setDeleteError('主进程未提供删除通道');
      return;
    }
    setBusy(true);
    setDeleteError(null);
    try {
      const res = await fn(row.id, row.id);
      if (!res.ok || res.document === undefined) {
        setDeleteError(res.error ?? '删除失败');
        return;
      }
      setConfirming(false);
      onDeleted(res.document);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="models-card" aria-label={`提供方 ${route.length > 0 ? route : '(新提供方)'}`}>
      <div className="models-field">
        <span className="models-label">API 密钥</span>
        <div className="models-key-row">
          <input
            id={`${uid}-key`}
            className="models-input models-key-input"
            type="password"
            value={keyInput}
            aria-label="API 密钥"
            autoComplete="off"
            spellCheck={false}
            placeholder="只写入 auth.json，保存后不回显"
            onChange={(e) => {
              setKeyInput(e.target.value);
              setKeyError(null);
            }}
          />
          <button
            type="button"
            className="models-btn"
            onClick={() => void saveKey()}
            disabled={keyBusy || keyInput.length === 0}
          >
            {keyBusy ? '保存中…' : '保存密钥'}
          </button>
        </div>
        {keyError !== null && (
          <p className="models-error" role="alert">
            {keyError}
          </p>
        )}
        <p className="models-hint">
          密钥只写、不回显；状态由主进程确认（当前：{shownCredential.text}
          {credential.reference !== undefined ? `，具名引用 ${credential.reference}` : ''}）。缺具名引用时自动派生{' '}
          <code>{deriveApiKeyRef(route.length > 0 ? route : 'ROUTE')}</code>。
        </p>
      </div>

      {liveMessage !== null && (
        <p className="models-live" role="status" aria-live="polite">
          {liveMessage}
        </p>
      )}

      <details className="models-advanced" open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}>
        <summary>自定义设置</summary>
        <div className="models-advanced-body">
          <label className="models-field">
            <span className="models-label">显示名称</span>
            <input
              className="models-input"
              value={form.displayName}
              aria-label="显示名称"
              onChange={(e) => setField('displayName', e.target.value)}
            />
          </label>
          <label className="models-field">
            <span className="models-label">Provider ID{mode === 'edit' ? '（不可修改）' : ''}</span>
            <input
              className="models-input"
              value={form.id}
              aria-label="Provider ID"
              disabled={mode === 'edit'}
              readOnly={mode === 'edit'}
              onChange={(e) => setField('id', e.target.value)}
            />
          </label>
          <label className="models-field">
            <span className="models-label">API 协议</span>
            <select
              className="models-input"
              value={form.protocol}
              aria-label="API 协议"
              onChange={(e) => setField('protocol', e.target.value === 'anthropic' ? 'anthropic' : 'openai')}
            >
              <option value="openai">openai（OpenAI 兼容：DeepSeek / 智谱 / 本地网关）</option>
              <option value="anthropic">anthropic（Messages API 原生）</option>
            </select>
          </label>
          <label className="models-field">
            <span className="models-label">端点 baseURL</span>
            <input
              className="models-input"
              value={form.baseUrl}
              aria-label="端点 baseURL"
              placeholder="https://api.example.com/v1"
              onChange={(e) => setField('baseUrl', e.target.value)}
            />
          </label>
          {showIssues && issueFor(allIssues, 'displayName') !== undefined && (
            <p className="models-error" role="alert">
              {issueFor(allIssues, 'displayName')}
            </p>
          )}
          {showIssues && issueFor(allIssues, 'id') !== undefined && (
            <p className="models-error" role="alert">
              {issueFor(allIssues, 'id')}
            </p>
          )}
          {showIssues && issueFor(allIssues, 'baseUrl') !== undefined && (
            <p className="models-error" role="alert">
              {issueFor(allIssues, 'baseUrl')}
            </p>
          )}

          <div className="models-catalog">
            <div className="models-catalog-head">
              <span className="models-label">模型目录</span>
              <button
                type="button"
                className="models-btn"
                onClick={() => setField('models', [...form.models, emptyModelRow()])}
              >
                添加模型
              </button>
              <button
                type="button"
                className="models-btn"
                onClick={() => void discover()}
                disabled={discoverState.kind === 'busy'}
              >
                {discoverState.kind === 'busy' ? '获取中…' : '获取可用模型'}
              </button>
            </div>
            {discoverError !== null && (
              <p className="models-error" role="alert">
                {discoverError}
              </p>
            )}
            <ul className="models-model-list" role="list">
              {form.models.map((m, index) => (
                <li key={index} className="models-model-row">
                  <input
                    className="models-input"
                    value={m.id}
                    aria-label={`模型 ${index + 1} id`}
                    placeholder="模型 id"
                    onChange={(e) =>
                      setField(
                        'models',
                        form.models.map((x, i) => (i === index ? { ...x, id: e.target.value } : x)),
                      )
                    }
                  />
                  <input
                    className="models-input models-input-num"
                    type="number"
                    min={1}
                    step={1}
                    value={m.contextWindow ?? ''}
                    aria-label={`模型 ${index + 1} 上下文窗口`}
                    placeholder="上下文窗口"
                    onChange={(e) =>
                      setField(
                        'models',
                        form.models.map((x, i) =>
                          i === index ? withCapacity(x, 'contextWindow', parseCapacity(e.target.value)) : x,
                        ),
                      )
                    }
                  />
                  <input
                    className="models-input models-input-num"
                    type="number"
                    min={1}
                    step={1}
                    value={m.maxOutputTokens ?? ''}
                    aria-label={`模型 ${index + 1} 最大输出`}
                    placeholder="最大输出"
                    onChange={(e) =>
                      setField(
                        'models',
                        form.models.map((x, i) =>
                          i === index ? withCapacity(x, 'maxOutputTokens', parseCapacity(e.target.value)) : x,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="models-btn"
                    aria-label={`移除模型 ${index + 1}`}
                    onClick={() =>
                      setField(
                        'models',
                        form.models.filter((_, i) => i !== index),
                      )
                    }
                  >
                    移除
                  </button>
                  {showIssues && issueFor(allIssues, `models.${index}.id`) !== undefined && (
                    <span className="models-error">{issueFor(allIssues, `models.${index}.id`)}</span>
                  )}
                  {showIssues && issueFor(allIssues, `models.${index}.contextWindow`) !== undefined && (
                    <span className="models-error">{issueFor(allIssues, `models.${index}.contextWindow`)}</span>
                  )}
                  {showIssues && issueFor(allIssues, `models.${index}.maxOutputTokens`) !== undefined && (
                    <span className="models-error">{issueFor(allIssues, `models.${index}.maxOutputTokens`)}</span>
                  )}
                </li>
              ))}
              {form.models.length === 0 && <li className="models-empty-line">尚未声明模型</li>}
            </ul>
            <label className="models-field">
              <span className="models-label">主模型（roles.main）</span>
              <select
                className="models-input"
                value={form.models.some((m) => m.id.trim() === mainModel) ? mainModel : ''}
                aria-label="主模型（roles.main）"
                onChange={(e) => setMainModel(e.target.value)}
              >
                <option value="">不设置（保持现有 roles.main）</option>
                {form.models
                  .filter((m) => m.id.trim().length > 0)
                  .map((m) => (
                    <option key={m.id} value={m.id.trim()}>
                      {m.id}
                    </option>
                  ))}
              </select>
            </label>
            {discoverState.kind === 'open' && (
              <ModelDiscoverSelector
                models={discoverState.models}
                existing={form.models}
                providerLabel={route.length > 0 ? route : '新提供方'}
                onApply={(merged) => {
                  setField('models', merged);
                  setDiscoverState({ kind: 'closed' });
                }}
                onCancel={() => setDiscoverState({ kind: 'closed' })}
              />
            )}
          </div>
        </div>
      </details>

      {conflict !== null && (
        <p className="models-error models-conflict" role="alert">
          {conflict}
        </p>
      )}
      {saveError !== null && (
        <p className="models-error" role="alert">
          {saveError}
        </p>
      )}
      {showIssues && allIssues.length > 0 && (
        <p className="models-hint" role="alert">
          校验未通过（{allIssues.length} 项）：{allIssues[0]?.message}
        </p>
      )}

      <footer className="models-card-actions">
        <button type="button" className="models-btn models-btn-primary" onClick={() => void save()} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="models-btn" onClick={onCancel} disabled={busy}>
          取消
        </button>
        {mode === 'edit' && row !== null && (
          <span className="models-delete">
            <button
              type="button"
              className="models-btn models-btn-danger"
              disabled={!row.deletable || busy}
              title={row.deletable ? '删除该提供方（仅用户层）' : (row.lockedReason ?? '不可删除')}
              onClick={() => {
                setDeleteError(null);
                setConfirming(true);
              }}
            >
              删除提供方
            </button>
            {!row.deletable && <span className="models-hint">{row.lockedReason ?? '不可删除'}</span>}
          </span>
        )}
      </footer>

      {confirming && row !== null && (
        <ConfirmDeleteDialog
          row={row}
          busy={busy}
          {...(deleteError !== null ? { error: deleteError } : {})}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </section>
  );
}
