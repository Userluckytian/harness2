// 消息流（B3-2 拆分产物；D2 接真实命令日志 + 稳定滚动）。
// ChatItemView / ChatTranscript（气泡、tool 行、命令日志、diff 卡、审批条、可见队列）。
//
// P5-C 收敛：本文件**不再自带输入框** —— 对话页的唯一 composer 是
// `renderer/conversation/composer/Composer.tsx`（由 `conversation/assembly.tsx` 装配）。
// 原内建 textarea / send() / 草稿读写 / @引用解析随之删除（避免两套输入互相打架）；
// 这里只保留转录渲染，作为视图环的 `chat` 视图内容。
// 数据源（store/controller）由调用方经 props 传入（视图环从会话对象取），不在此抓全局单例。
//
// P6-C 收敛（D-6x 模块边界）：工具卡与审批条不再是本文件的内联实现 ——
//   tool 行 → `renderer/tool`（ToolCard：单一视图卡片 + D-86 的 openFile/inspect 路由）
//   审批 → **不在本文件**：按 Z-20 已迁到会话底部 dock（`renderer/approval/ApprovalDock`，由会话席位渲染）
// 本文件只负责「聊天条目 → 该用哪个卡片」的装配（数据由 store/controller 注入）。
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Controller } from '../app-controller.js';
import type { ChatItem } from '../chat-model.js';
import { buildToolRow, isAtBottom, nextScrollTop } from '../features/timeline/execution-log.js';
import { activeTurnIdOf, deriveTurns, jumpToTurn, TurnNavigator } from '../conversation/turn-navigator.js';
import { ToolCard, controllerToolActions, toolCardFromItem, toolJumpActions, toolNavigation } from '../tool/index.js';
import { ConversationEmptyState } from '../conversation/EmptyState.js';
import { WorkIndicator } from '../conversation/turn-work.js';
import { MessageActions } from './MessageActions.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { ReasoningRow } from './ReasoningRow.js';
import { TimelineMarkerRow } from '../conversation/TimelineMarkerRow.js';
import { QUOTE_ORIGIN_ATTR, SelectionAskLayer } from './selection-ask.js';
import type { AppStore } from '../store.js';

