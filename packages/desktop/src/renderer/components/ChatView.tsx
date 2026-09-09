// 消息流（B3-2 拆分产物）：ChatItemView / ChatView（气泡、tool 行、diff 卡、审批条、输入框）。
// 原 App.tsx 第 319–547 行逐字搬入；状态与 controller 来自 ../app-shared。
import { useEffect, useRef, useState } from 'react';
import { displayToolName, type ChatItem } from '../chat-model.js';
import { resolveFileRefs } from '../../shared/file-ref.js';
import { DiffCard } from './DiffCard.js';
import { controller, store, targetPaneFor, useAppState } from '../app-shared.js';

/** 参数摘要（工具行/审批按钮用；单行 ≤80 字） */
function argsSummary(args: unknown): string {
  if (args === undefined) return '';
  const one = JSON.stringify(args) ?? '';
  return one.length <= 80 ? one : `${one.slice(0, 80)}…`;
}

/** write/edit 的目标文件（args.file_path；缺失返回 undefined，供 diff 卡标题兜底） */
function diffTargetFile(args: unknown): string | undefined {
  if (typeof args === 'object' && args !== null) {
    const fp = (args as Record<string, unknown>)['file_path'];
    if (typeof fp === 'string' && fp.length > 0) return fp;
  }
  return undefined;
}

/** 子会话跳转按钮（阶段 8）：在空分栏（缺省第一栏）打开子会话轨迹 */
function SubagentJump({ childSessionId }: { childSessionId: string }) {
  const state = useAppState();
  return (
    <button
      type="button"
      className="subagent-jump"
      title={`打开子会话 ${childSessionId} 轨迹`}
      onClick={() => {
        void controller.assignToPane(targetPaneFor(state), childSessionId);
      }}
    >
      子会话 {childSessionId} ↗
    </button>
  );
}

