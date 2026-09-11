// 任务面板（D3）：父子归属清楚的任务树 + 单任务停止（不误伤兄弟）。
// 数据全部来自真实任务快照（resume-snapshot / 任务帧），不做本地模拟。
import { controller, store, useAppState } from '../../app-shared.js';
import { buildTaskTree, isTerminalTaskState, summarizeTasks } from './plan-model.js';

export function TaskPanel({ sessionId }: { sessionId: string | null }) {
  useAppState();
  const all = store.allTasks();
  const scoped = sessionId !== null ? all.filter((t) => t.sessionId === sessionId) : all;
  const tasks = scoped.map((t) => t.task);
  const summary = summarizeTasks(tasks);
  const tree = buildTaskTree(tasks);

  if (tasks.length === 0) {
    return (
      <div className="panel task-panel">
        <div className="panel-head">
          <span>任务</span>
        </div>
        <div className="panel-empty">本会话暂无任务快照（子任务/后台任务出现后在此展示；不会显示占位任务）</div>
      </div>
    );
  }

  const renderNode = (node: (typeof tree)[number], depth: number): React.ReactNode => (
    <div key={node.task.taskId} className={`task-node task-${node.task.state}`} style={{ marginLeft: depth * 16 }}>
      <div className="task-row">
        <span className="task-id">{node.task.taskId}</span>
        <span className={`task-state task-state-${node.task.state}`}>{node.stateLabel}</span>
        {node.task.background && <span className="task-bg">后台</span>}
        {node.orphan && <span className="task-orphan">父任务不在快照中</span>}
        {node.task.expectedTurnId !== undefined && <span className="task-turn">turn {node.task.expectedTurnId}</span>}
        {!isTerminalTaskState(node.task.state) && (
          <button
            type="button"
            className="btn-stop-task"
            title="只停止该任务，不影响兄弟任务"
            onClick={() => void controller.cancelTask(node.task.taskId)}
          >
            停止
          </button>
        )}
      </div>
      {node.children.map((c) => renderNode(c as typeof node, depth + 1))}
    </div>
  );

  return (
    <div className="panel task-panel">
      <div className="panel-head">
        <span>任务</span>
        <span className="panel-mode">
          运行中 {summary.running} · 等审批 {summary.waitingApproval} · 终态 {summary.terminal} / 共 {summary.total}
        </span>
      </div>
      <div className="task-tree">{tree.map((n) => renderNode(n, 0))}</div>
    </div>
  );
}
