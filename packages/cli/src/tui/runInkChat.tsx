// ink 全屏 TUI 入口：现代终端下启用，piped/CI/逃生舱仍走 legacy。
// 门控（T2）：委托 terminal-capabilities.ts 的纯决策 —— 显式覆盖（HARNESS2_NO_TUI / --no-tui / HARNESS2_TUI）
// 优先，其后 非 TTY → legacy，Windows 走四场景闸门（现代终端标记才默认 ink），非 Windows TTY → ink。
// 装配与 legacy 共用 setupChatSession（禁止两套装配）；渲染走 React state 桥接。
// T3：历史由 typed TranscriptState 持有（TranscriptView 虚拟化渲染），会话切换重投影；
//     工具/推理卡片在 turn 落定后仍可按稳定 id 展开（闭 H2）。
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
import { useTurnStream } from './useTurnStream.js';
import { createShutdown, type ExitReason } from './shutdown.js';
import { decideTuiMode, detectTerminalCapabilities, hasModernTerminalMarker } from './terminal-capabilities.js';
import { parseCommand, HELP_TEXT } from '../commands.js';
import { expandContextRefs, hasContextRefs } from '../context-ref.js';
import {
  emptyTranscript,
  projectSession,
  transcriptReducer,
  type TranscriptEvent,
  type TranscriptState,
} from './transcript.js';
import { turnSummaryLine } from '../render.js';
import {
  CORE_MODE_TO_ALIAS,
  MODE_ALIAS_ORDER,
  MODE_ALIAS_LABEL,
  MODE_ALIAS_TO_CORE,
  type ModeAlias,
} from '../mode-alias.js';
import { getContextUsage } from '@harness2/core';

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
    // T0 幂等退出：finish 只执行一次（ink unmount + runtime.finish），随后写 process.exitCode
    // 并放开等待；不再用 setInterval 轮询 stdin.destroyed（会遗留 timer）。
    const shutdown = createShutdown({
      finish: async () => {
        app?.unmount();
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
        onExit={(reason: ExitReason) => {
          shutdown.request(reason);
        }}
      />,
      { exitOnCtrlC: false, alternateScreen: useAlternateScreen },
    );
  });
}

const ASK_CANCELLED = '\u0000ask-cancelled';

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

