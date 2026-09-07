// ink App Shell 组件：SummaryBar（顶部状态条）+ Transcript（中间历史/流式区）。
// T2 先占位（一条摘要 + 可变行列表），T4 做分层渲染/滚动，T6 填真实上下文占用。
import React from 'react';
import { Box, Text } from 'ink';
import type { ChatRuntime } from '../chat-setup.js';

export interface StreamChunk {
  text: string;
  busy: boolean;
}

/** 顶部状态条（占位）：provider 名 + mock 标记；T6 填模式别名/角色/cwd/上下文占用 */
export function SummaryBar({ runtime }: { runtime: ChatRuntime }): React.ReactElement {
  return (
    <Box flexDirection="row" borderStyle="single" justifyContent="space-between" paddingX={1}>
      <Text>harness2 chat — {runtime.provider.name}</Text>
      <Text color="gray">TUI</Text>
    </Box>
  );
}

/** 中间历史区（占位）：已完结行 + 当前流式行 */
export function Transcript({ lines, stream }: { lines: string[]; stream: StreamChunk }): React.ReactElement {
  return (
    <Box flexGrow={1} flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      {stream.busy && stream.text.length > 0 && (
        <Text color="gray">{stream.text.trim()}</Text>
      )}
    </Box>
  );
}