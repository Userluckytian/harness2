// screen.ts — Screen 生命周期类（P2 T2-2）。
//
// 职责边界：只负责转义序列与 buffer 管理（进/退 alt-screen、光标显隐、鼠标上报开关、
// back buffer + 差量呈现）。raw mode、信号处理（SIGINT 等）由装配层负责。
//
// 每帧模型：render(draw) 先清空 back buffer，draw 回调整帧填充，再与 front diff
// 差量输出——调用方无需自己维护双 buffer。
import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT, HIDE_CURSOR, MOUSE_OFF, MOUSE_ON, SHOW_CURSOR, SGR_RESET } from './ansi.js';
import { CellBuffer } from './cell-buffer.js';
import { DiffPresenter, type WriteTarget } from './diff-presenter.js';

export interface ScreenStartOptions {
  /** 是否开启鼠标上报（默认开） */
  mouse?: boolean;
}

export class Screen {
  cols: number;
  rows: number;
  private readonly out: WriteTarget;
  private readonly presenter: DiffPresenter;
  private readonly back: CellBuffer;
  private _started = false;
  private _stopped = false;

  constructor(out: WriteTarget, cols: number, rows: number) {
    this.out = out;
    this.cols = cols;
    this.rows = rows;
    this.presenter = new DiffPresenter(out);
    this.back = new CellBuffer(cols, rows);
  }

  get started(): boolean {
    return this._started;
  }

  /** P4-1：OSC8 超链接开关透传（DiffPresenter；装配层按 deps.env 的 HARNESS2_OSC8 驱动） */
  setOsc8Enabled(enabled: boolean): void {
    this.presenter.osc8Enabled = enabled;
  }

  /** 进入 TUI 模式：进 alt-screen + 隐藏光标 +（可选）开鼠标上报 + SGR 复位。幂等。 */
  start(options: ScreenStartOptions = {}): void {
    if (this._started || this._stopped) return;
    this._started = true;
    const mouse = options.mouse ?? true;
    this.out.write(ALT_SCREEN_ENTER + HIDE_CURSOR + (mouse ? MOUSE_ON : '') + SGR_RESET);
    this.presenter.present(this.back); // front 对齐空白初始态
  }

  /** 当前 back buffer（只读视图；绘制请用 render 的回调参数） */
  get buffer(): CellBuffer {
    return this.back;
  }

  /**
   * 呈现一帧：清空 back buffer → draw 整帧填充 → 与上帧 diff 差量输出。
   * 返回写入字节数（无差异为 0）。stop 后调用直接返回 0。
   */
  render(draw: (buf: CellBuffer) => void): number {
    if (!this._started || this._stopped) return 0;
    this.back.clear();
    draw(this.back);
    return this.presenter.present(this.back);
  }

  /** 终端尺寸变化：back buffer 调整（内容保留左上），下一帧 diff 自动全量重绘 */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.back.resize(cols, rows);
  }

  /**
   * 完整恢复终端：关鼠标上报 → 显示光标 → SGR 复位 → 退 alt-screen。
   * 幂等；未 start 也可安全调用（异常恢复路径）。
   */
  stop(): void {
    if (this._stopped) return;
    this._stopped = true;
    this._started = false;
    this.out.write(MOUSE_OFF + SHOW_CURSOR + SGR_RESET + ALT_SCREEN_EXIT);
  }
}
