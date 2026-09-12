// ink 全屏 TUI 入口：现代终端下启用，piped/CI/逃生舱仍走 legacy。
// 门控（T2）：委托 terminal-capabilities.ts 的纯决策 —— 显式覆盖（HARNESS2_NO_TUI / --no-tui / HARNESS2_TUI）
// 优先，其后 非 TTY → legacy，Windows 走四场景闸门（现代终端标记才默认 ink），非 Windows TTY → ink。
// 装配与 legacy 共用 setupChatSession（禁止两套装配）；渲染走 React state 桥接。
// T3：历史由 typed TranscriptState 持有（TranscriptView 虚拟化渲染），会话切换重投影；
//     工具/推理卡片在 turn 落定后仍可按稳定 id 展开（闭 H2）。
// W3：HARNESS2_RENDERER=next 时改走 next 渲染层（src/tui/next/next-shell.ts 的 runNextChat，
//     Screen + 统一输入层整帧装配）；开关默认关闭，未设置时本文件路径一行不变。
import React, { useRef, useState } from 'react';
import { render, useInput, useStdout, Box, Text } from 'ink';
import { setupChatSession, type ChatRuntime, type TurnResult } from '../chat-setup.js';
import type { ChatOptions } from '../legacy-chat.js';
import { StatusBar } from './StatusBar.js';
import { Composer } from './Composer.js';
import { Transcript } from './TranscriptView.js';
import { OverlayHost } from './OverlayHost.js';
import { Modal } from './Modal.js';
import { SelectList } from './SelectList.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { SubagentView } from './SubagentView.js';
import { useTurnStream } from './useTurnStream.js';
import { bindShutdownSignals, createShutdown, type ExitReason } from './shutdown.js';
import { createUiScheduler, type UiScheduler } from './scheduler.js';
import { QueuePanel, cancelQueueItem, type QueuePanelItem } from './panels/queue-panel.js';
import { RetryPanel, retryBudgetHasActivity, type RetryBudgetSnapshot } from './panels/retry-panel.js';
import { TaskPanel } from './panels/task-panel.js';
import { decideTuiMode, detectTerminalCapabilities, hasModernTerminalMarker } from './terminal-capabilities.js';
import { parseCommand, HELP_TEXT } from '../commands.js';
import { runSharedCommand, type InkCommandIo } from './ink-commands.js';
import { describeSteerResult } from '../steer.js';
import { expandContextRefs, hasContextRefs } from '../context-ref.js';
import {
  emptyTranscript,
  projectSession,
  transcriptReducer,
  isSubagentTool,
  type TranscriptEvent,
  type TranscriptState,
} from './transcript.js';
import { turnSummaryLine } from '../render.js';
import { attachTerminalEvents, type TerminalEventBridge } from './terminal-events.js';
import { createNotifier, stderrSink, type Notifier } from './notify.js';
import { runNextChat, shouldUseNextRenderer } from './next/next-shell.js';
import {
  CORE_MODE_TO_ALIAS,
  MODE_ALIAS_ORDER,
  MODE_ALIAS_LABEL,
  MODE_ALIAS_TO_CORE,
  type ModeAlias,
} from '../mode-alias.js';
import { getContextUsage } from '@harness2/core';
import type { TaskContract } from '@harness2/core';

/** 现代终端检测：兼容旧导出，委托纯函数标记探测（WT_SESSION / TERM_PROGRAM / ConEmu / ANSICON / xterm 等） */
export function isModernTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasModernTerminalMarker(env);
}

/**
 * T2 门控：基于 terminal-capabilities.ts 的纯决策。
 * 显式覆盖优先：HARNESS2_NO_TUI=1 / --no-tui（禁）> HARNESS2_TUI=1（启用）；
 * 其后非 TTY → legacy；Windows 四场景闸门；非 Windows TTY → ink。
 */
export function shouldUseInk(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdin.isTTY),
  platform: NodeJS.Platform = process.platform,
): boolean {
  const caps = detectTerminalCapabilities(env, platform, isTTY);
  return (
    decideTuiMode(caps, {
      forceNoTui: env.HARNESS2_NO_TUI === '1' || argv.includes('--no-tui'),
      forceTui: env.HARNESS2_TUI === '1',
    }).mode === 'ink'
  );
}

/** 浮层请求：render(node, resolve) 由 InkShell 挂载；resolve 关闭浮层 */
export interface DialogRequest {
  render: (onClose: () => void) => React.ReactNode;
  resolve: () => void;
}

