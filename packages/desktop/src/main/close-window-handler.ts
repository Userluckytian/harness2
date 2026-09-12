// PD8：关窗口「决策 → 动作」接线（从 main.ts 提取；依赖注入使其可自动化测试）。
// 语义与 shared/close-window.ts 的纯逻辑一致：
//   - 无运行中工作 → 放行默认关闭；
//   - keep-running → 最小化窗口（进程/serve 继续，不设「找不回」陷阱），不请求停止；
//   - request-stop → 先让渲染端取消全部运行中工作，宽限 scheduleClose 后再 win.close()
//     （如实：这是请求，不是保证已停）；
//   - cancel/未选择 → 保持打开；弹窗失败 → 保守不关闭（避免静默丢弃运行中任务）。
// stoppingForClose 幂等：宽限窗口内再次 close 不重复弹窗、不重复请求停止。
import { CLOSE_DIALOG_BUTTONS, closeDialogMessage, decideCloseAction } from '../shared/close-window.js';

export interface CloseDialogOptions {
  type: 'warning';
  title: string;
  message: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

export interface CloseWindowDeps {
  /** 主进程维护的运行态（busy = 运行中 turn/后台任务/待批 任一存在） */
  runtime: () => { busy: boolean; runningTurns: number; backgroundTasks: number };
  /** 弹三选一对话框（真实实现 = dialog.showMessageBox(win, opts)） */
  showDialog: (opts: CloseDialogOptions) => Promise<{ response: number }>;
  /** 「保持后台运行」= 最小化 */
  minimize: () => void;
  /** 通知渲染端 stopAll（真实实现 = win.webContents.send('harness2:stop-all')） */
  requestStopAll: () => void;
  /** 最终关闭（真实实现 = win.close()；此时 preventDefault 已放行） */
  close: () => void;
  /** 宽限调度（真实实现 = setTimeout(fn, 400)；注入以便测试驱动） */
  scheduleClose: (fn: () => void) => ReturnType<typeof setTimeout>;
}

export function createCloseWindowHandler(deps: CloseWindowDeps): (event: { preventDefault(): void }) => void {
  let stoppingForClose = false;
  return (event) => {
    const runtime = deps.runtime();
    if (!runtime.busy || stoppingForClose) return;
    event.preventDefault();
    void deps
      .showDialog({
        type: 'warning',
        title: '仍有任务在运行',
        message: closeDialogMessage(runtime.runningTurns, runtime.backgroundTasks),
        buttons: CLOSE_DIALOG_BUTTONS.map((b) => b.label),
        defaultId: 0,
        cancelId: 2,
      })
      .then(({ response }) => {
        const choice = CLOSE_DIALOG_BUTTONS[response]?.choice ?? 'cancel';
        const decision = decideCloseAction(runtime.busy, choice);
        if (decision.action === 'stay-open') return;
        if (decision.action === 'close-window-keep-serving' && choice === 'keep-running') {
          // 「保持后台运行」= 最小化窗口（进程与 serve 继续；用户可从任务栏恢复，不设陷阱）
          deps.minimize();
          return;
        }
        // 请求停止并退出：先让渲染端取消全部运行中工作，再关闭
        stoppingForClose = true;
        deps.requestStopAll();
        deps.scheduleClose(() => {
          deps.close();
        });
      })
      .catch(() => {
        // 弹窗失败：保守起见不关闭（避免静默丢弃运行中任务）
      });
  };
}
