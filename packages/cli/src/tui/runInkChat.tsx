// ink 全屏 TUI 入口：现代终端下启用，piped/CI/逃生舱仍走 legacy。
// 门控（T0 决策）：isTTY && !(HARNESS2_NO_TUI || --no-tui) && (HARNESS2_TUI=1 || 现代终端 || 默认全量)。
// 装配与 legacy 共用 setupChatSession（禁止两套装配）；渲染走 React state 桥接。
import React, { useRef, useState } from 'react';
import { render, useApp, Box, Text } from 'ink';
import { setupChatSession, type ChatRuntime, type TurnResult } from '../chat-setup.js';
import type { ChatOptions } from '../legacy-chat.js';
import { StatusBar } from './StatusBar.js';
import { Composer } from './Composer.js';
import { Transcript } from './Transcript.js';
import { OverlayHost } from './OverlayHost.js';
import { Modal } from './Modal.js';
import { SelectList } from './SelectList.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { useTurnStream, type TurnSnapshot } from './useTurnStream.js';
import { parseCommand, HELP_TEXT } from '../commands.js';
import { CORE_MODE_TO_ALIAS, MODE_ALIAS_ORDER, MODE_ALIAS_LABEL, MODE_ALIAS_TO_CORE, type ModeAlias } from '../mode-alias.js';
import type { ApprovalMode } from '@harness2/core';
import { getContextUsage } from '@harness2/core';

/** 现代终端检测：Windows Terminal（WT_SESSION）或 VS Code 终端（TERM_PROGRAM=vscode） */
export function isModernTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.WT_SESSION) || env.TERM_PROGRAM === 'vscode';
}

/** T0 决策：默认所有 TTY 都尝试 ink；现代终端检测通过或 HARNESS2_TUI=1 强制开启 */
export function shouldUseInk(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HARNESS2_NO_TUI === '1') return false;
  if (argv.includes('--no-tui')) return false;
  if (!process.stdin.isTTY) return false;
  if (env.HARNESS2_TUI === '1' || isModernTerminal(env)) return true;
  return true; // T0 决策：默认全量启用 TTY → ink
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
} {
  let pending: DialogRequest | null = null;
  return {
    open: (req) => {
      pending?.resolve(); // 清掉旧挂起（理论上一时刻只有一个）
      pending = req;
    },
    getPending: () => pending,
    clear: () => {
      pending = null;
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
    const app = render(
      <InkShell runtime={runtime} bootLines={bootLines} dialog={dialog} onExit={resolve} />,
      { exitOnCtrlC: false },
    );
    const timer = setInterval(() => {
      if (process.stdin.destroyed) {
        clearInterval(timer);
        app.unmount();
        resolve();
      }
    }, 200);
  });
}

const ASK_CANCELLED = '\u0000ask-cancelled';

function InkShell({
  runtime,
  bootLines,
  dialog,
  onExit,
}: {
  runtime: ChatRuntime;
  bootLines: string[];
  dialog: ReturnType<typeof createDialogController>;
  onExit: () => void;
}): React.ReactElement {
  const { exit } = useApp();
  const [settled, setSettled] = useState<string[]>(bootLines);
  const [busy, setBusy] = useState(false);
  // T5/T6：单一浮层宿主。命令与审批都经 overlay 呈现；存在即互斥接管键盘。
  const [overlay, setOverlay] = useState<React.ReactNode>(null);
  const closeOverlayRef = useRef<() => void>(() => undefined);

  const { live, handler, commit, reset } = useTurnStream((snapshot: TurnSnapshot) => {
    const text = snapshot.text.trim();
    if (text.length > 0) setSettled((l) => [...l, text]);
  });

  // 同步 dialog controller 里的挂起请求（审批弹窗）到 overlay
  React.useEffect(() => {
    const req = dialog.getPending();
    if (req === null) {
      if (typeof closeOverlayRef.current === 'function') {
        // 只清 approval 类型（不由命令触发的）；命令用 setOverlay 直接管理
      }
      return;
    }
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
  }, [dialog]);

  function sendSystem(line: string): void {
    setSettled((l) => [...l, line]);
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
            runtime.switchSession(id, { print: sendSystem });
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
      case '/context': {
        const current = runtime.getCurrent();
        const usage = current !== null ? getContextUsage(current.dir) : undefined;
        sendSystem(
          `上下文占用: ${usage === undefined ? '—（无活动会话）' : `${Math.round(usage * 100)}%`}`,
        );
        return;
      }
      case '/compact':
        sendSystem('压缩将在下一次 turn 开始时自动检查并执行；若已超阈值会自动触发。');
        return;
      case '/reasoning':
        sendSystem('推理过程展示默认关闭（/reasoning on|off），T8 实现展开交互。');
        return;
      case '/tasks':
        sendSystem('任务列表请使用 `harness2 cron list` 查看（REPL 只读展示将在后续版本提供）。');
        return;
      case '/exit':
        exit(0);
        return;
      default:
        sendSystem(`error: 未实现命令 ${name}（/help 查看）`);
    }
  }

  async function submit(text: string): Promise<void> {
    if (text.trim().length === 0 || busy) return;
    const parsed = parseCommand(text);
    if (parsed !== null) {
      setSettled((l) => [...l, `> ${text}`]);
      handleCommand(parsed.name, parsed.rest);
      return;
    }
    reset();
    let result: TurnResult | undefined;
    setBusy(true);
    setSettled((l) => [...l, `> ${text}`]);
    try {
      result = await runtime.runUserTurn(text, handler);
      commit();
      if (result !== undefined) {
        // turn 摘要（对齐 legacy 的 [end_turn ...] 行）
        const parts = [`[${result.stopReason}`, `steps ${result.steps}`, `toolCalls ${result.toolCalls}`];
        if (result.error !== undefined) parts.push(`error: ${result.error}`);
        if (result.warning !== undefined) parts.push(`warning: ${result.warning}`);
        setSettled((l) => [...l, parts.join(' · ') + ']']);
      }
    } catch (e) {
      setSettled((l) => [...l, `error: ${(e as Error)?.message ?? String(e)}`]);
    } finally {
      setBusy(false);
    }
  }

  const overlayOpen = overlay !== null;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <StatusBar runtime={runtime} />
      {overlayOpen ? <OverlayHost>{overlay}</OverlayHost> : null}
      <Transcript settled={settled} liveText={live.text} liveTools={live.tools} busy={busy} />
      <Composer busy={busy} active={!overlayOpen} onSend={(t) => void submit(t)} onExit={() => exit(0)} />
    </Box>
  );
}