// 计划面板（D3）：有证据的计划投影 + **显式**模式切换（展示计划绝不自动提权）。
import { useState } from 'react';
import { controller, store, useAppState } from '../../app-shared.js';
import { buildPlanDisplay, resolveModeSwitch } from './plan-model.js';

export function PlanPanel({ sessionId }: { sessionId: string | null }) {
  useAppState(); // 订阅 store 变更（计划/配置到达后重渲）
  const [notice, setNotice] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  if (sessionId === null) return <div className="panel-empty">未选择会话</div>;
  const views = store.peekViews(sessionId);
  const display = buildPlanDisplay(views?.planState);
  const runConfig = views?.runConfig;
  const currentMode = runConfig?.approval.mode ?? '（未知）';

  const switchMode = (to: 'default' | 'plan'): void => {
    // 显式动作：这里 explicit=true 由「用户点击」这一事实决定；纯函数再校验一次语义
    const result = resolveModeSwitch(currentMode, to, true);
    if (!result.changed) {
      setNotice(result.reason ?? '模式未变化');
      return;
    }
    // P2-4：点击必须落地 —— 真实写入全局 config.json 的 approval.mode
    // （settings:updateConfig 白名单深合并，密钥类字段被拒、写前经 parseConfig 校验）。
    // 作用范围如实展示：当前会话的 effective run-config 是创建期快照，新会话起生效。
    setSwitching(true);
    void controller
      .setApprovalMode(sessionId, to)
      .then((res) => setNotice(res.message))
      .catch((e: unknown) => setNotice(`切换失败：${(e as Error).message}`))
      .finally(() => setSwitching(false));
  };

  const modeSwitchButtons = (
    <div className="mode-switch">
      <span>切换权限是显式动作：</span>
      <button type="button" onClick={() => switchMode('default')} disabled={switching || currentMode === 'default'}>
        切到 default
      </button>
      <button type="button" onClick={() => switchMode('plan')} disabled={switching || currentMode === 'plan'}>
        切到 plan（只读）
      </button>
    </div>
  );

  if ('plan' in display) {
    return (
      <div className="panel plan-panel">
        <div className="panel-head">
          <span>计划</span>
          <span className="panel-mode">审批模式：{currentMode}</span>
        </div>
        <div className="panel-empty">{display.reason}</div>
        {modeSwitchButtons}
        {notice !== null && <div className="panel-notice">{notice}</div>}
      </div>
    );
  }

  return (
    <div className="panel plan-panel">
      <div className="panel-head">
        <span>计划</span>
        <span className="panel-mode">审批模式：{currentMode}</span>
      </div>
      <div className="plan-goal">
        目标：{display.goal.length > 0 ? display.goal : '（无可重建来源）'}
        {display.goalEvidence !== undefined && (
          <span className="plan-goal-evidence">
            {' '}
            证据：seq {display.goalEvidence.seq}（{display.goalEvidence.anchor.kind}）
          </span>
        )}
      </div>
      <div className="plan-progress">
        planId: {display.planId} · 完成 {display.completed}/{display.total} · 只读投影
      </div>
      <ol className="plan-steps">
        {display.steps.map((s) => (
          <li key={s.stepId} className={`plan-step plan-step-${s.state}`}>
            <span className="step-id">{s.stepId}</span>
            <span className="step-state">{s.stateLabel}</span>
            <span className="step-evidence" title={`来源：${s.evidenceSource}`}>
              证据 seq: {s.journalSeqs.length > 0 ? s.journalSeqs.join(',') : '（无）'}
            </span>
          </li>
        ))}
      </ol>
      <div className="mode-switch">
        <span>切换权限是显式动作（展示计划不会提权）：</span>
      </div>
      {modeSwitchButtons}
      {notice !== null && <div className="panel-notice">{notice}</div>}
      <div className="panel-foot">
        <button type="button" onClick={() => void controller.refreshPlanState(sessionId)}>
          刷新计划
        </button>
      </div>
    </div>
  );
}
