// Transcript：分层渲染——完结消息用 Static（只渲一次，避免长会话/滚动区闪烁）；
// 当前流式中的最后一块用普通 Box 随 state 重绘；工具调用渲染为 ToolCallCard。
import React, { type ReactElement } from 'react';
import { Static, Box, Text } from 'ink';
import type { ToolCallState } from './useTurnStream.js';

export interface TranscriptProps {
  /** 已完结的展示行（含完成后的工具卡片文本，统一按行存） */
  settled: string[];
  /** 当前流式块 live.text */
  liveText: string;
  liveTools: ToolCallState[];
  busy: boolean;
}

function ToolCallCard({ call }: { call: ToolCallState }): ReactElement {
  const icon = call.status === 'pending' ? '…' : call.status === 'ok' ? '✓' : '✗';
  const color = call.status === 'pending' ? 'yellow' : call.status === 'ok' ? 'green' : 'red';
  return (
    <Box>
      <Text color={color}>&gt; </Text>
      <Text color={color}>{icon} </Text>
      <Text>{call.tool}</Text>
      <Text color="gray"> ({call.summary})</Text>
    </Box>
  );
}

/** 中间历史区：Static 承载已完结行；当前 turn 内最后一块放下方实时刷新 */
export function Transcript({ settled, liveText, liveTools, busy }: TranscriptProps): ReactElement {
  const tail = busy && liveText.length > 0 ? liveText : '';
  return (
    <Box flexGrow={1} flexDirection="column">
      <Static items={settled}>
        {(line) => <Text key={line}>{line}</Text>}
      </Static>
      {busy && liveTools.map((c) => <ToolCallCard key={c.callId} call={c} />)}
      {tail.length > 0 && <Text color="gray">{tail}</Text>}
    </Box>
  );
}