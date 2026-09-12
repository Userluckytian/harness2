// T4 notify：回合结束提醒策略（HARNESS2_NOTIFY × HARNESS2_NOTIFY_METHOD）
// - 策略：always=总是发 / unfocused（缺省）=仅终端失焦时发 / never=不发
// - 方法：bel（\x07 终端响铃）/ osc9（\x1b]9;…\x07 终端通知）
// - 写 stderr 且仅 TTY 时写（不污染管道）；Ctrl+C 取消（cancelled）不发
import { describe, expect, it } from 'vitest';
import {
  createNotifier,
  emitNotify,
  resolveNotifyMethod,
  resolveNotifyPolicy,
  shouldNotify,
} from '../../src/tui/notify.js';

describe('resolveNotifyPolicy：环境变量解析（缺省 unfocused）', () => {
  it('缺省 / 空值 → unfocused', () => {
    expect(resolveNotifyPolicy({})).toBe('unfocused');
    expect(resolveNotifyPolicy({ HARNESS2_NOTIFY: '' })).toBe('unfocused');
  });
  it('合法值原样返回', () => {
    expect(resolveNotifyPolicy({ HARNESS2_NOTIFY: 'always' })).toBe('always');
    expect(resolveNotifyPolicy({ HARNESS2_NOTIFY: 'unfocused' })).toBe('unfocused');
    expect(resolveNotifyPolicy({ HARNESS2_NOTIFY: 'never' })).toBe('never');
  });
  it('非法值按缺省处理（不抛错）', () => {
    expect(resolveNotifyPolicy({ HARNESS2_NOTIFY: 'sometimes' })).toBe('unfocused');
  });
});

describe('resolveNotifyMethod：环境变量解析（缺省 bel）', () => {
  it('缺省 → bel；合法值原样返回；非法值按 bel', () => {
    expect(resolveNotifyMethod({})).toBe('bel');
    expect(resolveNotifyMethod({ HARNESS2_NOTIFY_METHOD: 'osc9' })).toBe('osc9');
    expect(resolveNotifyMethod({ HARNESS2_NOTIFY_METHOD: 'weird' })).toBe('bel');
  });
});

describe('shouldNotify：策略 × 焦点两态（3×2 全覆盖）', () => {
  it('always：聚焦/失焦都发', () => {
    expect(shouldNotify('always', true)).toBe(true);
    expect(shouldNotify('always', false)).toBe(true);
  });
  it('unfocused：仅失焦发', () => {
    expect(shouldNotify('unfocused', true)).toBe(false);
    expect(shouldNotify('unfocused', false)).toBe(true);
  });
  it('never：都不发', () => {
    expect(shouldNotify('never', true)).toBe(false);
    expect(shouldNotify('never', false)).toBe(false);
  });
});

describe('emitNotify：方法两种的字节输出', () => {
  it('bel → \\x07', () => {
    let out = '';
    emitNotify('bel', (s) => {
      out += s;
    });
    expect(out).toBe('\x07');
  });
  it('osc9 → \\x1b]9;…\\x07（固定标题文本）', () => {
    let out = '';
    emitNotify('osc9', (s) => {
      out += s;
    });
    expect(out).toBe('\x1b]9;harness2: 回合完成\x07');
  });
});

describe('createNotifier.onTurnComplete：接线语义', () => {
  function capture() {
    const writes: string[] = [];
    return { writes, write: (s: string) => writes.push(s) };
  }

  it('always + 聚焦 + 正常结束 → 发（bel）', () => {
    const { writes, write } = capture();
    const n = createNotifier({ HARNESS2_NOTIFY: 'always' }, write);
    n.onTurnComplete({ focused: true, cancelled: false });
    expect(writes).toEqual(['\x07']);
  });

  it('unfocused + 聚焦 → 不发；失焦 → 发', () => {
    const w1 = capture();
    const n1 = createNotifier({ HARNESS2_NOTIFY: 'unfocused' }, w1.write);
    n1.onTurnComplete({ focused: true, cancelled: false });
    expect(w1.writes).toEqual([]);

    const w2 = capture();
    const n2 = createNotifier({ HARNESS2_NOTIFY: 'unfocused' }, w2.write);
    n2.onTurnComplete({ focused: false, cancelled: false });
    expect(w2.writes).toEqual(['\x07']);
  });

  it('never → 不发（无论焦点）', () => {
    const { writes, write } = capture();
    const n = createNotifier({ HARNESS2_NOTIFY: 'never' }, write);
    n.onTurnComplete({ focused: false, cancelled: false });
    expect(writes).toEqual([]);
  });

  it('Ctrl+C 取消（cancelled）→ 不发，即使 always', () => {
    const { writes, write } = capture();
    const n = createNotifier({ HARNESS2_NOTIFY: 'always' }, write);
    n.onTurnComplete({ focused: true, cancelled: true });
    expect(writes).toEqual([]);
  });

  it('osc9 方法 → 发 OSC9 序列', () => {
    const { writes, write } = capture();
    const n = createNotifier({ HARNESS2_NOTIFY: 'always', HARNESS2_NOTIFY_METHOD: 'osc9' }, write);
    n.onTurnComplete({ focused: false, cancelled: false });
    expect(writes).toEqual(['\x1b]9;harness2: 回合完成\x07']);
  });

  it('env 缺省 = unfocused：聚焦不发，失焦发', () => {
    const w = capture();
    const n = createNotifier({}, w.write);
    n.onTurnComplete({ focused: true, cancelled: false });
    expect(w.writes).toEqual([]);
    n.onTurnComplete({ focused: false, cancelled: false });
    expect(w.writes).toEqual(['\x07']);
  });
});
