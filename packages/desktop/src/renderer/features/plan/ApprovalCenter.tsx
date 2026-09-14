// 审批中心（D3/F4）：全部待批可见、主子归属清楚、过期 fail-closed、拒绝项明确未执行。
// 卡片数据来自服务端 approval-request 帧/重订阅快照，展示层不做推断。
//
// P6-C：卡片正文收敛到 `renderer/approval`（ApprovalCard）—— 与对话内联审批条同一实现，
// 本文件只保留「取数 → 装饰 → 分组」与动作回传（controller.respondApproval）。
import { controller, store, useAppState } from '../../app-shared.js';
import { ApprovalCard } from '../../approval/index.js';
import { decorateApprovals, groupApprovals, type ApprovalCard as ApprovalCardModel } from './plan-model.js';

export function ApprovalCenter() {
  useAppState();
  const approvals: ApprovalCardModel[] = store.allApprovals().map((a) => ({
    requestId: a.requestId,
    tool: a.tool,
    args: a.args,
    ...(a.scope !== undefined ? { scope: a.scope } : {}),
    ...(a.expiresAt !== undefined ? { expiresAt: a.expiresAt } : {}),
    ...(a.cwd !== undefined ? { cwd: a.cwd } : {}),
    ...(a.taskId !== undefined ? { taskId: a.taskId } : {}),
    ...(a.parentTaskId !== undefined ? { parentTaskId: a.parentTaskId } : {}),
  }));
  const tasks = store.allTasks().map((t) => t.task);
  const decorated = decorateApprovals(approvals, tasks);
  const groups = groupApprovals(decorated, tasks);

  if (decorated.length === 0) {
    return (
      <div className="panel approval-center">
        <div className="panel-head">
          <span>审批</span>
        </div>
        <div className="panel-empty">无待批事项（ask 模式下有写/命令时会在此出现）</div>
      </div>
    );
  }

  const pending = decorated.filter((c) => !c.expired);
  const expired = decorated.filter((c) => c.expired);

  return (
    <div className="panel approval-center">
      <div className="panel-head">
        <span>审批</span>
        <span className="panel-mode">
          待批 {pending.length} · 已过期 {expired.length}
        </span>
      </div>
      {groups.map((g) => (
        <div key={g.taskId ?? '__session__'} className={`approval-group${g.isChild ? ' approval-child' : ''}`}>
          <div className="approval-group-head">
            {g.taskId === null ? '会话级' : `任务 ${g.taskId}`}
            {g.isChild && <span className="approval-parent">（子任务，父 {g.parentTaskId}）</span>}
          </div>
          {g.cards.map((c) => (
            <ApprovalCard
              key={c.requestId}
              card={c}
              responding={store.isApprovalResponding(c.requestId)}
              onDecision={(decision) => void controller.respondApproval(c.requestId, decision)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
