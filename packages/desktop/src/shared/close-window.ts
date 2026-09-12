// 关窗口决策（D4）：关 UI ≠ 已停止任务。有运行中工作时必须让用户显式选择。
//
// 背景（Global Constraints #3 / D4）：「不能关 UI 就宣称已停」。桌面在关闭窗口/退出前，
// 若有运行中 turn 或后台任务，必须提示并让用户选择：
//   - keep-running：保持后台运行（窗口关闭，serve 与任务继续；下次启动重订阅恢复）
//   - request-stop：请求停止（先发取消，再退出）
//   - cancel：取消关闭（回到界面）
// 本模块只做纯决策；弹窗与真正退出由 main 进程执行。

export type CloseChoice = 'keep-running' | 'request-stop' | 'cancel';

export type CloseAction = 'close-window-keep-serving' | 'stop-then-close' | 'stay-open';

export interface CloseDecision {
  action: CloseAction;
  /** 面向用户的一句话（说明「任务是否真的停了」） */
  note: string;
}

/**
 * 决策：
 *   - 无运行中工作 → 直接关闭（无提示；关闭不影响任何任务）；
 *   - 有运行中工作 + keep-running → 关闭窗口但**不**停止 serve/任务（如实告知仍在跑）；
 *   - 有运行中工作 + request-stop → 先请求停止再关闭（如实告知是「请求」而非保证已停）；
 *   - 有运行中工作 + cancel 或未选择 → 保持打开。
 */
export function decideCloseAction(busy: boolean, choice?: CloseChoice): CloseDecision {
  if (!busy) {
    return { action: 'close-window-keep-serving', note: '无运行中任务，直接关闭' };
  }
  switch (choice) {
    case 'keep-running':
      return {
        action: 'close-window-keep-serving',
        note: '任务在后台继续运行（窗口关闭不等于停止）',
      };
    case 'request-stop':
      return {
        action: 'stop-then-close',
        note: '已发送停止请求；未确认的取消不会被当作已完成',
      };
    case 'cancel':
    case undefined:
    default:
      return { action: 'stay-open', note: '已取消关闭' };
  }
}

/** 关闭对话框按钮（顺序 = 人类预期：先「保持运行」再「停止」，取消在最后） */
export const CLOSE_DIALOG_BUTTONS: ReadonlyArray<{ label: string; choice: CloseChoice }> = [
  { label: '保持后台运行', choice: 'keep-running' },
  { label: '请求停止并退出', choice: 'request-stop' },
  { label: '取消', choice: 'cancel' },
];

/** 对话框正文（明确说明「关 UI 不等于停任务」） */
export function closeDialogMessage(runningTurns: number, backgroundTasks: number): string {
  return [
    `当前有 ${runningTurns} 个运行中的 turn${backgroundTasks > 0 ? `、${backgroundTasks} 个后台任务` : ''}。`,
    '直接关闭窗口**不会**停止这些任务：它们会继续在本地 serve 中运行。',
    '请选择处理方式。',
  ].join('\n');
}
