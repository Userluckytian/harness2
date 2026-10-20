// ConfirmDialog —— ui-shared 通用二次确认对话框（Z-49 文案族承载体）。
//
// 来源：既有对话框原语（`components/ui/dialog.js` + `button.js`）的组合件，不新造第三套弹窗。
// 消费方：侧栏「删除会话」「移除运行中的项目」（Z-49）；后续需要确认语义的入口统一走这里。
// destructive 动作（variant="destructive"）为默认——确认钮语义是「不可逆/危险」，
// 取消走 outline；busy 时两钮禁用（不双提交）。
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  /** 确认按钮文案（destructive 语义） */
  confirmLabel: string;
  /** 取消按钮文案 */
  cancelLabel: string;
  /** 确认执行中（禁用双钮防双提交） */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.ReactNode {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="max-w-md" aria-describedby="confirm-dialog-description" data-testid="confirm-dialog">
        <DialogHeader>
          <DialogTitle data-testid="confirm-dialog-title">{title}</DialogTitle>
          <DialogDescription id="confirm-dialog-description" data-testid="confirm-dialog-description">
            {description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" size="lg" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="lg"
            disabled={busy}
            data-testid="confirm-dialog-confirm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
