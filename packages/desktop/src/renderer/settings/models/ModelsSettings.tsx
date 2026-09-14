// P6-B 模型配置页（D-50～D-59）：自包含组件，装配由设置壳（C 棒）负责。
//
// 形态（D-50）：按提供方行展示；**一次只展开一张编辑卡**；未配置的整节提供方首次直接渲染为展开卡。
// 同步（D-58）：订阅 settings/document-updated / credentials/reference-updated /
//   llm/adapters-updated / connection/reset —— 无需轮询。
// 首运行（D-59）：两个有序弹窗（版本化声明 → 条件式凭据步），声明确认版本落盘在主进程覆层。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelsDocumentShape, ModelsSettingsApi } from '../../../shared/protocol.js';
import { FirstRunDialogs } from './FirstRunDialogs.js';
import {
  documentProviderIds,
  firstRunStep,
  getModelsApi,
  layerLabel,
  modelsApiReady,
  shouldAutoExpand,
} from './model-document.js';
import { ProviderCard, StatusDot } from './ProviderCard.js';
import './models.css';

export interface ModelsSettingsProps {
  /** 测试/装配可注入通道面；缺省取 window.harness2 */
  api?: Partial<ModelsSettingsApi>;
  /** 文档变化回调（设置壳可据此刷新其它视图） */
  onDocument?: (doc: ModelsDocumentShape) => void;
}

