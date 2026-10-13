// 审批 dock（Z-20）：选项摊平 + numbered listbox 交互 + 状态（在途/过期/失败）+ 多张堆叠。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  APPROVAL_DOCK_CONFIRM_LABEL,
  APPROVAL_DOCK_HINT,
  APPROVAL_EXPIRED_TEXT,
  APPROVAL_PENDING_TEXT,
  ApprovalDock,
  approvalDockOptions,
  moveApprovalHighlight,
  type ApprovalCardModel,
} from '../src/renderer/approval/index.js';

afterEach(cleanup);

const base: ApprovalCardModel = { requestId: 'r1', tool: 'write', args: { file_path: 'a.txt' } };

describe('审批 dock 选项纯模型（Z10-5 五态摊平）', () => {
  it('范围缺省 → 五态行与 core decision 一一对应；仅 allow 无 chip，其余带范围 chip', () => {
    const options = approvalDockOptions(base);
    expect(options.map((o) => o.label)).toEqual(['允许', '本会话内允许', '始终允许', '拒绝', '始终拒绝']);
    expect(options.map((o) => o.decision)).toEqual(['allow', 'allow-session', 'allow-always', 'deny', 'deny-always']);
    // allow 无卡声明范围 → 无 chip；会话/全局项带 chip 如实说明影响面；deny（本次）无 chip
    expect(options.map((o) => o.scopeLabel)).toEqual([undefined, '本会话', '全局', undefined, '全局']);
  });

  it('范围 once → 允许（一次）带「一次」chip；session → 允许（本会话）带「本会话」chip', () => {
    const once = approvalDockOptions({ ...base, scope: 'once' });
    expect(once[0]).toMatchObject({ label: '允许（一次）', scopeLabel: '一次', decision: 'allow' });

    const session = approvalDockOptions({ ...base, scope: 'session' });
    expect(session[0]).toMatchObject({ label: '允许（本会话）', scopeLabel: '本会话', decision: 'allow' });
    expect(session).toHaveLength(5);
  });

  it('不摆 core 不认的选项：无 bypass「完全访问」行、无拒绝理由输入行', () => {
    const decisions = approvalDockOptions(base).map((o) => o.decision);
    expect(decisions).not.toContain('bypass');
    expect(decisions).not.toContain('allow-bypass');
    expect(decisions).not.toContain('feedback');
  });

  it('高亮移动 clamp：不越界、不回卷', () => {
    expect(moveApprovalHighlight(0, 1, 2)).toBe(1);
    expect(moveApprovalHighlight(1, 1, 2)).toBe(1); // 末行向下 → 不动
    expect(moveApprovalHighlight(0, -1, 2)).toBe(0); // 首行向上 → 不动
    expect(moveApprovalHighlight(0, 1, 0)).toBe(0);
  });
});

describe('ApprovalDock 组件（numbered listbox + 确认 + 键盘）', () => {
  it('无待批 → 不渲染（不留空壳）', () => {
    const { container } = render(<ApprovalDock approvals={[]} onDecision={() => {}} />);
    expect(container.querySelector('[data-testid="approval-dock"]')).toBeNull();
  });

  it('listbox/option 角色 + 序号 + 范围 chip；点选后确认回传 allow', () => {
    const onDecision = vi.fn();
    render(<ApprovalDock approvals={[{ ...base, scope: 'once' }]} onDecision={onDecision} />);
    expect(screen.getByRole('listbox')).toBeTruthy();
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.getAttribute('data-decision'))).toEqual([
      'allow',
      'allow-session',
      'allow-always',
      'deny',
      'deny-always',
    ]);
    expect(screen.getByText('允许（一次）')).toBeTruthy();
    expect(screen.getByText('一次')).toBeTruthy(); // 范围 chip
    expect(screen.getByText(APPROVAL_DOCK_HINT)).toBeTruthy();

    fireEvent.click(options[0]!);
    fireEvent.click(screen.getByRole('button', { name: APPROVAL_DOCK_CONFIRM_LABEL }));
    expect(onDecision).toHaveBeenCalledWith('r1', 'allow');
  });

  it('键盘：↑↓ 移动高亮，Enter 确认当前高亮（默认首行 allow，下移后为 allow-session）', () => {
    const onDecision = vi.fn();
    render(<ApprovalDock approvals={[base]} onDecision={onDecision} />);
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(onDecision).toHaveBeenCalledWith('r1', 'allow-session');
  });

  it('键盘：下移到「始终允许」并确认 → 回传 allow-always（五态可达）', () => {
    const onDecision = vi.fn();
    render(<ApprovalDock approvals={[base]} onDecision={onDecision} />);
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(onDecision).toHaveBeenCalledWith('r1', 'allow-always');
  });

  it('键盘：Esc 不提交', () => {
    const onDecision = vi.fn();
    render(<ApprovalDock approvals={[base]} onDecision={onDecision} />);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(onDecision).not.toHaveBeenCalled();
  });

  it('在途：选项区换为「提交中…」，无重复入口（无 listbox / 无确认按钮），卡片仍在', () => {
    render(<ApprovalDock approvals={[base]} respondingOf={() => true} onDecision={() => {}} />);
    expect(screen.getByText(APPROVAL_PENDING_TEXT)).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('button', { name: APPROVAL_DOCK_CONFIRM_LABEL })).toBeNull();
    expect(document.querySelector('[data-request-id="r1"]')).not.toBeNull();
  });

  it('已过期：只显示过期注记，不提供可点决定', () => {
    render(<ApprovalDock approvals={[{ ...base, expired: true }]} onDecision={() => {}} />);
    expect(screen.getByText(APPROVAL_EXPIRED_TEXT)).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('提交失败：就地注记且卡片保留可重试（仍可确认）', () => {
    const onDecision = vi.fn();
    render(
      <ApprovalDock
        approvals={[base]}
        failureOf={() => '审批提交失败: 断线（事项仍在待批，可重试）'}
        onDecision={onDecision}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('审批提交失败');
    fireEvent.click(screen.getByRole('button', { name: APPROVAL_DOCK_CONFIRM_LABEL }));
    expect(onDecision).toHaveBeenCalledWith('r1', 'allow');
  });

  it('多张待批：同一 dock 内纵向堆叠，各自独立确认', () => {
    const onDecision = vi.fn();
    render(
      <ApprovalDock
        approvals={[base, { requestId: 'r2', tool: 'bash', args: { command: 'ls' } }]}
        onDecision={onDecision}
      />,
    );
    const dock = screen.getByTestId('approval-dock');
    expect(dock.getAttribute('data-approval-count')).toBe('2');
    expect(document.querySelectorAll('[data-approval-dock-card]').length).toBe(2);
    fireEvent.click(screen.getByTestId('approval-confirm-r2'));
    expect(onDecision).toHaveBeenCalledWith('r2', 'allow');
  });
});
