// D-59：首运行两个**有序**弹窗——① 版本化声明 → ② 条件式凭据步。
// ② 仅在「确有提供方尚无已确认凭据」时出现；没有需要配置的凭据则不再打扰。
import { useState } from 'react';
import type { ModelsProviderRowShape } from '../../../shared/protocol.js';
import { MODELS_DECLARATION_VERSION, providersNeedingCredential } from './model-document.js';

export interface FirstRunDialogsProps {
  rows: readonly ModelsProviderRowShape[];
  /** 声明确认落盘成功 → 关闭弹窗链 */
  onAcknowledge(version: number): void;
  /** 凭据步「去配置」：关弹窗并展开指定提供方 */
  onOpenProvider(id: string): void;
  /** 凭据步「稍后」 */
  onSkip(): void;
}

/** 两个弹窗的有序推进状态（纯逻辑，便于测试与复用） */
export function nextFirstRunStep(step: 1 | 2, rows: readonly ModelsProviderRowShape[]): 1 | 2 | 'done' {
  if (step === 1) return providersNeedingCredential(rows).length > 0 ? 2 : 'done';
  return 'done';
}

export function FirstRunDialogs({ rows, onAcknowledge, onOpenProvider, onSkip }: FirstRunDialogsProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const pending = providersNeedingCredential(rows);

  if (step === 1) {
    return (
      <div className="models-confirm models-declare" role="dialog" aria-modal="true" aria-label="模型配置声明">
        <h3 className="models-confirm-title">模型配置声明 v{MODELS_DECLARATION_VERSION}</h3>
        <ul className="models-declare-list">
          <li>
            API 密钥只写入 <code>~/.harness2/auth.json</code> 的 <code>channels.&lt;route&gt;.apiKey</code>，
            配置文件（config.json）永不持有密钥值。
          </li>
          <li>密钥只写不回读：界面不会回显明文，状态点只显示「已确认 / 已确认缺失 / 未确认」。</li>
          <li>
            配置端口只记录具名引用（<code>&lt;ROUTE&gt;_API_KEY</code>），换机时可用环境变量接管。
          </li>
        </ul>
        <div className="models-confirm-actions">
          <button
            type="button"
            className="models-btn models-btn-primary"
            onClick={() => {
              onAcknowledge(MODELS_DECLARATION_VERSION);
              const next = nextFirstRunStep(1, rows);
              if (next === 'done') onSkip();
              else setStep(2);
            }}
          >
            我已了解
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="models-confirm models-declare" role="dialog" aria-modal="true" aria-label="配置凭据">
      <h3 className="models-confirm-title">下一步：配置凭据</h3>
      <p className="models-confirm-body">以下提供方尚无已确认的凭据，无法发起对话：</p>
      <ul className="models-declare-list">
        {pending.map((r) => (
          <li key={r.id}>
            <code>{r.id}</code>
            {r.apiKeyRef !== undefined && <span className="models-hint">（引用 {r.apiKeyRef}）</span>}
          </li>
        ))}
      </ul>
      <div className="models-confirm-actions">
        <button type="button" className="models-btn" onClick={onSkip}>
          稍后再说
        </button>
        <button
          type="button"
          className="models-btn models-btn-primary"
          onClick={() => {
            const first = pending[0];
            if (first !== undefined) onOpenProvider(first.id);
            else onSkip();
          }}
        >
          去配置密钥
        </button>
      </div>
    </div>
  );
}
