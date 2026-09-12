// 右侧工作面板（D3）：计划 / 任务 / 审批 / 变更 / 工作区（后续 D6 追加配置页签）。
// 数据一律来自真实后端快照/只读端点；无数据时给明确空态，不摆占位内容。
import { useState } from 'react';
import { controller, store, useAppState } from '../app-shared.js';
import { PlanPanel } from '../features/plan/PlanPanel.js';
import { TaskPanel } from '../features/plan/TaskPanel.js';
import { ApprovalCenter } from '../features/plan/ApprovalCenter.js';
import { ChangeReviewPanel } from '../features/workspace/ChangeReviewPanel.js';
import { WorkspacePanel } from '../features/workspace/WorkspacePanel.js';
import { EffectiveConfigPanel } from '../features/config/EffectiveConfigPanel.js';

type PanelTab = 'plan' | 'tasks' | 'approvals' | 'changes' | 'workspace' | 'config';

const TAB_LABELS: Record<PanelTab, string> = {
  plan: '计划',
  tasks: '任务',
  approvals: '审批',
  changes: '变更',
  workspace: '工作区',
  config: '配置',
};

export function SidePanel() {
  const state = useAppState();
  const [tab, setTab] = useState<PanelTab>('plan');
  const sessionId = state.selectedId;
  const approvalCount = store.allApprovals().length;
  const planAvailable = sessionId !== null ? store.peekViews(sessionId)?.planState !== undefined : false;

  return (
    <aside className="side-panel" aria-label="工作面板">
      <div className="side-tabs">
        {(Object.keys(TAB_LABELS) as PanelTab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`side-tab${tab === t ? ' side-tab-active' : ''}`}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
            {t === 'approvals' && approvalCount > 0 && <span className="side-badge">{approvalCount}</span>}
          </button>
        ))}
      </div>
      <div className="side-body">
        {tab === 'plan' && <PlanPanel sessionId={sessionId} />}
        {tab === 'tasks' && <TaskPanel sessionId={sessionId} />}
        {tab === 'approvals' && <ApprovalCenter />}
        {tab === 'changes' && <ChangeReviewPanel sessionId={sessionId} />}
        {tab === 'workspace' && <WorkspacePanel sessionId={sessionId} />}
        {tab === 'config' && <EffectiveConfigPanel sessionId={sessionId} />}
      </div>
      {sessionId !== null && (
        <div className="side-foot">
          <button type="button" onClick={() => void controller.refreshExecutionViews(sessionId)}>
            刷新只读视图
          </button>
          <button
            type="button"
            title="重连/恢复后重拉服务端权威任务、队列与待批（resume-subscription）"
            onClick={() => void controller.resumeSession(sessionId)}
          >
            重新同步
          </button>
          {!planAvailable && (
            <span className="side-hint" title="会话无计划账本时该视图为空">
              计划视图依赖任务账本
            </span>
          )}
        </div>
      )}
    </aside>
  );
}
