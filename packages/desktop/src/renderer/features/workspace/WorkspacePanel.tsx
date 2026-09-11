// 工作区面板（D5/F1）：显示本次请求到底在哪个目录跑（root/cwd）+ 分叉会话 + 会话工作区一览。
// A/B 项目隔离以真实 run-config 的 cwd 为准（不猜、不共享 UI 状态）。
import { useState } from 'react';
import { controller, store, useAppState } from '../../app-shared.js';
import { sameWorkspace, workspaceInfoFrom } from './change-review-model.js';

export function WorkspacePanel({ sessionId }: { sessionId: string | null }) {
  const state = useAppState();
  const [notice, setNotice] = useState<string | null>(null);
  const current = workspaceInfoFrom(
    sessionId ?? '',
    sessionId !== null ? store.peekViews(sessionId)?.runConfig : undefined,
  );

  const visibleSessions = state.sessions.filter((s) => s.id === sessionId || store.peekViews(s.id) !== undefined);

  return (
    <div className="panel workspace-panel">
      <div className="panel-head">
        <span>工作区</span>
        {current !== null && (
          <span className="panel-mode">{current.perSessionCwd ? '会话独立 cwd' : '回退项目 root'}</span>
        )}
      </div>
      {sessionId === null ? (
        <div className="panel-empty">未选择会话</div>
      ) : (
        <>
          <div className="ws-current">
            <div>会话：{sessionId}</div>
            <div>cwd：{current?.cwd ?? '（未载入，点刷新）'}</div>
            <div>root：{current?.root ?? '（未载入）'}</div>
          </div>
          <div className="panel-foot">
            <button type="button" onClick={() => void controller.refreshRunConfig(sessionId)}>
              刷新工作区
            </button>
            <button
              type="button"
              title="从当前会话末端分叉出一个新会话（原会话不变）"
              onClick={() => {
                void controller.forkSession(sessionId);
                setNotice('已请求分叉（原会话不变；新会话出现在左侧列表）');
              }}
            >
              分叉会话
            </button>
          </div>
          {notice !== null && <div className="panel-notice">{notice}</div>}
          {store.peekViews(sessionId)?.runConfig === undefined && (
            <div className="panel-empty">尚无有效配置：连接 serve 后自动载入（此处不显示占位数据）</div>
          )}
          {visibleSessions.length > 1 && (
            <div className="ws-list">
              <div className="ws-list-head">已知工作区（已载入配置的会话）</div>
              {visibleSessions.map((s) => {
                const info = workspaceInfoFrom(s.id, store.peekViews(s.id)?.runConfig);
                return (
                  <div key={s.id} className={`ws-item${s.id === sessionId ? ' ws-item-current' : ''}`}>
                    <span className="ws-session">{s.id}</span>
                    <span className="ws-cwd">{info?.cwd ?? '（未载入）'}</span>
                    {current !== null && info !== null && !sameWorkspace(current, info) && (
                      <span className="ws-diff" title="与当前会话不在同一 cwd（项目不串）">
                        不同工作区
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
