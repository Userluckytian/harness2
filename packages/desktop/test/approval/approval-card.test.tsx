// 审批卡模块测试（P6-C / D-6x ui-approval）：
//   纯模型（决定值域 / 范围文案 / 参数摘要 / 过期 fail-closed）+ 卡片两形态（card/bar）
//   与动作回传（只回传 allow/deny，语义归 core）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import {
  APPROVAL_DECISION_LABEL,
  APPROVAL_EXPIRED_TEXT,
  APPROVAL_PENDING_TEXT,
  ApprovalBar,
  ApprovalCard,
  approvalScopeLabel,
  isApprovalDecision,
  isApprovalExpired,
  summarizeApprovalArgs,
  type ApprovalCardModel,
} from '../../src/renderer/approval/index.js';

afterEach(cleanup);

const base: ApprovalCardModel = { requestId: 'r1', tool: 'write', args: { file_path: 'a.txt' } };

describe('审批卡纯模型（与 core 语义对齐）', () => {
  it('决定值域只有 allow / deny（无第三态：不放宽、不新增"总是允许"）', () => {
    expect(isApprovalDecision('allow')).toBe(true);
    expect(isApprovalDecision('deny')).toBe(true);
    expect(isApprovalDecision('always')).toBe(false);
    expect(isApprovalDecision(undefined)).toBe(false);
    expect(Object.keys(APPROVAL_DECISION_LABEL)).toEqual(['allow', 'deny']);
  });

  it('范围文案：once→一次 / session→本会话；未知/缺省不猜（undefined）', () => {
    expect(approvalScopeLabel('once')).toBe('一次');
    expect(approvalScopeLabel('session')).toBe('本会话');
    expect(approvalScopeLabel(undefined)).toBeUndefined();
  });

  it('参数摘要：短参数原样，超长截断加省略号，undefined→空串', () => {
    expect(summarizeApprovalArgs(undefined)).toBe('');
    expect(summarizeApprovalArgs({ a: 1 }, 80)).toBe('{"a":1}');
    expect(summarizeApprovalArgs({ a: 'x'.repeat(100) }, 10)).toBe('{"a":"xxxx…');
  });

  it('过期判定与 core 同口径（fail-closed）：缺字段不误杀、不可解析→过期、到点即过期', () => {
    const now = Date.parse('2026-09-14T00:00:00Z');
    expect(isApprovalExpired(undefined, now)).toBe(false); // 旧 serve 不发 → 不误杀
    expect(isApprovalExpired('not-a-date', now)).toBe(true); // fail-closed
    expect(isApprovalExpired('2026-09-13T23:59:59Z', now)).toBe(true);
    expect(isApprovalExpired('2026-09-14T00:00:01Z', now)).toBe(false);
  });
});

describe('审批卡 card 形态（右栏审批中心）', () => {
  it('展示工具 + 参数 + 范围/过期元数据，两个决定按钮回传 allow/deny', () => {
    const onDecision = vi.fn();
    render(
      <ApprovalCard
        card={{ ...base, scope: 'session', expiresAt: '2026-09-14T01:00:00Z', cwd: 'D:/proj' }}
        now={Date.parse('2026-09-14T00:00:00Z')}
        onDecision={onDecision}
      />,
    );
    expect(screen.getByText('write')).toBeTruthy();
    expect(screen.getByText('{"file_path":"a.txt"}')).toBeTruthy();
    expect(screen.getByText('范围: 本会话')).toBeTruthy();
    expect(screen.getByText('cwd: D:/proj')).toBeTruthy();
    // 只有 allow/deny 两个动作按钮（无第三态）
    expect(screen.getByRole('button', { name: '允许' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '拒绝（不执行）' })).toBeTruthy();
    expect(document.querySelectorAll('.approval-actions button').length).toBe(2);

    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    expect(onDecision).toHaveBeenCalledWith('allow');
    fireEvent.click(screen.getByRole('button', { name: '拒绝（不执行）' }));
    expect(onDecision).toHaveBeenCalledWith('deny');
    expect(onDecision).toHaveBeenCalledTimes(2);
  });

  it('在途（提交中）：两个按钮都被反馈文案替换（连点无入口），但卡片仍在（可重试）', () => {
    render(<ApprovalCard card={base} responding onDecision={() => {}} />);
    expect(screen.getByText(APPROVAL_PENDING_TEXT)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '允许' })).toBeNull();
    expect(screen.queryByRole('button', { name: '拒绝（不执行）' })).toBeNull();
    // 卡片没有被撤掉（决定未送达 → 不假装已决定）
    expect(document.querySelector('[data-request-id="r1"]')).not.toBeNull();
  });

  it('已过期（装饰层判定）：只显示过期注记，不提供可点决定', () => {
    render(<ApprovalCard card={{ ...base, expired: true }} onDecision={() => {}} />);
    expect(screen.getByText(APPROVAL_EXPIRED_TEXT)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '允许' })).toBeNull();
    expect(document.querySelector('.approval-expired')).not.toBeNull();
  });

  it('就地过期（装饰层未判定 + expiresAt 已过）同样 fail-closed', () => {
    render(
      <ApprovalCard
        card={{ ...base, expiresAt: '2026-09-13T00:00:00Z' }}
        now={Date.parse('2026-09-14T00:00:00Z')}
        onDecision={() => {}}
      />,
    );
    expect(screen.getByText(APPROVAL_EXPIRED_TEXT)).toBeTruthy();
  });

  it('showMeta=false 隐藏元数据行（会话内联条不展示 cwd/范围）', () => {
    render(<ApprovalCard card={{ ...base, cwd: 'D:/proj' }} variant="card" showMeta={false} onDecision={() => {}} />);
    expect(screen.queryByText(/cwd:/)).toBeNull();
  });
});

describe('审批卡 bar 形态与 ApprovalBar（会话内联条）', () => {
  it('一行提示「允许执行 X？」+ 允许/拒绝按钮（文案与既有内联条一致）', () => {
    const onDecision = vi.fn();
    render(<ApprovalCard card={base} variant="bar" labels={{ allow: '允许', deny: '拒绝' }} onDecision={onDecision} />);
    expect(screen.getByText(/允许执行/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    expect(onDecision).toHaveBeenCalledWith('allow');
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onDecision).toHaveBeenCalledWith('deny');
  });

  it('ApprovalBar：多条按到达顺序渲染，onDecision 带 requestId；在途项按钮换反馈', () => {
    const onDecision = vi.fn();
    render(
      <ApprovalBar
        approvals={[base, { requestId: 'r2', tool: 'bash', args: { command: 'ls' } }]}
        respondingOf={(id) => id === 'r2'}
        onDecision={onDecision}
      />,
    );
    expect(document.querySelector('[data-approval-bar-count]')?.getAttribute('data-approval-bar-count')).toBe('2');
    const items = [...document.querySelectorAll('.approval-item')].map((n) => n.getAttribute('data-request-id'));
    expect(items).toEqual(['r1', 'r2']);
    // r2 在途 → 只有 r1 有按钮
    expect(screen.getAllByRole('button', { name: '允许' }).length).toBe(1);
    expect(screen.getByText(APPROVAL_PENDING_TEXT)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    expect(onDecision).toHaveBeenCalledWith('r1', 'allow');
  });

  it('无待批 → 不渲染审批条（不留空壳）', () => {
    const { container } = render(<ApprovalBar approvals={[]} onDecision={() => {}} />);
    expect(container.querySelector('.approval-bar')).toBeNull();
  });
});
