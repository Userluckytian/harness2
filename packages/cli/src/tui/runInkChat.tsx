// ink 全屏 TUI 入口：现代终端下启用，piped/CI/逃生舱仍走 legacy。
// 门控（T0 决策）：isTTY && !(HARNESS2_NO_TUI || --no-tui) && (HARNESS2_TUI=1 || 现代终端 || 默认全量)。
// 装配与 legacy 共用 setupChatSession（禁止两套装配）；渲染走 React state 桥接。
import React, { useState } from 'react';
import { render, useApp, Box, Text } from 'ink';
import { setupChatSession, type ChatRuntime } from '../chat-setup.js';
import type { ChatOptions } from '../legacy-chat.js';
import { SummaryBar, Transcript, type StreamChunk } from './App.js';
import { Composer } from './Composer.js';

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
  const [lines, setLines] = useState<string[]>(bootLines);
  const [stream, setStream] = useState<StreamChunk>({ text: '', busy: false });
  const [busy, setBusy] = useState(false);

  async function submit(text: string): Promise<void> {
    if (text.trim().length === 0 || busy) return;
    let accumulated = '';
    setBusy(true);
    setLines((l) => [...l, `> ${text}`]);
    setStream({ text: '', busy: true });
    try {
      const result = await runtime.runUserTurn(text, (event) => {
        if (event.type === 'text-delta') {
          accumulated += event.text;
          setStream((s) => ({ ...s, text: accumulated }));
        } else if (event.type === 'tool-call') {
          const args = event.call.arguments.replace(/\s+/g, ' ').slice(0, 72);
          accumulated = `${accumulated}${accumulated.length > 0 && !accumulated.endsWith('\n') ? '\n' : ''}> ${event.call.name} (${args})\n`;
          setStream((s) => ({ ...s, text: accumulated }));
        } else if (event.type === 'tool-result') {
          accumulated = `${accumulated}${!accumulated.endsWith('\n') ? '\n' : ''}< ${event.ok ? 'ok' : 'FAILED'} [${event.callId}]${event.error ? ` ${event.error}` : ''}\n`;
          setStream((s) => ({ ...s, text: accumulated }));
        }
      });
      const doneText = accumulated.trim();
      if (doneText.length > 0) setLines((l) => [...l, doneText]);
      // turn 摘要（对齐 legacy 的 [end_turn ...] 行）
      const parts = [`[${result.stopReason}`, `steps ${result.steps}`, `toolCalls ${result.toolCalls}`];
      if (result.error !== undefined) parts.push(`error: ${result.error}`);
      if (result.warning !== undefined) parts.push(`warning: ${result.warning}`);
      setLines((l) => [...l, parts.join(' · ') + ']']);
    } catch (e) {
      setLines((l) => [...l, `error: ${(e as Error)?.message ?? String(e)}`]);
    } finally {
      setStream({ text: '', busy: false });
      setBusy(false);
    }
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <SummaryBar runtime={runtime} />
      <Transcript lines={lines} stream={stream} />
      <Composer busy={busy} onSend={(t) => void submit(t)} onExit={() => exit(0)} />
    </Box>
  );
}