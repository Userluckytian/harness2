// B7 任务完成系统通知：纯函数单测（标题/80 字摘要组装 + 触发判定）。
import { describe, expect, it } from 'vitest';
import {
  NOTIFY_BODY_MAX,
  NOTIFY_LINE_MAX,
  NOTIFY_WINDOW_TITLE,
  composeNotifyContent,
  shouldNotifyOnTurnEnd,
} from '../src/shared/notify.js';

describe('composeNotifyContent / 标题', () => {
  it('优先用会话标题（折叠空白）', () => {
    const { title } = composeNotifyContent({ title: '  会话  标题  ', firstUserText: '第一句', replyText: 'x' });
    expect(title).toBe('会话 标题');
  });

  it('标题为空时回退到 firstUserText', () => {
    const { title } = composeNotifyContent({ title: '', firstUserText: '  用户第一句  ', replyText: 'x' });
    expect(title).toBe('用户第一句');
  });

  it('标题与 firstUserText 都为空时用窗口默认名', () => {
    const { title } = composeNotifyContent({ title: null, firstUserText: null, replyText: 'x' });
    expect(title).toBe(NOTIFY_WINDOW_TITLE);
  });
});

describe('composeNotifyContent / 正文本体（80 字摘要）', () => {
  it('空回复 → 空正文', () => {
    const { body } = composeNotifyContent({ title: 't', replyText: '  \n  ' });
    expect(body).toBe('');
  });

  it('短回复（≤80 字）原样保留（换行/全角空格折叠为单空格）', () => {
    const { body } = composeNotifyContent({ title: 't', replyText: '第一行。\n第二行。' });
    expect(body).toBe('第一行。 第二行。');
  });

  it('恰好 80 字不截断', () => {
    const text = '字'.repeat(NOTIFY_BODY_MAX);
    const { body } = composeNotifyContent({ title: 't', replyText: text });
    expect(body).toBe(text);
  });

  it('超长且有短第一句（≤60 字）：首句 + 换行 + 剩余截断 + 省略号', () => {
    const first = '已完成方案设计。';
    const remainder = '后'.repeat(200);
    const { body } = composeNotifyContent({ title: 't', replyText: first + remainder });
    expect(body.startsWith(first)).toBe(true);
    expect(body.includes('\n')).toBe(true);
    // 全量 ≤ 80：首句 + 换行 + (80 - 首句数 - 2) 字符 + 省略号
    expect(body.length).toBeLessThanOrEqual(NOTIFY_BODY_MAX);
    expect(body).toHaveLength(NOTIFY_BODY_MAX); // 掐满预算
    expect(body.endsWith('…')).toBe(true);
    expect(body.split('\n')[1]).toBe('后'.repeat(NOTIFY_BODY_MAX - first.length - 2) + '…'); // 第二行 = 续行 + 省略号
  });

  it('超长且首句 >60 字：直接截断到 59 字 + 省略号', () => {
    const longFirst = '很长的第一句'.repeat(20); // >60
    const { body } = composeNotifyContent({ title: 't', replyText: longFirst });
    expect(body.length).toBe(NOTIFY_LINE_MAX);
    expect(body.endsWith('…')).toBe(true);
    expect(body.startsWith(longFirst.slice(0, NOTIFY_LINE_MAX - 1))).toBe(true);
  });
});

describe('shouldNotifyOnTurnEnd / 触发判定', () => {
  it('窗口非聚焦 + 会话不可见 → 弹', () => {
    expect(shouldNotifyOnTurnEnd({ windowFocused: false, visible: false })).toBe(true);
  });

  it('窗口聚焦 → 不弹（无论会话可见性）', () => {
    expect(shouldNotifyOnTurnEnd({ windowFocused: true, visible: false })).toBe(false);
    expect(shouldNotifyOnTurnEnd({ windowFocused: true, visible: true })).toBe(false);
  });

  it('会话可见 → 不弹（即使窗口失焦，用户正在看该会话）', () => {
    expect(shouldNotifyOnTurnEnd({ windowFocused: false, visible: true })).toBe(false);
  });
});