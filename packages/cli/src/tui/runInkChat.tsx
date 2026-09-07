// ink 全屏 TUI 入口：现代终端下启用，piped/CI/逃生舱仍走 legacy。
// 门控（T0 决策）：isTTY && !(HARNESS2_NO_TUI || --no-tui) && (HARNESS2_TUI=1 || 现代终端 || 默认全量)。
// 装配与 legacy 共用 setupChatSession（禁止两套装配）；渲染走 React state 桥接。
import React, { useState } from 'react';
import { render, useApp, useInput, Box, Text } from 'ink';
import { setupChatSession, type ChatRuntime } from '../chat-setup.js';
import type { ChatOptions } from '../legacy-chat.js';
import { SummaryBar, Transcript, type StreamChunk } from './App.js';

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
      <InkShell runtime={runtime} options={options} bootLines={bootLines} onExit={resolve} />,
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
  options,
  bootLines,
  onExit,
}: {
  runtime: ChatRuntime;
  options: ChatOptions;
  bootLines: string[];
  onExit: () => void;
}): React.ReactElement {
  const { exit } = useApp();
  const [lines, setLines] = useState<string[]>(bootLines);
  const [input, setInput] = useState('');
  const [stream, setStream] = useState<StreamChunk>({ text: '', busy: false });
  const [busy, setBusy] = useState(false);
  let lastCtrlCAt = 0;

  useInput((_input, key) => {
    if (busy) return; // turn 期间输入排队由后续处理（先占位：忽略）
    if (key.ctrl && _input === 'c') {
      const now = Date.now();
      if (now - lastCtrlCAt < 2000) {
        exit(130);
        return;
      }
      lastCtrlCAt = now;
      setLines((l) => [...l, '（再按一次 Ctrl+C 退出）']);
      return;
    }
    if (key.return) {
      void submit();
      return;
    }
    if (key.backspace) {
      setInput((i) => i.slice(0, -1));
      return;
    }
    if (_input !== undefined && _input !== '') {
      setInput((i) => i + _input);
    }
  });

  async function submit(): Promise<void> {
    const text = input.trim();
    if (text.length === 0 || busy) return;
    setInput('');
    setBusy(true);
    setLines((l) => [...l, `> ${text}`]);
    setStream({ text: '', busy: true });
    try {
      await runtime.runUserTurn(text, (event) => {
        if (event.type === 'text-delta') setStream((s) => ({ ...s, text: s.text + event.text }));
        else if (event.type === 'tool-call') {
          const args = event.call.arguments.replace(/\s+/g, ' ').slice(0, 72);
          setStream((s) => ({
            ...s,
            text: `${s.text}${s.text.length > 0 && !s.text.endsWith('\n') ? '\n' : ''}> ${event.call.name} (${args})\n`,
          }));
        } else if (event.type === 'tool-result') {
          setStream((s) => ({
            ...s,
            text: `${s.text}${!s.text.endsWith('\n') ? '\n' : ''}< ${event.ok ? 'ok' : 'FAILED'} [${event.callId}]${event.error ? ` ${event.error}` : ''}\n`,
          }));
        }
      });
      if (stream.text.length > 0) setLines((l) => [...l, stream.text.trim()]);
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
      <Box flexDirection="column" borderStyle="round" flexShrink={0}>
        <Text color="gray">composer（占位：回车发送，Ctrl+C 退出）</Text>
        <Box flexDirection="row">
          <Text color="green">&gt; </Text>
          <Text>{input}</Text>
        </Box>
      </Box>
    </Box>
  );
}