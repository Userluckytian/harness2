// 消息流（B3-2 拆分产物；D2 接真实命令日志 + 稳定滚动）。
// ChatItemView / ChatTranscript（气泡、tool 行、命令日志、diff 卡、审批条、可见队列）。
//
// P5-C 收敛：本文件**不再自带输入框** —— 对话页的唯一 composer 是
// `renderer/conversation/composer/Composer.tsx`（由 `conversation/assembly.tsx` 装配）。
// 原内建 textarea / send() / 草稿读写 / @引用解析随之删除（避免两套输入互相打架）；
// 这里只保留转录渲染，作为视图环的 `chat` 视图内容。
// 数据源（store/controller）由调用方经 props 传入（视图环从会话对象取），不在此抓全局单例。
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Controller } from '../app-controller.js';
import { displayToolName, type ChatItem } from '../chat-model.js';
import { composeQueueView } from '../features/composer/composer-model.js';
import { CommandLog } from '../features/timeline/CommandLog.js';
import { buildToolRow, isAtBottom, nextScrollTop } from '../features/timeline/execution-log.js';
import type { AppStore } from '../store.js';
import { DiffCard } from './DiffCard.js';

/** 转录视图的数据源（store + controller 真身；由会话对象携带） */
export interface ChatTranscriptDeps {
  readonly store: AppStore;
  readonly controller: Controller;
}

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

/** 子会话跳转按钮（阶段 8 / P4-C）：打开子会话（选中 + 全量重放 + 拉齐只读视图） */
function SubagentJump({ childSessionId, controller }: { childSessionId: string; controller: Controller }) {
  return (
    <button
      type="button"
      className="subagent-jump"
      title={`打开子会话 ${childSessionId} 轨迹`}
      onClick={() => {
        // P4-C：分栏（PaneArea）已拆除，分栏状态无渲染出口 → 走「选会话」同一路径，
        // 不再经 assignToPane 写已废弃的 pane 绑定。
        void controller.selectSession(childSessionId);
      }}
    >
      子会话 {childSessionId} ↗
    </button>
  );
}

export function ChatItemView({
  item,
  sessionId,
  store,
  controller,
}: {
  item: ChatItem;
  sessionId?: string;
  store: AppStore;
  controller: Controller;
}) {
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
      // D2：有 S7 执行视图（真实 shell/cwd/exitCode/输出归属）时优先渲染命令日志卡
      const view =
        sessionId !== undefined
          ? store.peekViews(sessionId)?.executionViews.find((v) => v.callId === item.callId)
          : undefined;
      const commandRow = view !== undefined ? buildToolRow(item, view) : undefined;
      const showCommandLog =
        commandRow !== undefined &&
        (commandRow.tool === 'bash' || commandRow.outputRef.length > 0 || commandRow.status === 'cancelled');
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
            {jump !== undefined && <SubagentJump childSessionId={jump} controller={controller} />}
          </div>
          {showDiff && item.result?.ok && (
            <DiffCard
              sessionId={sessionId}
              seq={item.seq}
              file={targetFile}
              onUndo={() => void controller.undoSession(sessionId)}
            />
          )}
          {showCommandLog && commandRow !== undefined && (
            <CommandLog row={commandRow} displayName={displayToolName(item.tool)} />
          )}
        </div>
      );
    }
    case 'attempt':
      return (
        <div className="attempt-row">
          尝试失败：{item.error}
          {/* P3-b：半截文本必须显式标注「未完成 / 已中断」，不得当作完整正文 */}
          {item.text !== undefined && item.text.length > 0 && (
            <details className="attempt-partial">
              <summary>未完成 / 已中断的产出（{item.text.length} 字）</summary>
              <pre>{item.text}</pre>
            </details>
          )}
        </div>
      );
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
          {/* P3-b：partial 必须标注未完成/已中断（半截文本不得当完整正文） */}
          {item.textOutcome === 'partial' && (
            <span className="sum-partial">
              {' '}
              未完成 / 已中断
              {item.partialText !== undefined && item.partialText.length > 0 && (
                <details className="attempt-partial">
                  <summary>半截产出（{item.partialText.length} 字）</summary>
                  <pre>{item.partialText}</pre>
                </details>
              )}
            </span>
          )}
          {/* P3-a：empty 不得留空白气泡——只展示停因/错误与已执行工具行 */}
          {item.textOutcome === 'empty' && <span className="sum-empty"> 无最终文本（见上方工具行/错误）</span>}
        </div>
      );
  }
}

