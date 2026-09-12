// D1 Composer 纯逻辑测试：IME 不误发、Enter 提交判定、自动高度。
import { describe, expect, it } from 'vitest';
import {
  COMPOSER_MAX_HEIGHT,
  COMPOSER_MIN_HEIGHT,
  autoHeightFor,
  isImeComposing,
  shouldSubmitOnKey,
} from '../src/renderer/features/composer/composer-model.js';

describe('IME 不误发（D1 可用性红线）', () => {
  it('isComposing=true 视为组合中（标准事件序列）', () => {
    expect(isImeComposing({ key: 'Enter', isComposing: true })).toBe(true);
    expect(isImeComposing({ key: 'Enter', isComposing: false })).toBe(false);
  });

  it('keyCode 229 兜底（部分 Windows 输入法组合期只给 229，isComposing 为 false）', () => {
    expect(isImeComposing({ key: 'Enter', isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeComposing({ key: 'Enter', keyCode: 13 })).toBe(false);
  });

  it('组合中的 Enter 绝不提交（候选词上屏不误发）', () => {
    expect(shouldSubmitOnKey({ key: 'Enter', isComposing: true })).toBe(false);
    expect(shouldSubmitOnKey({ key: 'Enter', isComposing: false, keyCode: 229 })).toBe(false);
  });

  it('Enter 提交；Shift+Enter 换行不提交；其他键不提交', () => {
    expect(shouldSubmitOnKey({ key: 'Enter' })).toBe(true);
    expect(shouldSubmitOnKey({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(shouldSubmitOnKey({ key: 'a' })).toBe(false);
    expect(shouldSubmitOnKey({ key: 'Escape' })).toBe(false);
  });
});

describe('自动高度（按行数推导，不塌陷/不无限增高）', () => {
  it('空内容 = 单行高度（不塌陷）', () => {
    expect(autoHeightFor('')).toBe(COMPOSER_MIN_HEIGHT);
  });

  it('多行按行数增长', () => {
    const one = autoHeightFor('a');
    const three = autoHeightFor('a\nb\nc');
    expect(three).toBeGreaterThan(one);
  });

  it('超过上限夹在 max（内部滚动，不撑破布局）', () => {
    const long = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
    expect(autoHeightFor(long)).toBe(COMPOSER_MAX_HEIGHT);
  });

  it('自定义 min/max/lineHeight/padding 生效', () => {
    expect(autoHeightFor('a\nb', { min: 10, max: 1000, lineHeight: 30, padding: 4 })).toBe(64);
  });
});