export function ModelsSettings({ api: injected, onDocument }: ModelsSettingsProps) {
  const api = useMemo(() => injected ?? getModelsApi(), [injected]);
  const [doc, setDoc] = useState<ModelsDocumentShape | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const seen = useRef<Set<string>>(new Set());
  const [declarationOpen, setDeclarationOpen] = useState(false);
  /**
   * D-59 首运行弹窗链的开启时机（P1-1 修复）：
   * 「首次观察到需要声明」才开启，之后**只由用户动作关闭**（声明确认 → 第二步；或「稍后」/「去配置」）。
   * 若把开合都挂在 `doc` 上，点「我已了解」→ 落盘 → reload 得到 ack=1 的新 doc →
   * effect 重算 `firstRunStep(1) === 'none'` 会把第二步弹窗连同其内部 step 状态一起卸载
   * （生产路径的 IPC 往返后第二步不可达）。见 `declarationSeenRef`。
   */
  const declarationSeenRef = useRef(false);

  const apply = useCallback(
    (next: ModelsDocumentShape): void => {
      setDoc(next);
      setLoadError(null);
      onDocument?.(next);
    },
    [onDocument],
  );

  const reload = useCallback((): void => {
    const fn = api.settingsGetModels;
    if (fn === undefined) return;
    void fn()
      .then((next) => apply(next))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [api, apply]);

  useEffect(() => {
    reload();
  }, [reload]);

  // D-58：订阅设置域事件（四类），不轮询
  useEffect(() => {
    if (api.onSettingsEvent === undefined) return;
    return api.onSettingsEvent(() => reload());
  }, [api, reload]);

  // D-50：首次渲染把「未配置的整节提供方」直接展开（每 id 只自动展开一次，用户收起后不再抢焦点）
  useEffect(() => {
    if (doc === null) return;
    const candidate = doc.providers.find((row) => shouldAutoExpand(row, seen.current));
    for (const row of doc.providers) seen.current.add(row.id);
    if (candidate !== undefined && expandedId === null && !creating) setExpandedId(candidate.id);
  }, [doc, expandedId, creating]);

  // D-59：首运行（版本化声明 → 条件式凭据步）
  // P1-1：只在**首次观察到**「尚未确认声明」时开启；此后开合只由用户动作决定
  // （`acknowledge` 落盘刷新文档不得再关它 —— 否则第二步弹窗在 IPC 往返后被卸载）。
  useEffect(() => {
    if (doc === null || declarationSeenRef.current) return;
    if (firstRunStep(doc.declarationAckVersion) !== 'declaration') return;
    declarationSeenRef.current = true;
    setDeclarationOpen(true);
  }, [doc]);

  const ready = modelsApiReady(api);
  const rows = doc?.providers ?? [];
  const existingIds = doc !== null ? documentProviderIds(doc) : [];

  const toggle = (id: string): void => {
    setCreating(false);
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const acknowledge = (version: number): void => {
    const fn = api.settingsAckModelsDeclaration;
    if (fn === undefined) return;
    void fn(version).then((res) => {
      if (res.ok) reload();
    });
  };

  if (!ready) {
    return (
      <div className="models-settings">
        <p className="models-empty" role="alert">
          此版本主进程未提供模型配置通道（settings:getModels 等）——请更新外壳后重试；此处不摆不会生效的假入口。
        </p>
      </div>
    );
  }

  return (
    <div className="models-settings">
      <header className="models-head">
        <div>
          <h2 className="models-title">模型配置</h2>
          <p className="models-desc">
            提供方、模型与密钥全部在此配置。密钥只写入 <code>~/.harness2/auth.json</code>，配置文件永不持有密钥值。
          </p>
        </div>
        <button
          type="button"
          className="models-btn models-btn-primary"
          onClick={() => {
            setCreating(true);
            setExpandedId(null);
          }}
        >
          新增提供方
        </button>
      </header>

      {loadError !== null && (
        <p className="models-error" role="alert">
          读取模型配置失败：{loadError}
        </p>
      )}
      {doc !== null && doc.errors.length > 0 && (
        <ul className="models-errors" role="alert">
          {doc.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {doc !== null && doc.warnings.length > 0 && (
        <ul className="models-warnings">
          {doc.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      {creating && (
        <div className="models-create">
          <ProviderCard
            mode="create"
            api={api}
            revision={doc?.revision ?? ''}
            row={null}
            existingIds={existingIds}
            onSaved={(next, id) => {
              setCreating(false);
              setExpandedId(id);
              apply(next);
            }}
            onDeleted={apply}
            onRefresh={reload}
            onCancel={() => setCreating(false)}
          />
        </div>
      )}

      <ul className="models-rows" role="list">
        {rows.map((row) => (
          <li key={row.id} className={`models-row${expandedId === row.id ? ' models-row-open' : ''}`}>
            <button
              type="button"
              className="models-row-head"
              aria-expanded={expandedId === row.id}
              onClick={() => toggle(row.id)}
            >
              <StatusDot credential={row.credential} />
              <span className="models-row-name">{row.displayName}</span>
              <code className="models-row-id">{row.id}</code>
              <span className="models-row-meta">
                {row.baseUrl.length > 0 ? row.baseUrl : '（未设端点）'} · {row.models.length} 个模型 ·{' '}
                {layerLabel(row.layers)}
              </span>
            </button>
            {expandedId === row.id && (
              <ProviderCard
                mode="edit"
                api={api}
                revision={doc?.revision ?? ''}
                row={row}
                existingIds={existingIds}
                onSaved={(next) => apply(next)}
                onDeleted={(next) => {
                  setExpandedId(null);
                  apply(next);
                }}
                onRefresh={reload}
                onCancel={() => setExpandedId(null)}
              />
            )}
          </li>
        ))}
        {doc !== null && rows.length === 0 && !creating && (
          <li className="models-empty">
            尚无提供方：点「新增提供方」——填 Provider ID 与端点、保存密钥、获取可用模型，即可发起对话（无需手改文件）。
          </li>
        )}
        {doc === null && loadError === null && <li className="models-empty">读取中…</li>}
      </ul>

      {declarationOpen && doc !== null && (
        <FirstRunDialogs
          rows={rows}
          onAcknowledge={acknowledge}
          onOpenProvider={(id) => {
            setDeclarationOpen(false);
            setExpandedId(id);
            setCreating(false);
          }}
          onSkip={() => setDeclarationOpen(false)}
        />
      )}
    </div>
  );
}
