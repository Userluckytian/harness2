// D-59：删除确认对话框——**指名**提供方（显示名 + Provider ID），避免误删同名渠道。
import type { ModelsProviderRowShape } from '../../../shared/protocol.js';

export interface ConfirmDeleteDialogProps {
  row: ModelsProviderRowShape;
  busy: boolean;
  error?: string;
  onCancel(): void;
  onConfirm(): void;
}

export function ConfirmDeleteDialog({ row, busy, error, onCancel, onConfirm }: ConfirmDeleteDialogProps) {
  return (
    <div className="models-confirm" role="dialog" aria-modal="true" aria-label="删除提供方确认">
      <h3 className="models-confirm-title">删除提供方？</h3>
      <p className="models-confirm-body">
        将删除提供方「{row.displayName}」（Provider ID: <code>{row.id}</code>）。
      </p>
      <p className="models-confirm-note">
        仅删除用户层配置（{row.layers.includes('user') ? '~/.harness2/config.json' : '用户层'}），删除后恢复组合基线；
        已写入 auth.json 的密钥不会被读取或回显。
      </p>
      {error !== undefined && (
        <p className="models-error" role="alert">
          {error}
        </p>
      )}
      <div className="models-confirm-actions">
        <button type="button" className="models-btn" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="button" className="models-btn models-btn-danger" onClick={onConfirm} disabled={busy}>
          {busy ? '删除中…' : `删除「${row.id}」`}
        </button>
      </div>
    </div>
  );
}