/**
 * 会话转录视图（视图环 `chat` 视图的内容；P5-C 起不再含输入框）。
 * 消息流 + 审批条 + 可见队列；输入由 `conversation/composer` 的常驻 Composer 承担。
 */
export function ChatTranscript({ streamId, store, controller }: ChatTranscriptDeps & { streamId: string }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const stream = store.peekStream(streamId);
  const items = store.chatItems(streamId);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 渲染前是否贴底（决定新内容到达时是否跟随滚动） */
  const wasAtBottomRef = useRef(true);

  // D2 稳定滚动：仅当**之前**贴底时跟随到底；用户上滚阅读历史时不被新帧拽回底部。
  // 内容变化前先记录贴底状态（effect 在 DOM 更新后运行，用 ref 保存的是上一轮的真实位置）。
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const before = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    const target = nextScrollTop(before, { scrollHeight: el.scrollHeight }, wasAtBottomRef.current);
    if (target !== null) el.scrollTop = target;
  }, [items, streamId]);

  const onMessagesScroll = (): void => {
    const el = scrollRef.current;
    if (el !== null) wasAtBottomRef.current = isAtBottom(el);
  };

  if (stream === undefined || !stream.loaded) {
    return (
      <div className="chat empty-pane">
        <p>{state.status === 'connected' ? '加载会话…' : '服务未连接…'}</p>
      </div>
    );
  }

  const queueView = composeQueueView({
    queue: stream.queue,
    pendingSubmits: stream.pendingSubmits,
    submitAcks: stream.submitAcks,
  });
  // D1/P1-1：本轮 `@path` 引用来源报告（哪些进了上下文、哪些被拒及原因）—— 引用结果必须可见
  const refReport = store.peekRefReport(streamId);

  return (
    <div className="chat">
      <div className="messages" ref={scrollRef} onScroll={onMessagesScroll}>
        {items.map((item, i) => (
          <ChatItemView
            key={item.callId ?? item.seq ?? `i${i}`}
            item={item}
            sessionId={streamId}
            store={store}
            controller={controller}
          />
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
      {refReport !== undefined &&
        refReport.sources.length + refReport.skipped.length + refReport.notFound.length > 0 && (
          <div className="ref-report" aria-label="引用来源">
            {refReport.sources.length > 0 && (
              <span className="ref-sources">
                引用：{refReport.sources.map((s) => `${s.token}(${s.bytes}B${s.truncated ? ' 截断' : ''})`).join(' ')}
              </span>
            )}
            {refReport.skipped.map((s) => (
              <span key={s.token} className="ref-skipped">
                {s.token} 未纳入（{s.reason === 'binary' ? '二进制' : '超出字节预算'}）
              </span>
            ))}
            {refReport.notFound.map((t) => (
              <span key={t} className="ref-missing">
                {t} 未找到
              </span>
            ))}
          </div>
        )}
      {queueView.length > 0 && (
        <div className="queue-bar" aria-label="待发送队列">
          {queueView.map((q) => (
            <div key={q.id} className={`queue-item queue-${q.kind}`}>
              <span className="queue-kind">
                {q.kind === 'queued'
                  ? '排队'
                  : q.kind === 'paused'
                    ? '暂停'
                    : q.kind === 'pending'
                      ? '待确认'
                      : '未确认'}
              </span>
              <span className="queue-text">{q.text}</span>
              {q.note !== undefined && <span className="queue-note">{q.note}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