function InkShell({
  runtime,
  bootLines,
  dialog,
  onExit,
}: {
  runtime: ChatRuntime;
  bootLines: string[];
  dialog: ReturnType<typeof createDialogController>;
  onExit: (reason: ExitReason) => void;
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
  // T5/T6：单一浮层宿主。命令与审批都经 overlay 呈现；存在即互斥接管键盘。
  const [overlay, setOverlay] = useState<React.ReactNode>(null);
  const closeOverlayRef = useRef<() => void>(() => undefined);
  const overlayOpen = overlay !== null;
  // T0：忙时 FIFO 排队（对齐 legacy-chat：忙碌中的输入不并发、当前 turn 收尾后立即执行下一条）
  const busyRef = useRef(false);
  const exitingRef = useRef(false);
  const queueRef = useRef<string[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);
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

  const dispatch = React.useCallback((event: TranscriptEvent) => {
    setTranscript((s) => transcriptReducer(s, event));
  }, []);
  const onTranscriptEvent = React.useCallback((event: TranscriptEvent) => dispatch(event), [dispatch]);

  const { live, handler, finalize, reset } = useTurnStream(onTranscriptEvent);

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
    };
    setOverlay(
      req.render(() => {
        req.resolve();
        dialog.clear();
        setOverlay(null);
      }),
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
   * 会话切换统一处理：收集 switch/fork 的输出，重投影新会话转录（整体替换，不在旧 items 上追加），
   * 清除展开/滚动状态，最后回放切换提示。
   */
  function applySessionChange(fn: (print: (t: string) => void) => void): void {
    const lines: string[] = [];
    fn((t) => lines.push(t));
    setTranscript(safeProject(runtime.getCurrent()?.dir));
    setExpandedIds(new Set());
    applyFollow(true);
    applyAnchor(undefined);
    applyScroll(0);
    for (const l of lines) sendSystem(l);
  }

  function openModePicker(): void {
    const mode = runtime.mode();
    const alias = CORE_MODE_TO_ALIAS[mode];
    const options = MODE_ALIAS_ORDER.map((a) => ({
      value: a,
      label: MODE_ALIAS_LABEL[a],
    }));
    setOverlay(
      <Modal title="切换模式（/mode）" hint="↑↓ 选择 · Enter 应用 · Esc 取消" onClose={() => setOverlay(null)} isActive>
        <SelectList
          options={options}
          selected={alias}
          isActive
          onSelect={(value: string) => {
            runtime.setMode(MODE_ALIAS_TO_CORE[value as ModeAlias]);
            sendSystem(`已切换模式: ${value}（当前 ${runtime.mode()}）`);
            setOverlay(null);
          }}
          onCancel={() => setOverlay(null)}
        />
      </Modal>,
    );
  }

  function openHelp(): void {
    setOverlay(
      <Modal title="帮助（/help）" hint="Esc 关闭" onClose={() => setOverlay(null)} isActive>
        <Text>{HELP_TEXT}</Text>
      </Modal>,
    );
  }

  function openSessions(): void {
    const current = runtime.getCurrent();
    const sessions = runtime.sessionManager.list(runtime.root);
    setOverlay(
      <Modal title="会话（/sessions）" hint="↑↓ 浏览 · Enter 切换 · Esc 关闭" onClose={() => setOverlay(null)} isActive>
        <SelectList
          options={sessions.map((s) => ({ value: s.id, label: s.id }))}
          selected={current?.id ?? ''}
          isActive
          onSelect={(id: string) => {
            applySessionChange((print) => runtime.switchSession(id, { print }));
            setOverlay(null);
          }}
          onCancel={() => setOverlay(null)}
        />
        <Box>
          <Text color="gray">共 {sessions.length} 个会话</Text>
        </Box>
      </Modal>,
    );
  }

  function handleCommand(name: string, rest: string): void {
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
        openHelp();
        return;
      case '/sessions':
        openSessions();
        return;
      case '/new':
        // 新建会话：重投影（新会话日志可能尚未落盘 → 空转录）
        applySessionChange((print) => runtime.switchSession(null, { print }));
        return;
      case '/resume': {
        const id = rest.split(/\s+/)[0] ?? '';
        if (id.length === 0) {
          sendSystem('error: 用法 /resume <id>（/sessions 查看 id）');
          return;
        }
        applySessionChange((print) => runtime.switchSession(id, { print }));
        return;
      }
      case '/fork': {
        const at = rest.length > 0 && Number.isInteger(Number(rest)) ? Number(rest) : undefined;
        applySessionChange((print) => runtime.fork(at, { print }));
        return;
      }
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
      case '/exit':
        exitingRef.current = true;
        if (busyRef.current) {
          // turn 进行中：先取消，等本轮收尾后由 finally 触发退出（对齐 legacy requestExit）
          runtime.abortTurn();
          return;
        }
        onExit('exit');
        return;
      default:
        sendSystem(`error: 未实现命令 ${name}（/help 查看）`);
    }
  }

  /** T0：取消当前 turn（Esc/Ctrl+C 忙时触发；abort 后 stopReason=cancelled，部分文本照常落定） */
  function abortCurrentTurn(): void {
    if (!busyRef.current) return;
    sendSystem('^C（正在取消当前 turn…）');
    runtime.abortTurn();
  }

  /** 取出一条排队输入并执行；exiting 后不再取（对齐 legacy 的 queue.shift 收尾逻辑） */
  function drainQueue(): void {
    if (exitingRef.current) return;
    const next = queueRef.current.shift();
    if (next === undefined) return;
    setQueuedCount(queueRef.current.length);
    void handleInput(next);
  }

  /** 忙时入队（不并发）；空闲时直接执行。命令与普通 turn 走同一入口（对齐 legacy）。 */
  function submit(text: string): void {
    if (text.trim().length === 0) return;
    if (busyRef.current) {
      queueRef.current.push(text);
      setQueuedCount(queueRef.current.length);
      return;
    }
    void handleInput(text);
  }

  async function handleInput(text: string): Promise<void> {
    const parsed = parseCommand(text);
    if (parsed !== null) {
      liveSeqRef.current += 1;
      dispatch({ type: 'system', id: `echo:${liveSeqRef.current}`, text: `> ${text}` });
      handleCommand(parsed.name, parsed.rest);
      if (!busyRef.current) drainQueue();
      return;
    }
    await runTurnText(text);
  }

  async function runTurnText(text: string): Promise<void> {
    reset();
    busyRef.current = true;
    let result: TurnResult | undefined;
    setBusy(true);
    liveSeqRef.current += 1;
    dispatch({ type: 'user/message', seq: 0, id: `user:live:${liveSeqRef.current}`, text });
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
        liveSeqRef.current += 1;
        dispatch({ type: 'status', id: `status:${liveSeqRef.current}`, text: turnSummaryLine(result) });
      }
    } catch (e) {
      sendSystem(`error: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      reset();
      busyRef.current = false;
      setBusy(false);
      setReasoningExpanded(false);
      if (exitingRef.current) onExit('exit');
      else drainQueue();
    }
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <StatusBar runtime={runtime} />
      {overlayOpen ? <OverlayHost>{overlay}</OverlayHost> : null}
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
        height={Math.max(3, rows - 8)}
        width={cols}
        onViewportChange={onViewportChange}
      />
      <Composer
        busy={busy}
        active={!overlayOpen}
        onSend={submit}
        onExit={(reason) => onExit(reason ?? 'exit')}
        onAbort={abortCurrentTurn}
        queuedCount={queuedCount}
      />
    </Box>
  );
}
