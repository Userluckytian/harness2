// 有效配置 / 上下文面板（D6 / F2/F8）：显示本轮**实际生效**的配置与上下文，全部来自 S7 `/run-config`。
// 红线：不臆造配置；密钥不出现在界面；无能力/无配置给可行动提示（不摆假入口）。
import { useEffect, useState } from 'react';
import { capabilityEnabled, capabilityReason, CAPABILITY_LABELS } from '../../../shared/capabilities.js';
import type { CapabilityIdShape } from '../../../shared/protocol.js';
import { controller, store, useAppState } from '../../app-shared.js';
import { cancelStateLabel, deriveRuntimeStatus } from '../runtime/runtime-status.js';

/** 能力行（不可用时 disabled + 原因，不摆可点假入口） */
function CapabilityRow({ id }: { id: CapabilityIdShape }) {
  const state = useAppState();
  const report = state.capabilities;
  const enabled = capabilityEnabled(report, id);
  const reason = capabilityReason(report, id);
  return (
    <div className={`cap-row${enabled ? '' : ' cap-off'}`}>
      <span className="cap-name">{CAPABILITY_LABELS[id]}</span>
      <span className="cap-state">{report === undefined ? '未探测' : enabled ? '可用' : '不可用'}</span>
      {!enabled && reason !== undefined && <span className="cap-reason">{reason}</span>}
    </div>
  );
}

export function EffectiveConfigPanel({ sessionId }: { sessionId: string | null }) {
  const state = useAppState();
  const [usage, setUsage] = useState<{ usage: number | null; label: string } | null>(null);

  useEffect(() => {
    if (sessionId === null) {
      setUsage(null);
      return;
    }
    let cancelled = false;
    void window.harness2
      .getContextUsage(sessionId)
      .then((u) => {
        if (!cancelled) setUsage(u);
      })
      .catch(() => {
        if (!cancelled) setUsage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (sessionId === null) return <div className="panel-empty">未选择会话</div>;
  const views = store.peekViews(sessionId);
  const rc = views?.runConfig;
  if (rc === undefined) {
    return (
      <div className="panel config-panel">
        <div className="panel-head">
          <span>有效配置</span>
        </div>
        <div className="panel-empty">
          {views?.errors.runConfig ??
            '尚未载入有效配置：serve 未连接或会话未就绪（连接后自动载入；此处不显示占位配置）'}
        </div>
        <div className="panel-foot">
          <button type="button" onClick={() => void controller.refreshRunConfig(sessionId)}>
            重新载入
          </button>
          <button type="button" onClick={() => void controller.refreshCapabilities(sessionId)}>
            重新盘点能力
          </button>
        </div>
      </div>
    );
  }

  const retry = rc.context.retry;
  // D4：运行态（不永久 loading：断流/未连接都如实说出来）+ 最近一次取消结论（不假报停止）
  const stream = store.peekStream(sessionId);
  const runtime = deriveRuntimeStatus({
    running: stream?.running === true,
    approvals: stream?.approvals.length ?? 0,
    ...(stream?.lastFrameAt !== undefined ? { lastFrameAt: stream.lastFrameAt } : {}),
    hasActiveAttempt: stream?.activeAttempt !== undefined,
    connection: state.status,
  });
  const lastCancel = Object.entries(state.cancelAcks).at(-1);
  return (
    <div className="panel config-panel">
      <div className="panel-head">
        <span>有效配置</span>
        <span className="panel-mode">
          revision {rc.snapshot.revision} · {rc.redacted ? '已脱敏' : ''}
        </span>
      </div>
      <div className={`runtime-row runtime-${runtime.state}`}>
        <span className="runtime-label">{runtime.label}</span>
        {runtime.hint !== undefined && <span className="runtime-hint">{runtime.hint}</span>}
        {lastCancel !== undefined && (
          <span className="runtime-cancel">最近取消：{cancelStateLabel(lastCancel[1])}</span>
        )}
      </div>
      <dl className="config-list">
        <dt>会话 cwd</dt>
        <dd>
          {rc.session.cwd}
          {!rc.session.perSessionCwd && <span className="config-note">（未配置会话 cwd，回退 root）</span>}
        </dd>
        <dt>项目 root</dt>
        <dd>{rc.session.root}</dd>
        <dt>模型 / 渠道</dt>
        <dd>
          {rc.provider.role} · {rc.provider.channel} / {rc.provider.model}（{rc.provider.protocol}）
        </dd>
        <dt>审批模式</dt>
        <dd>
          {rc.approval.mode}
          {Object.keys(rc.approval.tools).length > 0 && (
            <span className="config-note">
              （规则：
              {Object.entries(rc.approval.tools)
                .map(([k, v]) => `${k}=${v}`)
                .join('、')}
              ）
            </span>
          )}
        </dd>
        <dt>记忆模式</dt>
        <dd>{rc.modes.memory}</dd>
        <dt>连接状态</dt>
        <dd>{rc.connection.status === 'unknown' ? '未探测（不臆造 connected）' : rc.connection.status}</dd>
        <dt>上下文窗口</dt>
        <dd>
          {rc.context.contextWindow !== undefined ? `${rc.context.contextWindow} tokens` : '未声明'}
          {usage !== null && <span className="config-note">（当前占用 {usage.label}）</span>}
        </dd>
        <dt>重试预算</dt>
        <dd>
          额外 {retry.maxExtraAttempts} 次 / 退避 {retry.backoffSeconds.join(',')}s / 上限 {retry.maxTotalWaitSeconds}s
          {retry.budget !== undefined && (
            <span className="config-note">
              （本 turn 已用 {retry.budget.usedAttempts}，剩余 {retry.budget.remainingAttempts}；停因：
              {retry.budget.stopReason}）
            </span>
          )}
        </dd>
        <dt>可用工具</dt>
        <dd className="config-tools">{rc.tools.join(' ')}</dd>
        <dt>指令 / skill 来源</dt>
        <dd>
          {rc.instructions.skills.length === 0
            ? '（无 skill）'
            : rc.instructions.skills.map((s) => `${s.name}@${s.source}`).join('、')}
        </dd>
      </dl>
      <div className="panel-head cap-head">能力盘点</div>
      <div className="cap-list">
        <CapabilityRow id="serve" />
        <CapabilityRow id="run-config" />
        <CapabilityRow id="plan-state" />
        <CapabilityRow id="execution-view" />
        <CapabilityRow id="change-review" />
        <CapabilityRow id="queue" />
        <CapabilityRow id="steer" />
        <CapabilityRow id="cancel" />
        <CapabilityRow id="fork" />
        <CapabilityRow id="resume-subscription" />
      </div>
      <div className="panel-foot">
        <button type="button" onClick={() => void controller.refreshRunConfig(sessionId)}>
          重新载入
        </button>
        <button type="button" onClick={() => void controller.refreshCapabilities(sessionId)}>
          重新盘点能力
        </button>
      </div>
    </div>
  );
}
