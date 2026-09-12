// T2-2 Screen 生命周期单测：start 进 alt-screen（+可选鼠标）、render 每帧差量输出、
// resize、stop 完整恢复序列（顺序：关鼠标 → 显光标 → SGR 复位 → 退 alt-screen）、幂等。
// raw mode / 信号处理归装配层，Screen 只做转义序列与 buffer 管理。
import { describe, expect, it } from 'vitest';
import {
  ALT_SCREEN_ENTER,
  ALT_SCREEN_EXIT,
  HIDE_CURSOR,
  MOUSE_OFF,
  MOUSE_ON,
  SHOW_CURSOR,
  SGR_RESET,
} from '../../../src/tui/renderer/ansi.js';
import { Screen } from '../../../src/tui/renderer/screen.js';

class MemOut {
  private chunks: string[] = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  get text(): string {
    return this.chunks.join('');
  }
  clear(): void {
    this.chunks = [];
  }
}

describe('Screen 生命周期', () => {
  it('start：进 alt-screen + 隐藏光标 + 开鼠标上报，顺序正确', () => {
    const out = new MemOut();
    const s = new Screen(out, 80, 24);
    s.start();
    expect(out.text).toBe(ALT_SCREEN_ENTER + HIDE_CURSOR + MOUSE_ON + SGR_RESET);
    expect(s.started).toBe(true);
  });

  it('start({mouse:false}) 不开鼠标上报', () => {
    const out = new MemOut();
    const s = new Screen(out, 80, 24);
    s.start({ mouse: false });
    expect(out.text).toBe(ALT_SCREEN_ENTER + HIDE_CURSOR + SGR_RESET);
    expect(out.text).not.toContain(MOUSE_ON);
  });

  it('start 幂等：重复调用不重复写序列', () => {
    const out = new MemOut();
    const s = new Screen(out, 80, 24);
    s.start();
    s.start();
    expect(out.text).toBe(ALT_SCREEN_ENTER + HIDE_CURSOR + MOUSE_ON + SGR_RESET);
  });

  it('render：draw 回调填充 buffer，输出差量序列，返回字节数', () => {
    const out = new MemOut();
    const s = new Screen(out, 20, 4);
    s.start();
    out.clear();
    const n = s.render((buf) => {
      buf.writeText(0, 'frame1');
    });
    expect(n).toBeGreaterThan(0);
    expect(out.text).toContain('frame1');
  });

  it('render 第二帧同样内容 → 零输出（back buffer 每帧清空后重画同内容）', () => {
    const out = new MemOut();
    const s = new Screen(out, 20, 4);
    s.start();
    s.render((buf) => {
      buf.writeText(0, 'same');
    });
    out.clear();
    const n = s.render((buf) => {
      buf.writeText(0, 'same');
    });
    expect(n).toBe(0);
    expect(out.text).toBe('');
  });

  it('render 后 back buffer 已清空（每帧全量语义）', () => {
    const out = new MemOut();
    const s = new Screen(out, 20, 4);
    s.start();
    s.render((buf) => {
      buf.writeText(0, 'old');
    });
    s.render((buf) => {
      // 未写任何内容 → 上一帧的 "old" 应从屏幕上被差量擦除
      expect(buf.rowText(0)).toBe('                    ');
    });
    expect(out.text).not.toContain('oldold');
  });

  it('resize：buffer 尺寸变化，下一帧全量重绘', () => {
    const out = new MemOut();
    const s = new Screen(out, 20, 4);
    s.start();
    s.render((buf) => {
      buf.writeText(0, 'hello');
    });
    s.resize(10, 6);
    expect(s.cols).toBe(10);
    expect(s.rows).toBe(6);
    out.clear();
    s.render((buf) => {
      expect(buf.cols).toBe(10);
      expect(buf.rows).toBe(6);
      buf.writeText(0, 'hi');
    });
    expect(out.text).toContain('\x1b[2J');
  });

  it('stop：按 关鼠标 → 显光标 → SGR 复位 → 退 alt-screen 顺序恢复', () => {
    const out = new MemOut();
    const s = new Screen(out, 80, 24);
    s.start();
    out.clear();
    s.stop();
    expect(out.text).toBe(MOUSE_OFF + SHOW_CURSOR + SGR_RESET + ALT_SCREEN_EXIT);
    expect(s.started).toBe(false);
  });

  it('stop 幂等：重复调用不重复输出', () => {
    const out = new MemOut();
    const s = new Screen(out, 80, 24);
    s.start();
    s.stop();
    out.clear();
    s.stop();
    expect(out.text).toBe('');
  });

  it('stop 未 start 也安全（仍输出恢复序列一次）', () => {
    const out = new MemOut();
    const s = new Screen(out, 80, 24);
    s.stop();
    expect(out.text).toBe(MOUSE_OFF + SHOW_CURSOR + SGR_RESET + ALT_SCREEN_EXIT);
  });

  it('stop 后 render 不再输出', () => {
    const out = new MemOut();
    const s = new Screen(out, 20, 4);
    s.start();
    s.stop();
    out.clear();
    const n = s.render((buf) => {
      buf.writeText(0, 'x');
    });
    expect(n).toBe(0);
    expect(out.text).toBe('');
  });
});
