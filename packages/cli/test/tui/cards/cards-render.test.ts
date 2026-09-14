// cards/render 单测：四类卡片最小呈现契约 + 每类至少一个呈现快照（G-21～G-24）。
import { describe, expect, it } from 'vitest';
import {
  CARD_HINTS,
  QUESTION_FREE_TEXT_ID,
  permissionArgsText,
  renderCancelTurnCard,
  renderCard,
  renderElicitationCard,
  renderPermissionCard,
  renderQuestionCard,
} from '../../../src/tui/cards/render.js';
import { makeCancelTurnCard, makeElicitationCard, makePermissionCard, makeQuestionCard } from './helpers.js';

describe('G-21 permission prompt 呈现', () => {
  it('标题携带工具名；items 对齐 ApprovalGate 应答空间 y/a/n；cwd/task 进正文', () => {
    const view = renderPermissionCard(makePermissionCard());
    expect(view.title).toBe('Approval · write');
    expect(view.items.map((i) => i.id)).toEqual(['y', 'a', 'n']);
    expect(view.body).toEqual(['{"path":"/tmp/a.txt"}', 'cwd: /work']);
    expect(view.hints).toBe(CARD_HINTS); // 四类共用同一按键提示（G-25）
  });

  it('args 形态适配：string 原样 / undefined 标注 / 对象 JSON 单行 / 循环引用 fail-visible', () => {
    expect(permissionArgsText('ls -la')).toBe('ls -la');
    expect(permissionArgsText(undefined)).toBe('（无参数）');
    expect(permissionArgsText({ a: 1 })).toBe('{"a":1}');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(permissionArgsText(circular)).toBe('[不可序列化参数]');
  });

  it('呈现快照', () => {
    expect(renderPermissionCard(makePermissionCard('snap-perm'))).toMatchSnapshot();
  });
});

describe('G-22 cancel-turn panel 呈现', () => {
  it('reason 进正文；缺省 reason 用缺省文案；两项动作（确认取消 / 继续运行）', () => {
    const withReason = renderCancelTurnCard(makeCancelTurnCard());
    expect(withReason.title).toBe('Cancel turn');
    expect(withReason.body).toEqual(['模型仍在流式输出中']);
    expect(withReason.items.map((i) => i.id)).toEqual(['cancel-turn:confirm', 'cancel-turn:resume']);

    const noReason = renderCancelTurnCard({
      ...makeCancelTurnCard('snap-cancel'),
      payload: { turnId: 'turn-9' },
    });
    expect(noReason.body).toEqual(['确认取消当前运行中的回合？']);
  });

  it('呈现快照', () => {
    expect(renderCancelTurnCard(makeCancelTurnCard('snap-cancel'))).toMatchSnapshot();
  });
});

describe('G-23 question card 呈现', () => {
  it('选项带描述合并展示；allowFreeText=true 时自由文本项恒在末尾', () => {
    const view = renderQuestionCard(makeQuestionCard());
    expect(view.title).toBe('Question');
    expect(view.body).toEqual(['选择实现方案']);
    expect(view.items.map((i) => i.id)).toEqual(['opt-a', 'opt-b', QUESTION_FREE_TEXT_ID]);
    expect(view.items[0]?.label).toBe('方案 A —— 最小改动');
    expect(view.items[2]?.kind).toBe('text-input');
  });

  it('allowFreeText=false：只有选项，无自由文本入口', () => {
    const view = renderQuestionCard({
      ...makeQuestionCard('q-plain'),
      payload: { question: '继续？', options: [{ id: 'yes', label: '是' }] },
    });
    expect(view.items.map((i) => i.id)).toEqual(['yes']);
  });

  it('呈现快照', () => {
    expect(renderQuestionCard(makeQuestionCard('snap-question'))).toMatchSnapshot();
  });
});

describe('G-24 MCP elicitation 呈现', () => {
  it('标题携带 server；message 进正文；requestedSchema 单行附注；三动作 accept/decline/cancel', () => {
    const view = renderElicitationCard(makeElicitationCard());
    expect(view.title).toBe('MCP Elicitation · x.ai');
    expect(view.body).toEqual(['请提供访问令牌', 'schema: {"type":"string"}']);
    expect(view.items.map((i) => i.id)).toEqual(['elicit:accept', 'elicit:decline', 'elicit:cancel']);
  });

  it('无 schema 不产生 schema 行', () => {
    const view = renderElicitationCard({
      ...makeElicitationCard('elicit-plain'),
      payload: { server: 's', message: 'm' },
    });
    expect(view.body).toEqual(['m']);
  });

  it('呈现快照', () => {
    expect(renderElicitationCard(makeElicitationCard('snap-elicit'))).toMatchSnapshot();
  });
});

describe('遮盖注记（G-21 遮盖可见性）', () => {
  it('queuedBehind>0 产出诚实提示行；=0 无注记', () => {
    const covered = renderCard(makePermissionCard(), { queuedBehind: 2 });
    expect(covered.notes).toEqual(['另有 2 张卡排队（被本卡遮盖）']);
    expect(renderCard(makePermissionCard()).notes).toEqual([]);
  });

  it('renderCard 分发四类：kind 与 cardId 透传（供接线层按卡定位）', () => {
    const cards = [makePermissionCard('p'), makeCancelTurnCard('c'), makeQuestionCard('q'), makeElicitationCard('e')];
    for (const card of cards) {
      const view = renderCard(card);
      expect(view.cardId).toBe(card.id);
      expect(view.kind).toBe(card.kind);
    }
  });
});