/** 转录视图的数据源（store + controller 真身；由会话对象携带） */
export interface ChatTranscriptDeps {
  readonly store: AppStore;
  readonly controller: Controller;
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
      // Z2-09b：data-turn-id 是轮次导航的定位锚点（jumpToTurn / activeTurnIdOf 查询此属性）。
      // P0-1：移除字面 `── turn` —— ZCode 是**分组渲染**，不渲染轮次文案；本行只作无文字分组
      // 分隔（G15：纯留白 padding-top，见 shell.css .turn-header，**无分隔线**），
      // 并保留 `.turn-header` 类名供结构断言。
      // Z-97（T4b）：轮次耗时行挂本头（running「工作中」自持 tick / 终态「已工作」「已停止」
      // 静态锁定 / synthetic「已停止（无响应超时）」）；字段缺省（旧数据无 ts/无终态时刻）
      // → WorkIndicator 返回 null，本行回到零内容纯留白（既有结构断言不破）。
      return (
        <div className="turn-header" data-turn-id={item.turnId}>
          <WorkIndicator
            {...(item.workStartedAt !== undefined ? { startedAt: item.workStartedAt } : {})}
            {...(item.workRunning !== undefined ? { running: item.workRunning } : {})}
            {...(item.workDurationMs !== undefined ? { durationMs: item.workDurationMs } : {})}
            {...(item.synthetic !== undefined ? { synthetic: item.synthetic } : {})}
            {...(item.stopReason !== undefined ? { stopReason: item.stopReason } : {})}
          />
        </div>
      );
    case 'user':
      // P0-1：对齐 ZCode `MessageContent`（message.tsx:114,127）——用户消息右对齐 + 圆角气泡
      // + bg-secondary + px-4 py-3；**不渲染角色标签**（ZCode 无「你」标签）。
      // Z4-03：`data-quote-origin` = 划词「询问」的可引用来源标记（selection-ask 按它辨认）
      return (
        <div className="bubble-user" {...{ [QUOTE_ORIGIN_ATTR]: 'user' }}>
          <div className="text">{item.text}</div>
        </div>
      );
    case 'assistant': {
      // P0-1：助手消息**无气泡**（正常流，无背景）；移除 provider 名角色标签。
      // Z-92：reasoning 是**一等行**（独立可折叠行，ReasoningRow），不再是气泡内嵌 <details>；
      // Fragment 摊平进 .messages 弹性列 → 思考行与正文是两个独立行。
      // P0-1 消息行内动作：hover 显现（复制 / 分叉；赞踩刻意不做 —— 无后端反馈通道）。
      // 分叉走既有通道 `controller.forkSession(sessionId, seq)`；会话运行中禁用（「任务结束后可分叉」）。
      const running = sessionId !== undefined && store.peekStream(sessionId)?.running === true;
      const canFork = sessionId !== undefined && item.seq !== undefined;
      return (
        <>
          {item.reasoning !== undefined && item.reasoning.length > 0 && <ReasoningRow text={item.reasoning} />}
          <div className="bubble-assistant" {...{ [QUOTE_ORIGIN_ATTR]: 'assistant' }}>
            {/* U2 批E（E-a）：助手正文 = Markdown（ZCode 基线）。完成态/历史**一律 static**
                （ZCode 实证 streaming 用于历史消息触发 React #185 无限更新）。 */}
            <div className="text">
              <MarkdownBlock text={item.text ?? ''} />
            </div>
            <MessageActions
              text={item.text ?? ''}
              {...(canFork
                ? {
                    onFork: () => controller.forkSession(sessionId, item.seq),
                    forkEnabled: !running,
                  }
                : {})}
            />
          </div>
        </>
      );
    }
    case 'tool': {
      // D2：有 S7 执行视图（真实 shell/cwd/exitCode/输出归属）时优先渲染命令日志卡；
      // 无执行视图时 buildToolRow 按结果字段如实降级（D-86：运行中的 bash/pwsh 也是 terminal 卡片）。
      const view =
        sessionId !== undefined
          ? store.peekViews(sessionId)?.executionViews.find((v) => v.callId === item.callId)
          : undefined;
      const commandRow = buildToolRow(item, view);
      // D-86 ①/②：文件路径 → 右栏（真实现）；inspect → 轨迹视图（未装配时动作缺省 → 按钮不渲染）
      // 登记（已知边界）：这里用**模块单例** `toolNavigation` 而非 `useToolNavigation()` 的 Context ——
      // 生产路径两者等价（应用未包 Provider，Context 默认值就是该单例）；但测试若注入自建实例，
      // ChatView 仍读单例会「分裂」。改法：把 ToolNavigationProvider 包到应用根，再改用 hook。
      const jumps = toolJumpActions(toolNavigation);
      const actions = {
        ...controllerToolActions(controller, sessionId),
        onOpenFile: jumps.openFile,
        ...(jumps.inspect !== undefined ? { onInspect: jumps.inspect } : {}),
      };
      return (
        <ToolCard
          card={toolCardFromItem(item)}
          {...(sessionId !== undefined ? { sessionId } : {})}
          commandRow={commandRow}
          actions={actions}
        />
      );
    }

