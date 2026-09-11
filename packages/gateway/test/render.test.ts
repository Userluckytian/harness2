// P3-a / P3-b 网关侧消费回归：turn 终态文本语义与 core `turn-end` 帧同契约。
import { describe, expect, it } from 'vitest';
import { renderTurnEnd } from '../src/render.js';

describe('P3-a/P3-b renderTurnEnd 终态文本语义', () => {
  it('final：完整正文直接渲染', () => {
    const text = renderTurnEnd({ finalText: '完整回复', textOutcome: 'final', toolLines: [], stopReason: 'end_turn' });
    expect(text).toBe('完整回复');
  });

  it('partial：半截文本 + 明确「未完成」标注（不冒充完整正文）', () => {
    const text = renderTurnEnd({
      finalText: '',
      partialText: '半截正文',
      textOutcome: 'partial',
      toolLines: ['> bash'],
      stopReason: 'error',
      error: 'fetch failed: ECONNREFUSED',
    });
    expect(text).toContain('> bash');
    expect(text).toContain('半截正文');
    expect(text).toContain('未完成');
    expect(text).toContain('ECONNREFUSED');
  });

  it('empty（network 错误且无文本）：仅原因行 + 工具行，不造空白正文', () => {
    const text = renderTurnEnd({
      finalText: '',
      textOutcome: 'empty',
      toolLines: ['> glob'],
      stopReason: 'error',
      error: 'fetch failed: ECONNREFUSED',
    });
    expect(text).toContain('> glob');
    expect(text).toContain('出错');
    expect(text).toContain('ECONNREFUSED');
  });

  it('缺省 textOutcome 时按文本推断（兼容旧调用）', () => {
    expect(renderTurnEnd({ finalText: '旧调用', toolLines: [], stopReason: 'end_turn' })).toBe('旧调用');
    expect(renderTurnEnd({ finalText: '', partialText: '半截', toolLines: [], stopReason: 'error' })).toContain(
      '未完成',
    );
    expect(renderTurnEnd({ finalText: '', toolLines: [], stopReason: 'error', error: 'x' })).toContain('出错');
  });
});
