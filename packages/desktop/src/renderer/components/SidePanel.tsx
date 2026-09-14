// 右侧工作面板（D3）：计划 / 任务 / 审批 / 变更 / 工作区 / 配置 + 文件预览。
// 数据一律来自真实后端快照/只读端点；无数据时给明确空态，不摆占位内容。
//
// P6-C：审批分区渲染 renderer/approval 的卡片（与对话内联审批条同一实现）；
// 「文件」分区是 D-86 ① `openFile` 路由的消费端（点工具卡的「打开文件」→ 本分区显示文本预览，
// 必要时把右栏打开）。D-76（ui-sidebar-documentpreview）落地后该分区让位移交。
import { useEffect, useState } from 'react';
import { controller, store, useAppState } from '../app-shared.js';
import { useFrame } from '../layout/frame-context.js';
import { ToolFilePreviewPanel, useToolFilePreview, useToolNavigation } from '../tool/index.js';
import { PlanPanel } from '../features/plan/PlanPanel.js';
import { TaskPanel } from '../features/plan/TaskPanel.js';
import { ApprovalCenter } from '../features/plan/ApprovalCenter.js';
import { ChangeReviewPanel } from '../features/workspace/ChangeReviewPanel.js';
import { WorkspacePanel } from '../features/workspace/WorkspacePanel.js';
import { EffectiveConfigPanel } from '../features/config/EffectiveConfigPanel.js';

type PanelTab = 'plan' | 'tasks' | 'approvals' | 'changes' | 'workspace' | 'file' | 'config';

const TAB_LABELS: Record<PanelTab, string> = {
  plan: '计划',
  tasks: '任务',
  approvals: '审批',
  changes: '变更',
  workspace: '工作区',
  file: '文件',
  config: '配置',
};

export function SidePanel() {
  const state = useAppState();
  const [tab, setTab] = useState<PanelTab>('plan');
  const sessionId = state.selectedId;
  const approvalCount = store.allApprovals().length;
  const planAvailable = sessionId !== null ? store.peekViews(sessionId)?.planState !== undefined : false;
  // D-86 ①：工具卡经 owner openFile 把文件路径路由到这里
  const navigation = useToolNavigation();
  const filePreview = useToolFilePreview();
  const frame = useFrame();

  // 有新的打开文件请求 → 切到「文件」分区；右栏关着就把它打开（不静默丢请求）
  useEffect(() => {
    if (filePreview === null) return;
    setTab('file');
    if (!frame.state.rightbarOpen) frame.dispatch({ type: 'rightbar/toggle' });
  }, [filePreview, frame]);

  // P6 修复棒（登记项转一行修复）：预览被清空（onClear / 换会话）后 tab 仍停在 'file' 会露出一帧
  // 无内容面板（'file' 标签在无预览时本就不渲染）。回到默认 'plan'。
  useEffect(() => {
    if (filePreview === null && tab === 'file') setTab('plan');
  }, [filePreview, tab]);

  const sessionCwd = sessionId !== null ? state.sessions.find((s) => s.id === sessionId)?.cwd : undefined;

  return (
    <aside className="side-panel" aria-label="工作面板">
      <div className="side-tabs">
        {(Object.keys(TAB_LABELS) as PanelTab[])
          .filter((t) => t !== 'file' || filePreview !== null)
          .map((t) => (
            <button
              key={t}
              type="button"
              className={`side-tab${tab === t ? ' side-tab-active' : ''}`}
              data-side-tab={t}
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
        {tab === 'file' && (
          <ToolFilePreviewPanel
            preview={filePreview}
            {...(sessionCwd !== undefined ? { cwd: sessionCwd } : {})}
            onClear={() => navigation.clearFilePreview()}
          />
        )}
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
