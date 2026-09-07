// ink 全屏 TUI 入口：现代终端下启用，piped/CI/逃生舱仍走 legacy。
// 门控（T0 决策）：isTTY && !(HARNESS2_NO_TUI || --no-tui) && (HARNESS2_TUI=1 || 现代终端 || 默认全量)。
// 装配与 legacy 共用 setupChatSession（禁止两套装配）；渲染走 React state 桥接。
import React, { useState } from 'react';
import { render, useApp, Box } from 'ink';
import { setupChatSession, type ChatRuntime, type TurnResult } from '../chat-setup.js';
import type { ChatOptions } from '../legacy-chat.js';
import { SummaryBar } from './App.js';
import { Composer } from './Composer.js';
import { Transcript } from './Transcript.js';
import { useTurnStream, type TurnSnapshot } from './useTurnStream.js';

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

/** 等待由组件内完成（temporary shell promise 由 ink 的 unmount 结束） */
export async function runInkChat(options: ChatOptions = {}): Promise<void> {
  const bootLines: string[] = [];
  const runtime = await setupChatSession(options, {
    line: (t) => bootLines.push(t),
    askApproval: async () => ASK_CANCELLED, // T5 换成 ConfirmDialog
  });

  await new Promise<void>((resolve) => {
    const app = render(
      <InkShell runtime={runtime} bootLines={bootLines} onExit={resolve} />,
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
  onExit,
}: {
  runtime: ChatRuntime;
  bootLines: string[];
  onExit: () => void;
}): React.ReactElement {
  const { exit } = useApp();
  const [settled, setSettled] = useState<string[]>(bootLines);
  const [busy, setBusy] = useState(false);

  const { live, handler, commit, reset } = useTurnStream((snapshot: TurnSnapshot) => {
    const text = snapshot.text.trim();
    if (text.length > 0) setSettled((l) => [...l, text]);
  });

  async function submit(text: string): Promise<void> {
    if (text.trim().length === 0 || busy) return;
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

  return (
    <Box flexDirection="column" flexGrow={1}>
      <SummaryBar runtime={runtime} />
      <Transcript settled={settled} liveText={live.text} liveTools={live.tools} busy={busy} />
      <Composer busy={busy} onSend={(t) => void submit(t)} onExit={() => exit(0)} />
    </Box>
  );
}