export function ChatItemView({ item, sessionId }: { item: ChatItem; sessionId?: string }) {
  switch (item.kind) {
    case 'turn-header':
      return <div className="turn-header">── turn</div>;
    case 'user':
      return (
        <div className="bubble-user">
          <span className="role">你</span>
          <div className="text">{item.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="bubble-assistant">
          <span className="role">{item.model ?? '助手'}</span>
          {item.reasoning !== undefined && item.reasoning.length > 0 && (
            <details className="reasoning">
              <summary>思考过程</summary>
              <div className="reasoning-body">{item.reasoning}</div>
            </details>
          )}
          <div className="text">{item.text}</div>
        </div>
      );
    case 'tool': {
      const jump = item.childSessionId;
      // B5 diff 卡片：write/edit 成功且有快照序（seq = rewind_points.jsonl 条目键）时展示真实红绿 diff
      const showDiff = (item.tool === 'write' || item.tool === 'edit') && sessionId !== undefined;
      const targetFile = diffTargetFile(item.args);
      return (
        <div className={`tool-entry${item.result ? (item.result.ok ? 'tool-ok' : 'tool-fail') : 'tool-pending'}`}>
          <div className={`tool-row ${item.result ? (item.result.ok ? 'tool-ok' : 'tool-fail') : 'tool-pending'}`}>
            <span className="tool-line">
              &gt; {displayToolName(item.tool)} ({argsSummary(item.args)})
            </span>
            {item.result === undefined ? (
              <span className="tool-status">运行中…</span>
            ) : (
              <span className="tool-status">
                {item.result.ok ? 'ok' : `FAILED${item.result.error !== undefined ? `: ${item.result.error}` : ''}`}
              </span>
            )}
            {jump !== undefined && <SubagentJump childSessionId={jump} />}
          </div>
          {showDiff && item.result?.ok && (
            <DiffCard
              sessionId={sessionId}
              seq={item.seq}
              file={targetFile}
              onUndo={() => void controller.undoSession(sessionId)}
            />
          )}
        </div>
      );
    }
    case 'attempt':
      return <div className="attempt-row">尝试失败：{item.error}</div>;
    case 'streaming':
      return (
        <div className="bubble-assistant streaming">
          {item.tool !== undefined ? (
            <div className="tool-row tool-pending">
              <span className="tool-line">
                &gt; {displayToolName(item.tool)} ({argsSummary(item.args)})
              </span>
              <span className="tool-status">运行中…</span>
            </div>
          ) : (
            <div className="text">
              {item.reasoning !== undefined && item.reasoning.length > 0 && (
                <div className="reasoning-inline">（思考中…）</div>
              )}
              {item.text}
              <span className="cursor">▌</span>
            </div>
          )}
        </div>
      );
    case 'turn-summary':
      return (
        <div className="turn-summary">
          [{item.stopReason ?? '已完成'}
          {item.durationMs !== undefined && item.durationMs > 0 ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ''}]
          {item.error !== undefined && <span className="sum-err"> {item.error}</span>}
          {item.warning !== undefined && <span className="sum-warn"> {item.warning}</span>}
        </div>
      );
  }
}

export function ChatView({ streamId }: { streamId: string | null }) {
  const state = useAppState();
  const stream = streamId !== null ? store.peekStream(streamId) : undefined;
  const items = streamId !== null ? store.chatItems(streamId) : [];
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, streamId]);

  if (streamId === null) {
    return (
      <div className="chat empty-pane">
        <p>从左侧拖会话到此分屏</p>
      </div>
    );
  }
  if (stream === undefined || !stream.loaded) {
    return (
      <div className="chat empty-pane">
        <p>加载会话…</p>
      </div>
    );
  }

  const draftText = draft.trim();
  const send = (): void => {
    if (draftText.length === 0 || stream.running) return;
    setDraft('');
    // B8 @file 引用：文本含 @ 且当前会话有 cwd → 经 IPC 解析并把代码块拼到消息最前。
    // cwd 未知/为空时按无 @ 处理（不报错、不发 IPC）；UI 输入框内容保持不变（用户仍看到原文本）。
    const session = streamId !== null ? state.sessions.find((s) => s.id === streamId) : undefined;
    const cwd = session?.cwd;
    if (cwd && cwd.length > 0 && draftText.includes('@')) {
      void resolveFileRefs(draftText, cwd, (path, c) => window.harness2.readFileForRef(path, c)).then(
        ({ finalText }) => {
          void controller.sendMessage(streamId!, finalText);
        },
      );
      return;
    }
    void controller.sendMessage(streamId!, draftText);
  };

  return (
    <div className="chat">
      <div className="messages" ref={scrollRef}>
        {items.map((item, i) => (
          <ChatItemView key={item.callId ?? item.seq ?? `i${i}`} item={item} sessionId={streamId} />
        ))}
        {items.length === 0 && <div className="empty-state">发送第一条消息开始对话</div>}
      </div>
      {stream.approvals.length > 0 && (
        <div className="approval-bar">
          {stream.approvals.map((a) => (
            <div key={a.requestId} className="approval-item">
              <span>
                允许执行 <b>{a.tool}</b>？{argsSummary(a.args)}
              </span>
              <button
                type="button"
                className="btn-allow"
                onClick={() => void controller.respondApproval(a.requestId, 'allow')}
              >
                允许
              </button>
              <button
                type="button"
                className="btn-deny"
                onClick={() => void controller.respondApproval(a.requestId, 'deny')}
              >
                拒绝
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer">
        <textarea
          value={draft}
          placeholder={state.status === 'connected' ? '输入消息（Enter 发送，Shift+Enter 换行）' : '服务未连接…'}
          disabled={state.status !== 'connected'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {stream.running ? (
          <button type="button" className="btn-stop" onClick={() => void controller.abort(streamId)}>
            ■ 停止
          </button>
        ) : (
          <button type="button" className="btn-send" disabled={draftText.length === 0} onClick={send}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