/** 桥接 setupChatSession 的非组件职责（askApproval）与 InkShell 的 React state */
export function createDialogController(): {
  open: (req: DialogRequest) => void;
  getPending: () => DialogRequest | null;
  clear: () => void;
  /** 订阅 pending 变化（open/clear），供 InkShell 驱动 React 重渲染同步审批弹窗 */
  subscribe: (fn: () => void) => () => void;
} {
  let pending: DialogRequest | null = null;
  const subs = new Set<() => void>();
  const notify = () => {
    for (const fn of subs) fn();
  };
  return {
    open: (req) => {
      pending?.resolve(); // 清掉旧挂起（理论上一时刻只有一个）
      pending = req;
      notify();
    },
    getPending: () => pending,
    clear: () => {
      pending = null;
      notify();
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

/** 等待由组件内完成（temporary shell promise 由 ink 的 unmount 结束） */
export async function runInkChat(options: ChatOptions = {}): Promise<void> {
  // W3：next 渲染层开关（默认关闭）——显式 HARNESS2_RENDERER=next 才改道，其余路径不动
  if (shouldUseNextRenderer(process.env)) {
    return runNextChat(options);
  }
  const bootLines: string[] = [];
  const dialog = createDialogController();
  const runtime = await setupChatSession(options, {
    line: (t) => bootLines.push(t),
    // 审批弹窗：通过 dialog 打开 ConfirmDialog，选择后 resolve；turn 取消时 resolve 为拒绝
    askApproval: (query) =>
      new Promise<string>((resolveAsk) => {
        dialog.open({
          render: (onClose) => (
            <ConfirmDialog
              question={query}
              isActive
              onChoice={(choice) => {
                resolveAsk(choice === 'allow' ? 'y' : choice === 'allow-always' ? 'a' : 'n');
                onClose();
              }}
              onCancel={onClose}
            />
          ),
          resolve: () => resolveAsk(ASK_CANCELLED),
        });
      }),
  });

  await new Promise<void>((resolve) => {
    let app: ReturnType<typeof render> | null = null;
    // T2：能力齐备时才启用 alternate screen（交互模式下的全屏视口 + 退出还原）。
    // 非 TTY / dumb / CI / 能力缺失时 runChat 已降级 legacy，此处再以 stdout TTY 兜底。
    const caps = detectTerminalCapabilities(process.env, process.platform, Boolean(process.stdin.isTTY));
    const useAlternateScreen = caps.altScreen && caps.bracketedPaste && Boolean(process.stdout.isTTY);
    // T2：SGR 鼠标 + 焦点事件桥。必须在 render() 之前挂接（prependListener 先于 ink 消费 stdin），
    // 使鼠标序列不流入 ink 的键位解析；HARNESS2_MOUSE=0 可关闭上报（保留解析）。退出时还原上报模式。
    // T1-4：解析职责默认走统一解析器（src/input/parser.ts，经 input-bridge 适配回注）；
    // HARNESS2_INPUT=legacy 可回退旧 TerminalEventParser 字节回注路径（见 terminal-events.ts 文件头）。
    const mouseEnabled = useAlternateScreen && process.env.HARNESS2_MOUSE !== '0';
    const terminalEvents = attachTerminalEvents(process.stdin, process.stdout, { enabled: mouseEnabled });
    // T4：回合结束提醒（HARNESS2_NOTIFY/HARNESS2_NOTIFY_METHOD；写 stderr 且仅 TTY）。
    const notifier = createNotifier(process.env, stderrSink());
    // T0 幂等退出：finish 只执行一次（ink unmount + runtime.finish），随后写 process.exitCode
    // 并放开等待；不再用 setInterval 轮询 stdin.destroyed（会遗留 timer）。
    const shutdown = createShutdown({
      finish: async () => {
        app?.unmount();
        terminalEvents.dispose();
        await runtime.finish({
          destroyInput: () => process.stdin.destroy(),
        });
      },
      exit: (code) => {
        process.exitCode = code; // 不 abrupt process.exit，让 ink 拆屏与锁释放完成
        resolve();
      },
    });
    app = render(
      <InkShell
        runtime={runtime}
        bootLines={bootLines}
        dialog={dialog}
        terminalEvents={terminalEvents}
        notifier={notifier}
        onExit={(reason: ExitReason) => {
          shutdown.request(reason);
        }}
      />,
      { exitOnCtrlC: false, alternateScreen: useAlternateScreen },
    );
    // 审查 P2：SIGTERM（kill）/SIGHUP（终端关闭）复用同一条幂等退出路径——
    // 外部终止时锁释放/拆屏还原/awaitDone 收敛不再悬挂；退出收敛后解绑监听。
    const detachSignals = bindShutdownSignals((reason) => shutdown.request(reason));
    void shutdown.awaitDone().then(detachSignals);
  });
}

const ASK_CANCELLED = '\u0000ask-cancelled';

/**
 * T3：Modal 外框固定占用行数（border 2 + paddingY 2 + 标题 1 + marginBottom 1 + 提示 1 + marginTop 1）。
 * 各浮层内容行数由调用方按内容精确计算（避免 renderToString 测高对 viewport 类内容低估，
 * 也避免 ink maxHeight 裁剪的逐行渲染缺陷），保证浮层高度与预留一致、不覆盖输入框。
 */
const MODAL_CHROME_ROWS = 8;
/** 确认框：内容 = 问题 1 + 选择列表（margin 1 + 3 项） */
const CONFIRM_OVERLAY_ROWS = MODAL_CHROME_ROWS + 1 + 1 + 3;

/**
 * T4 任务面板数据注入缝：in-process CLI 路径尚无 task-coordinator 数据源接入 ChatRuntime
 * （已登记缺口）。此处传空列表 → 面板渲染 null，绝不伪造任务；接线完成后替换为真实 TaskContract[]。
 */
const EMPTY_TASKS: readonly TaskContract[] = [];

function initialTranscript(bootLines: string[]): TranscriptState {
  let state = emptyTranscript();
  bootLines.forEach((text, i) => {
    state = transcriptReducer(state, { type: 'system', id: `boot:${i}`, text });
  });
  return state;
}

function safeProject(dir: string | undefined): TranscriptState {
  if (dir === undefined) return emptyTranscript();
  try {
    return projectSession(dir);
  } catch {
    // 新会话日志尚未落盘 / 读取失败：退化为空转录（不阻塞会话切换）
    return emptyTranscript();
  }
}

export function InkShell({
  runtime,
  bootLines,
  dialog,
  onExit,
  onTranscriptChange,
  terminalEvents,
  notifier,
}: {
  runtime: ChatRuntime;
  bootLines: string[];
  dialog: ReturnType<typeof createDialogController>;
  onExit: (reason: ExitReason) => void;
  /** 可选观察缝：转录每次变化时回调（测试/诊断用；不影响渲染） */
  onTranscriptChange?: (state: TranscriptState) => void;
  /** T2：stdin 鼠标/焦点事件桥（runInkChat 在 render 前挂接；测试可用伪 TTY stdin 构造） */
  terminalEvents?: TerminalEventBridge;
  /** T4：回合结束提醒器（runInkChat 注入；测试可传 capture sink 版本；缺省按环境变量构造） */
  notifier?: Notifier;
}): React.ReactElement {
  // T3：typed 转录（替代 string[] + Static）；会话切换时整体重投影
  const [transcript, setTranscript] = useState<TranscriptState>(() => initialTranscript(bootLines));
  const [busy, setBusy] = useState(false);
  // T8：推理折叠块展开态（turn 内 Ctrl+R 切换；忙时 Composer 接管普通字符输入，故用带修饰键快捷键）
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  // T3：已展开卡片 id 集合（shell 持有；turn 落定后仍有效 → H2）
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  // T3：follow/anchor 滚动（PageUp/PageDown 滚动；Ctrl+G 回到末尾跟随）
  const [follow, setFollow] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [anchorId, setAnchorId] = useState<string | undefined>(undefined);
  // T5：单一浮层宿主。命令与审批都经 overlay 呈现；存在即互斥接管键盘。
  const [overlay, setOverlay] = useState<React.ReactNode>(null);
  // T3：浮层占用行数（按内容确定性计算；预留一致 → 不覆盖输入框）
  const [overlayRows, setOverlayRows] = useState(0);
  const closeOverlayRef = useRef<() => void>(() => undefined);
  const overlayOpen = overlay !== null;
  /** 统一开浮层入口：记录内容与占用行数 */
  function openOverlay(node: React.ReactNode, rows: number): void {
    setOverlay(node);
    setOverlayRows(rows);
  }
  // T0：忙时 FIFO 排队（对齐 legacy-chat：忙碌中的输入不并发、当前 turn 收尾后立即执行下一条）
  const busyRef = useRef(false);
  const exitingRef = useRef(false);
  // T4：真实队列条目（id 稳定，供 queue-panel 的 Ctrl+X 取消定位）；queueRef 为真源、queueItems 为渲染镜像
  const queueRef = useRef<QueuePanelItem[]>([]);
  const queueSeqRef = useRef(0);
  const [queueItems, setQueueItems] = useState<QueuePanelItem[]>([]);
  // T4：turn 结束时的重试预算快照（冻结 RetryBudgetState：used/remaining/stopReason）；无活动不渲染
  const [retryBudget, setRetryBudget] = useState<RetryBudgetSnapshot | undefined>(undefined);
  // 转录状态镜像（供键盘回调读取最新 items，不触发额外订阅）
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  // 滚动 source of truth（ref 供 key handler 读取；state 仅驱动渲染）
  const followRef = useRef(true);
  const scrollRef = useRef(0);
  const anchorRef = useRef<string | undefined>(undefined);
  const liveSeqRef = useRef(0);
  const viewportRef = useRef<{ maxScroll: number; firstVisibleId?: string }>({ maxScroll: 0 });
  const { stdout } = useStdout();
  const rows = stdout.rows ?? 24;
  const cols = stdout.columns ?? 80;
  const SCROLL_PAGE = Math.max(1, Math.floor(rows / 2));

  // T2：终端焦点状态（DECSET 1004；缺省视为聚焦——unfocused 策略下不响，保守处理）；
  // 供 T4 回合结束提醒判断。ref 同步副本供 runTurnText 收尾时读取（避免异步闭包拿旧值）。
  const [, setTerminalFocused] = useState(true);
  const terminalFocusedRef = useRef(true);
  // T4：提醒器（注入或按环境变量构造；稳定实例）
  const [turnNotifier] = useState<Notifier>(() => notifier ?? createNotifier(process.env, stderrSink()));
  const wheelHandlerRef = useRef<{ up: () => void; down: () => void }>({ up: () => undefined, down: () => undefined });
  wheelHandlerRef.current = { up: scrollUp, down: scrollDown };
  React.useEffect(() => {
    if (terminalEvents === undefined) return;
    return terminalEvents.subscribe((event) => {
      if (event.type === 'wheel') {
        if (event.up) wheelHandlerRef.current.up();
        else wheelHandlerRef.current.down();
      } else if (event.type === 'focus') {
        terminalFocusedRef.current = event.focused;
        setTerminalFocused(event.focused);
      }
    });
  }, [terminalEvents]);

  // T4：有界 UI 调度器——批量合并 transcript 事件（coalesce + maxBatch），输入驱动的 flushNow 保即时，
  // turn 收尾/卸载时 final flush 且 dispose 清 timer（无残留 timer，满足 T0/T5 新鲜度）。
  const schedulerRef = useRef<UiScheduler<TranscriptEvent> | null>(null);
  if (schedulerRef.current === null) {
    schedulerRef.current = createUiScheduler<TranscriptEvent>({
      flushMs: 16,
      maxBatch: 64,
      onFlush: (batch) => setTranscript((s) => batch.reduce(transcriptReducer, s)),
    });
  }
  const dispatch = React.useCallback((event: TranscriptEvent) => {
    schedulerRef.current?.push(event);
  }, []);
  // T1：当前 turn 内出现的 subagent 工具 callId（live 流不含 output，turn 收尾后从磁盘补齐）
  const subagentCallIdsRef = useRef<Set<string>>(new Set());
  const onTranscriptEvent = React.useCallback(
    (event: TranscriptEvent) => {
      if (event.type === 'tool/call' && isSubagentTool(event.tool)) {
        subagentCallIdsRef.current.add(event.callId);
      }
      dispatch(event);
    },
    [dispatch],
  );
  React.useEffect(() => () => schedulerRef.current?.dispose(), []);

  // T5：steer 回帧 → 转录报告（accepted / stale(草稿已保留) / rejected）。
  // 提交只代表入队；最终结果由 core loop 在安全 step 边界或收尾回帧。
  React.useEffect(() => {
    const unsubscribe = runtime.observeSteer((result) => {
      const { line } = describeSteerResult(result);
      liveSeqRef.current += 1;
      dispatch({ type: 'system', id: `steer:${liveSeqRef.current}`, text: line });
    });
    return unsubscribe;
  }, [runtime, dispatch]);

  /**
   * T4 输入优先：输入驱动的事件（用户回声/命令回显）期间挂起后台 flush 并立即 flushNow，
   * 保证按键回声即时可见；随后恢复后台批处理（流式事件继续按窗口合并）。
   */
  function dispatchInputNow(event: TranscriptEvent): void {
    const sched = schedulerRef.current;
    sched?.setInputPriority(true);
    sched?.push(event);
    sched?.flushNow();
    sched?.setInputPriority(false);
  }

  const { live, handler, finalize, reset } = useTurnStream(onTranscriptEvent);

  // 转录观察缝（测试/诊断）：转录变化时回调最新状态
  React.useEffect(() => {
    onTranscriptChange?.(transcript);
  }, [transcript, onTranscriptChange]);

  const onViewportChange = React.useCallback(
    (info: { totalHeight: number; maxScroll: number; start: number; end: number; firstVisibleId?: string }) => {
      viewportRef.current = {
        maxScroll: info.maxScroll,
        ...(info.firstVisibleId !== undefined ? { firstVisibleId: info.firstVisibleId } : {}),
      };
    },
    [],
  );

  // 同步 dialog controller 里的挂起请求（审批弹窗）到 overlay。
  // dialog 是外置稳定对象（open 只改闭包），须经订阅计数驱动 effect 重跑（审查 P0 修复）
  const [reqTick, setReqTick] = useState(0);
  React.useEffect(() => dialog.subscribe(() => setReqTick((t) => t + 1)), [dialog]);

  React.useEffect(() => {
    const req = dialog.getPending();
    if (req === null) return;
    closeOverlayRef.current = () => {
      req.resolve();
      dialog.clear();
      setOverlay(null);
      setOverlayRows(0);
    };
    openOverlay(
      req.render(() => {
        req.resolve();
        dialog.clear();
        setOverlay(null);
        setOverlayRows(0);
      }),
      CONFIRM_OVERLAY_ROWS,
    );
  }, [dialog, reqTick]);

  function applyFollow(value: boolean): void {
    followRef.current = value;
    setFollow(value);
  }
  function applyScroll(value: number): void {
    scrollRef.current = value;
    setScrollTop(value);
  }
  function applyAnchor(id: string | undefined): void {
    anchorRef.current = id;
    setAnchorId(id);
  }

  /** PageUp：从贴尾切到锚定（保留当前首个可见 item），再向上滚动一屏 */
  function scrollUp(): void {
    if (followRef.current) {
      const first = viewportRef.current.firstVisibleId;
      applyAnchor(first);
      applyScroll(Math.max(0, viewportRef.current.maxScroll - SCROLL_PAGE));
      applyFollow(false);
      return;
    }
    applyScroll(Math.max(0, scrollRef.current - SCROLL_PAGE));
  }

  /** PageDown：向下滚动；到底后自动恢复跟随 */
  function scrollDown(): void {
    if (followRef.current) return;
    const next = Math.min(viewportRef.current.maxScroll, scrollRef.current + SCROLL_PAGE);
    if (next >= viewportRef.current.maxScroll) {
      resumeFollow();
      return;
    }
    applyScroll(next);
  }

  /** Ctrl+G：回到末尾并恢复跟随（文档化快捷键） */
  function resumeFollow(): void {
    applyFollow(true);
    applyAnchor(undefined);
    applyScroll(0);
  }

  /** Ctrl+O：展开/收起最近一张工具卡（落定后仍可操作 = H2） */
  function toggleLastTool(): void {
    setExpandedIds((prev) => {
      const last = [...transcriptRef.current.items].reverse().find((i) => i.kind === 'tool');
      if (last === undefined) return prev;
      const next = new Set(prev);
      if (next.has(last.id)) next.delete(last.id);
      else next.add(last.id);
      return next;
    });
  }

  // T3 滚动/展开快捷键（与 Composer 不冲突：PageUp/PageDown/Ctrl+G/Ctrl+O 输入框不消费）
  useInput(
    (input, key) => {
      if (key.pageUp) {
        scrollUp();
        return;
      }
      if (key.pageDown) {
        scrollDown();
        return;
      }
      if (key.ctrl && input.toLowerCase() === 'g') {
        resumeFollow();
        return;
      }
      if (key.ctrl && input.toLowerCase() === 'o') {
        toggleLastTool();
      }
      // T1：Ctrl+J（kitty CSI-u 终端）/ Ctrl+K（所有终端可用）打开最近子会话工具卡的只读浮层
      if (key.ctrl && (input.toLowerCase() === 'j' || input.toLowerCase() === 'k')) {
        openLastSubagent();
        return;
      }
    },
    { isActive: !overlayOpen },
  );

  // T8：busy 期间 Ctrl+R 展开/收起当前 turn 的推理折叠块。
  // T0 起 Composer 忙时也接管普通字符输入，故推理快捷键改为 Ctrl+R，避免与草稿输入冲突。
  useInput(
    (input, key) => {
      if (key.ctrl && input.toLowerCase() === 'r') setReasoningExpanded((v) => !v);
    },
    { isActive: busy && !overlayOpen },
  );

  function sendSystem(line: string): void {
    liveSeqRef.current += 1;
    dispatch({ type: 'system', id: `sys:${liveSeqRef.current}`, text: line });
  }

  /**
   * T5 重投影：用 projectSession 从磁盘会话日志重建转录（整体替换）。
   * /undo /redo 追加 rewind/marker 后调用，使被遮蔽的 user/assistant 条目消失（/redo 再出现）；
   * 会话切换同理。清空展开/滚动状态，避免旧 id 上的交互残留。
   */
  function reprojectTranscript(): void {
    schedulerRef.current?.flushNow(); // 先落定待处理事件，避免重投影后混入
    setTranscript(safeProject(runtime.getCurrent()?.dir));
    setExpandedIds(new Set());
    // 重投影会整体替换转录（/undo /redo /new /resume /fork、会话切换）：上一轮的冻结重试面板
    // 已不属于新转录，必须清掉，否则旧 turn 的 retry 面板会残留在新会话视图上。
    setRetryBudget(undefined);
    applyFollow(true);
    applyAnchor(undefined);
    applyScroll(0);
  }

  /** T5：共享命令执行缝（委托 commands.ts 的 handleCommand） */
  const commandIo: InkCommandIo = {
    print: (t) => {
      sendSystem(t);
      schedulerRef.current?.flushNow(); // 命令输出立即可见（低频）
    },
    reproject: reprojectTranscript,
    requestExit: () => {
      exitingRef.current = true;
      if (busyRef.current) {
        // turn 进行中：先取消，等本轮收尾后由 finally 触发退出（对齐 legacy requestExit）
        runtime.abortTurn();
        return;
      }
      onExit('exit');
    },
  };

  /**
   * 会话切换统一处理（openSessions 选择路径）：收集 switch 输出，重投影新会话转录，再回放提示。
   */
  function applySessionChange(fn: (print: (t: string) => void) => void): void {
    const lines: string[] = [];
    fn((t) => lines.push(t));
    reprojectTranscript();
    for (const l of lines) sendSystem(l);
    schedulerRef.current?.flushNow(); // T4 final flush：重投影后切换提示立即落定
  }

  function openModePicker(): void {
    const mode = runtime.mode();
    const alias = CORE_MODE_TO_ALIAS[mode];
    const options = MODE_ALIAS_ORDER.map((a) => ({
      value: a,
      label: MODE_ALIAS_LABEL[a],
    }));
    openOverlay(
      <Modal
        title="切换模式（/mode）"
        hint="↑↓ 选择 · Enter 应用 · Esc 取消"
        onClose={() => {
          setOverlay(null);
          setOverlayRows(0);
        }}
        isActive
      >
        <SelectList
          options={options}
          selected={alias}
          isActive
          onSelect={(value: string) => {
            runtime.setMode(MODE_ALIAS_TO_CORE[value as ModeAlias]);
            sendSystem(`已切换模式: ${value}（当前 ${runtime.mode()}）`);
            setOverlay(null);
            setOverlayRows(0);
          }}
          onCancel={() => {
            setOverlay(null);
            setOverlayRows(0);
          }}
        />
      </Modal>,
      MODAL_CHROME_ROWS + MODE_ALIAS_ORDER.length,
    );
  }

  /**
   * /help：帮助文本较长（约 24 行），浮层放不下也不适合截断；直接进转录（可滚动、与 legacy 打印行为一致），
   * 同时避免挤占浮层预算（T3 位置规则只约束短弹层）。
   */
  function openHelp(): void {
    sendSystem(HELP_TEXT);
  }

  function openSessions(): void {
    const current = runtime.getCurrent();
    const sessions = runtime.sessionManager.list(runtime.root);
    // 会话列表可能很长：按浮层预算截断显示（不把输入框挤出屏幕；其余可见于 /sessions <关键字> 搜索）
    const budget = Math.max(0, rows - statusRows - panelRows - composerHeight - 3);
    const maxOptions = Math.max(3, budget - MODAL_CHROME_ROWS - 2);
    const shown = sessions.slice(0, maxOptions);
    const hidden = sessions.length - shown.length;
    openOverlay(
      <Modal
        title="会话（/sessions）"
        hint="↑↓ 浏览 · Enter 切换 · Esc 关闭"
        onClose={() => {
          setOverlay(null);
          setOverlayRows(0);
        }}
        isActive
      >
        <SelectList
          options={shown.map((s) => ({ value: s.id, label: s.id }))}
          selected={current?.id ?? ''}
          isActive
          onSelect={(id: string) => {
            applySessionChange((print) => runtime.switchSession(id, { print }));
            setOverlay(null);
            setOverlayRows(0);
          }}
          onCancel={() => {
            setOverlay(null);
            setOverlayRows(0);
          }}
        />
        <Box>
          <Text color="gray">
            共 {sessions.length} 个会话{hidden > 0 ? `（列表截断，可用 /sessions <关键字> 搜索）` : ''}
          </Text>
        </Box>
      </Modal>,
      MODAL_CHROME_ROWS + shown.length + 1 + (hidden > 0 ? 1 : 0),
    );
  }

  /** T1：打开最近一张带子会话入口的工具卡的只读浮层（缺省 = 最近一张） */
  function openLastSubagent(): void {
    const last = [...transcriptRef.current.items]
      .reverse()
      .find((i) => i.kind === 'tool' && i.childSessionId !== undefined);
    if (last === undefined || last.kind !== 'tool' || last.childSessionId === undefined) return;
    openSubagent(last.childSessionId);
  }

  /**
   * T1：子会话只读浮层。目录定位/读取失败时如实显示错误文案（不伪造）。
   * 复用 Modal（Esc 关闭，isActive 接管键盘）+ Transcript（只读、虚拟化）。
   */
  function openSubagent(childId: string): void {
    let dir: string | undefined;
    let locateError: string | undefined;
    try {
      dir = runtime.sessionManager.locate(childId, { cwd: runtime.root });
    } catch (e) {
      locateError = (e as Error)?.message ?? String(e);
    }
    const width = Math.min(Math.max(cols - 8, 36), 72);
    // 子会话转录区高度受浮层预算约束（Modal 外框 MODAL_CHROME_ROWS 行），避免把输入框挤出屏幕
    const budget = Math.max(0, rows - statusRows - panelRows - composerHeight - 3);
    const height = Math.max(4, Math.min(rows - 10, budget - MODAL_CHROME_ROWS));
    openOverlay(
      <Modal
        title={`子会话 ${childId}`}
        hint="只读 · Esc 关闭"
        onClose={() => {
          setOverlay(null);
          setOverlayRows(0);
        }}
        isActive
      >
        <SubagentView sessionId={childId} dir={dir} locateError={locateError} width={width} height={height} />
      </Modal>,
      MODAL_CHROME_ROWS + height,
    );
  }

  /**
   * T1：turn 收尾后把 subagent 工具的 output/childSessionId 从磁盘补齐到转录（live 流不含 output）。
   * 只读 projectSession 重投影当前会话日志，按 callId 原地合并（reducer 幂等）；读取失败保持现状。
   */
  function enrichSubagentResults(): void {
    const ids = subagentCallIdsRef.current;
    if (ids.size === 0) return;
    const current = runtime.getCurrent();
    if (current === null) return;
    let state: TranscriptState;
    try {
      state = projectSession(current.dir);
    } catch {
      return; // 磁盘读取失败：保持现状（入口不显示，下次重投影自然补齐）
    }
    for (const item of state.items) {
      if (item.kind !== 'tool' || item.output === undefined || !ids.has(item.callId)) continue;
      dispatch({
        type: 'tool/result',
        callId: item.callId,
        tool: item.tool,
        ok: item.status === 'ok',
        ...(item.output !== undefined ? { output: item.output } : {}),
        ...(item.error !== undefined ? { error: item.error } : {}),
      });
    }
    subagentCallIdsRef.current.clear();
  }

  /**
   * T5 命令分发：ink 本地 UI 命令（/mode /help /sessions /context /compact /reasoning /tasks）
   * 保持原交互；其余（/undo /redo /new /resume /fork /exit /quit /? 与未知命令）**委托共享
   * commands.ts 的 handleCommand**，用 ChatRuntime 构建真实 CommandContext，保证两路径语义一致。
   */
  function handleCommand(parsed: { name: string; rest: string }): void {
    const { name, rest } = parsed;
    switch (name) {
      case '/mode':
        if (rest.length > 0) {
          // 带参：文本分支，直接应用（若别名存在）
          const aliasKey = (Object.keys(MODE_ALIAS_TO_CORE) as ModeAlias[]).find((a) => a === rest.toLowerCase());
          if (aliasKey !== undefined) {
            runtime.setMode(MODE_ALIAS_TO_CORE[aliasKey]);
            sendSystem(`已切换模式: ${rest.toLowerCase()}`);
          } else {
            sendSystem(`error: 未知模式 ${rest}（可选: ${MODE_ALIAS_ORDER.join(', ')}）`);
          }
        } else {
          openModePicker();
        }
        return;
      case '/help':
      case '/?':
        // 帮助文本与 legacy 同源（commands.ts 的 HELP_TEXT），此处以浮层展示
        openHelp();
        return;
      case '/sessions':
        // 带关键字 → 共享搜索（文本输出）；无参 → 交互式选择列表
        if (rest.length > 0) {
          runSharedCommand(parsed, runtime, commandIo);
          return;
        }
        openSessions();
        return;
      case '/context': {
        const current = runtime.getCurrent();
        const usage = current !== null ? getContextUsage(current.dir) : undefined;
        sendSystem(`上下文占用: ${usage === undefined ? '—（无活动会话）' : `${Math.round(usage * 100)}%`}`);
        return;
      }
      case '/compact':
        sendSystem('压缩将在下一次 turn 开始时自动检查并执行；若已超阈值会自动触发。');
        return;
      case '/reasoning': {
        const arg = rest.trim().toLowerCase();
        if (arg.length === 0) {
          sendSystem(`推理展示: ${runtime.reasoning() ? '开启' : '关闭'}（/reasoning on|off）`);
          return;
        }
        if (arg === 'on') {
          runtime.setReasoning(true);
          sendSystem('推理展示已开启（turn 内按 Ctrl+R 展开/收起折叠块）。');
          return;
        }
        if (arg === 'off') {
          runtime.setReasoning(false);
          setReasoningExpanded(false);
          sendSystem('推理展示已关闭。');
          return;
        }
        sendSystem(`error: 未知参数 ${rest}（用 on|off，或留空查看当前状态）`);
        return;
      }
      case '/tasks':
        sendSystem('任务列表请使用 `harness2 cron list` 查看（REPL 只读展示将在后续版本提供）。');
        return;
      default:
        // /undo /redo（rewind 重投影）/new /resume /fork /exit /quit /? 与未知命令 → 共享实现
        runSharedCommand(parsed, runtime, commandIo);
    }
  }

  /** T0：取消当前 turn（Esc/Ctrl+C 忙时触发；abort 后 stopReason=cancelled，部分文本照常落定） */
  function abortCurrentTurn(): void {
    if (!busyRef.current) return;
    sendSystem('^C（正在取消当前 turn…）');
    runtime.abortTurn();
  }

  /** 队列真源 → 渲染镜像同步 */
  function syncQueue(): void {
    setQueueItems([...queueRef.current]);
  }

  /** T4：入队（id 稳定，供 queue-panel 取消定位） */
  function enqueue(text: string): void {
    queueSeqRef.current += 1;
    queueRef.current.push({ id: `q:${queueSeqRef.current}`, text });
    syncQueue();
  }

  /** T4：取消队列条目（queue-panel Ctrl+X → 队首；给 id 则精确移除）；仅影响未启动项 */
  function cancelQueued(id?: string): void {
    queueRef.current = cancelQueueItem(queueRef.current, id);
    syncQueue();
  }

  /** 取出一条排队输入并执行；exiting 后不再取（对齐 legacy 的 queue.shift 收尾逻辑） */
  function drainQueue(): void {
    if (exitingRef.current) return;
    const next = queueRef.current.shift();
    if (next === undefined) return;
    syncQueue();
    void handleInput(next.text);
  }

  /** 忙时入队（不并发）；空闲时直接执行。命令与普通 turn 走同一入口（对齐 legacy）。 */
  function submit(text: string): void {
    if (text.trim().length === 0) return;
    if (busyRef.current) {
      enqueue(text);
      return;
    }
    void handleInput(text);
  }

  async function handleInput(text: string): Promise<void> {
    const parsed = parseCommand(text);
    if (parsed !== null) {
      liveSeqRef.current += 1;
      dispatchInputNow({ type: 'system', id: `echo:${liveSeqRef.current}`, text: `> ${text}` });
      handleCommand(parsed);
      if (!busyRef.current) drainQueue();
      return;
    }
    await runTurnText(text);
  }

  async function runTurnText(text: string): Promise<void> {
    reset();
    busyRef.current = true;
    // T1：新 turn 起重置子会话 callId 追踪（上一轮的补齐已完成）
    subagentCallIdsRef.current.clear();
    let result: TurnResult | undefined;
    setBusy(true);
    setRetryBudget(undefined); // 新 turn 起清掉上一轮的重试面板
    liveSeqRef.current += 1;
    dispatchInputNow({ type: 'user/message', seq: 0, id: `user:live:${liveSeqRef.current}`, text });
    try {
      // @file/@dir 引用解析（发送前预处理；回显保持原始 text；无引用时直接用原文）
      let sendText = text;
      if (hasContextRefs(text)) {
        const ref = expandContextRefs(text, { cwd: runtime.root, root: runtime.root });
        if (ref.hasRefs && ref.header.length > 0) sendText = `${ref.header}\n\n${text}`;
      }
      result = await runtime.runUserTurn(sendText, handler);
      // 终态（final/partial/empty）由 TurnResult.textOutcome 决定，工具卡已在流式期落定
      const terminal = finalize(result);
      if (terminal !== null) dispatch(terminal);
      if (result !== undefined) {
        // T4：暴露冻结的 RetryBudgetState（used/remaining/stopReason）给 retry-panel
        setRetryBudget(result.retryBudget);
        liveSeqRef.current += 1;
        dispatch({ type: 'status', id: `status:${liveSeqRef.current}`, text: turnSummaryLine(result) });
        // T1：live 流不含 tool output（core 契约）；从磁盘补齐 subagent 结果，使工具卡出现「子会话」入口
        enrichSubagentResults();
      }
    } catch (e) {
      sendSystem(`error: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      reset();
      busyRef.current = false;
      setBusy(false);
      setReasoningExpanded(false);
      schedulerRef.current?.flushNow(); // T4 final flush：终态/状态行立即落定，不留在窗口里
      // T4：回合结束提醒（含 final/partial/empty 终态；Ctrl+C 取消不发；/exit 退出中不发）。
      // 焦点读 ref（避免异步闭包拿旧值）；异常结束（result undefined）也算回合结束，照发。
      if (!exitingRef.current) {
        turnNotifier.onTurnComplete({
          focused: terminalFocusedRef.current,
          cancelled: result?.stopReason === 'cancelled',
        });
      }
      if (exitingRef.current) onExit('exit');
      else drainQueue();
    }
  }

  // T4：面板占用行需从 transcript 视口高度扣除，避免溢出。
  const showRetry = retryBudget !== undefined && retryBudgetHasActivity(retryBudget);
  // 结构化高度（实测）：StatusBar 单线边框=3；QueuePanel 圆边框=2+表头1+预览+隐藏行；RetryPanel=3；
  // Composer 高度由组件上报（onHeightChange）；浮层行数由 openOverlay 按内容确定性记录（T3）。
  const statusRows = 3;
  const queueRows =
    queueItems.length > 0 ? 3 + Math.min(queueItems.length - 1, 3) + (queueItems.length - 1 > 3 ? 1 : 0) : 0;
  const retryRows = showRetry ? 3 : 0;
  const panelRows = queueRows + retryRows;
  // T2：Composer 恒定锚底（高度上报，替代 rows-8 魔数）
  const [composerHeight, setComposerHeight] = useState(4);
  // T3：浮层行数（openOverlay 记录；0 = 无浮层）——转录让出等量行，输入框不被顶起
  const transcriptHeight = Math.max(3, rows - statusRows - panelRows - composerHeight - overlayRows);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <StatusBar runtime={runtime} />
      <Transcript
        items={transcript.items}
        liveText={live.text}
        liveReasoning={live.reasoning}
        busy={busy}
        reasoningExpanded={reasoningExpanded}
        expandedIds={expandedIds}
        follow={follow}
        scrollTop={scrollTop}
        {...(anchorId !== undefined ? { anchorId } : {})}
        height={transcriptHeight}
        width={cols}
        onViewportChange={onViewportChange}
      />
      {/* T4 面板：真实队列 / turn 结束后的重试预算 / 任务（数据源注入缝） */}
      <QueuePanel items={queueItems} active={!overlayOpen} onCancel={(id) => cancelQueued(id)} />
      <RetryPanel budget={showRetry ? retryBudget : undefined} active={!overlayOpen} onStop={abortCurrentTurn} />
      <TaskPanel tasks={EMPTY_TASKS} />
      {/* T3：浮层渲染在输入框上方（转录让出等量行，输入框不被顶起） */}
      {overlayOpen ? <OverlayHost height={overlayRows}>{overlay}</OverlayHost> : null}
      <Composer
        busy={busy}
        active={!overlayOpen}
        onSend={submit}
        onExit={(reason) => onExit(reason ?? 'exit')}
        onAbort={abortCurrentTurn}
        onSteer={(text) => {
          const out = runtime.submitSteer(text);
          return out.state === 'submitted' ? `${out.message}（草稿保留）` : out.message;
        }}
        queuedCount={queueItems.length}
        onHeightChange={setComposerHeight}
      />
    </Box>
  );
}
