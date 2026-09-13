// 审批中心（D3/F4）：全部待批可见、主子归属清楚、过期 fail-closed、拒绝项明确未执行。
// 卡片数据来自服务端 approval-request 帧/重订阅快照，展示层不做推断。
import { controller, store, useAppState } from '../../app-shared.js';
import { decorateApprovals, groupApprovals, type ApprovalCard } from './plan-model.js';

function argsSummary(args: unknown): string {
  const one = args === undefined ? '' : (JSON.stringify(args) ?? '');
  return one.length <= 120 ? one : `${one.slice(0, 120)}…`;
}

export function ApprovalCenter() {
  useAppState();
  const approvals: ApprovalCard[] = store.allApprovals().map((a) => ({
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
            <div
              key={c.requestId}
              className={`approval-card${c.expired ? ' approval-expired' : ''}`}
              data-request-id={c.requestId}
            >
              <div className="approval-card-main">
                <b>{c.tool}</b>
                <span className="approval-args">{argsSummary(c.args)}</span>
              </div>
              <div className="approval-card-meta">
                {c.cwd !== undefined && <span>cwd: {c.cwd}</span>}
                {c.scope !== undefined && <span>范围: {c.scope === 'once' ? '一次' : '本会话'}</span>}
                {c.taskStateLabel !== undefined && <span>任务状态: {c.taskStateLabel}</span>}
                {c.expiresAt !== undefined && <span>过期: {c.expiresAt}</span>}
              </div>
              {c.expired ? (
                <div className="approval-note">已过期（服务端会拒收迟到决策）</div>
              ) : (
                <div className="approval-actions">
                  {store.isApprovalResponding(c.requestId) ? (
                    <span className="approval-note">提交中…（防重复提交）</span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn-allow"
                        onClick={() => void controller.respondApproval(c.requestId, 'allow')}
                      >
                        允许
                      </button>
                      <button
                        type="button"
                        className="btn-deny"
                        onClick={() => void controller.respondApproval(c.requestId, 'deny')}
                      >
                        拒绝（不执行）
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