    case 'marker': {
      // Z-92 timelineMarker（Z3-07）：压缩边界 / 回退标记 / 失败尝试（retryNotice 语义）
      // 统一走标记行；variant 由投影保证（三种来源事件各自固定），缺失时不造语义、不渲染。
      if (item.variant === undefined) return null;
      return (
        <TimelineMarkerRow
          variant={item.variant}
          {...(item.summary !== undefined ? { summary: item.summary } : {})}
          {...(item.rewindToSeq !== undefined ? { rewindToSeq: item.rewindToSeq } : {})}
          {...(item.error !== undefined ? { error: item.error } : {})}
          {...(item.text !== undefined ? { partialText: item.text } : {})}
        />
      );
    }
    case 'streaming': {
      // Z-92：流式思考同样是一等行（渐变扫光「正在思考」+ 最后一行摘要）；不再用内联「（思考中…）」。
      // U2-C8（pending 行同皮）：在途工具行不再是旧 `.tool-row.tool-pending` 第二套皮 ——
      // 直接渲染 ToolCard（result 未落 → toolStatusOf = running → 与完成后的本卡同一形态：
      // 图标 + 标题扫光 + 「运行中…」状态；无结果区 → 不可展开、不摆假箭头）。
      // 中文化状态词（「ok」→空、「FAILED:」→「失败：」）见 tool-model.toolStatusLabel。
      // U2 批E（E-a）：turnIsRunning = 会话在途（store.peekStream.running，与 assistant 分支同源）；
      // isLastTextItem 由投影层保证（live.text 在途条目恒为末条、带 streaming:true，chat-model）。
      const streamIsRunning = sessionId !== undefined && store.peekStream(sessionId)?.running === true;
      return (
        <>
          {item.tool === undefined && item.reasoning !== undefined && item.reasoning.length > 0 && (
            <ReasoningRow text={item.reasoning} streaming />
          )}
          {item.tool !== undefined ? (
            <ToolCard card={toolCardFromItem(item)} {...(sessionId !== undefined ? { sessionId } : {})} actions={{}} />
          ) : (
            // 本分支 item.tool === undefined（工具行走上方分支）→ 流式正文同样可划词（Z4-03）
            // 流式正文 = Markdown（mode=streaming + parseIncompleteMarkdown，半截 **bold / ```
            // 在闭合前即时补全渲染）；光标 ▌ 保留在块外（落盘后随 assistant 分支切 static）。
            <div className="bubble-assistant streaming">
              <div className="text" {...{ [QUOTE_ORIGIN_ATTR]: 'assistant' }}>
                <MarkdownBlock text={item.text ?? ''} streaming={streamIsRunning && item.streaming === true} />
                <span className="cursor">▌</span>
              </div>
            </div>
          )}
        </>
      );
    }
    case 'turn-summary': {
      // U2-C3（耗时双行收口）：本行**不再渲染耗时** —— ZCode 口径轮次耗时唯一源 = 轮首
      // WorkIndicator（.turn-work，「已工作 N 秒」），摘要行再出一份「持续了 N 秒」是双行重复。
      // 时长文案 `formatTurnDuration` 保留在 chat-model（旧调用面），本视图不再消费。
      // 只保留状态语义：error / warning / partial（未完成/已中断 + 半截产出）/ empty。
      const hasBody =
        item.error !== undefined ||
        item.warning !== undefined ||
        item.textOutcome === 'partial' ||
        item.textOutcome === 'empty';
      if (!hasBody) return null;
      return (
        <div className="turn-summary">
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
                  {/* U2 批E（E-a）：半截产出 = 终态冻结文本 → static（保守：partial 只在 turn-end
                      后出现，`turnIsRunning && isLastTextItem` 恒 false，直接 static 等价） */}
                  <MarkdownBlock text={item.partialText} />
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
  /** 转录根（Z4-03 划词浮层的作用域：分屏时只认本格容器内的选区） */
  const transcriptRef = useRef<HTMLDivElement>(null);
  /** 渲染前是否贴底（决定新内容到达时是否跟随滚动） */
  const wasAtBottomRef = useRef(true);

  // Z2-09b：轮次导航（Z-17 ConversationTurnNavigator）。条目由 ChatItem 流派生（纯函数）；
  // 当前轮随滚动位置判定；轮次 <2 时 TurnNavigator 自行不渲染，≥864px 断点交给 CSS @container。
  const turns = deriveTurns(items);
  const [activeTurnId, setActiveTurnId] = useState<string | undefined>(undefined);
  // 换会话：高亮回落（不把上一会话的当前轮带过来）
  useEffect(() => {
    setActiveTurnId(undefined);
  }, [streamId]);

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
    // Z2-09b：当前轮 = 顶部越过内缩线的最后一个轮首行（与稳定滚动同一次滚动事件，不另挂监听）
    setActiveTurnId(activeTurnIdOf(scrollRef.current));
  };

  // Z2-09b：点击定位 = 滚到该轮首行；定位成功即把该轮置为当前（jsdom 无布局时 rects 为 0，
  // 也能拿到确定的高亮结果）
  const onTurnJump = (turnId: string): void => {
    if (jumpToTurn(scrollRef.current, turnId)) setActiveTurnId(turnId);
  };

  if (stream === undefined || !stream.loaded) {
    return (
      <div className="chat empty-pane">
        <p>{state.status === 'connected' ? '加载会话…' : '服务未连接…'}</p>
      </div>
    );
  }

  // D1/P1-1：本轮 `@path` 引用来源报告（哪些进了上下文、哪些被拒及原因）—— 引用结果必须可见
  const refReport = store.peekRefReport(streamId);

  return (
    <div className="chat" ref={transcriptRef}>
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
        {/* Z10-1：会话已选中但无消息（新任务态）→ Logo mark + 时间问候。
          建议 chip 不在此处：由会话席位渲染在 composer **之下**（与 ZCode 实测布局一致）。 */}
        {items.length === 0 && <ConversationEmptyState />}
      </div>
      {/* Z2-09b：轮次导航（Z-17）——左缘细 rail；轮次 ≥2 才渲染，≥864px 由 CSS @container 显隐 */}
      <TurnNavigator turns={turns} activeTurnId={activeTurnId} onJump={onTurnJump} />
      {/* Z4-03：转录划词「询问」浮层（ZCode selection-side-chat 的等价物入口）——
          选区引用块经 composer 预填通道进本会话 composer（焦点随行）；
          作用域 = 本转录容器（Z2-06 分屏各格只认自己格内的选区，不误报别的会话）；
          无选区 / 选区不在可引用行内时浮层不渲染（红线⑩）。 */}
      <SelectionAskLayer sessionId={streamId} containerRef={transcriptRef} />
      {/* Z-20：审批卡不再渲染在转录流内 —— 改由会话席位挂在 composer 之上的底部 dock
          （`renderer/approval/ApprovalDock`，见 conversation/seat.tsx）。队列同批迁出：
          Z2-09b 起队列由席位级 QueuePanel（composer 之上的 dock）呈现，转录内不再重复展示。 */}
      {refReport !== undefined &&
        refReport.sources.length + refReport.skipped.length + refReport.notFound.length + refReport.unavailable.length >
          0 && (
          // U2-C6：明细收进 <details>，摘要行只报「引用 N 项」—— 引用结果必须可见（D1 红线
          // 不变：有数据才渲染），但不以逐 token 长串常驻打断转录流；展开才看明细。
          <details
            className="ref-report"
            aria-label="引用来源"
            data-ref-count={
              refReport.sources.length +
              refReport.skipped.length +
              refReport.notFound.length +
              refReport.unavailable.length
            }
          >
            <summary className="ref-report-summary">
              引用{' '}
              {refReport.sources.length +
                refReport.skipped.length +
                refReport.notFound.length +
                refReport.unavailable.length}{' '}
              项
            </summary>
            <div className="ref-report-body">
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
              {refReport.unavailable.map((t) => (
                <span key={t} className="ref-missing">
                  {t} 读取通道不可用
                </span>
              ))}
              {refReport.notFound.map((t) => (
                <span key={t} className="ref-missing">
                  {t} 未找到
                </span>
              ))}
            </div>
          </details>
        )}
    </div>
  );
}
