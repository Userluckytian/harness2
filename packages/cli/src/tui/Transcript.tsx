// Transcript：分层渲染——完结消息用 Static（只渲一次，避免长会话/滚动区闪烁）；
// 当前流式中的最后一块用普通 Box 随 state 重绘；工具调用渲染为 ToolCallCard，
// edit/write 结果在展开态用 DiffCard 展示红绿变更；推理过程用 ReasoningBlock 折叠。
import React, { type ReactElement } from 'react';
import { Static, Box, Text } from 'ink';
import type { ToolCallState } from './useTurnStream.js';
import { ReasoningBlock } from './ReasoningBlock.js';
import { DiffCard } from './DiffCard.js';

export interface TranscriptProps {
  /** 已完结的展示行（含完成后的工具卡片文本，统一按行存） */
  settled: string[];
  /** 当前流式块 live.text */
  liveText: string;
  liveTools: ToolCallState[];
  /** 当前 turn 流式累积的推理过程（仅 live，未完结） */
  reasoningText: string;
  busy: boolean;
  busyingReasoning?: boolean;
  reasoningExpanded?: boolean;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function ToolCallCard({ call, expanded }: { call: ToolCallState; expanded: boolean }): ReactElement {
  const icon = call.status === 'pending' ? '…' : call.status === 'ok' ? '✓' : '✗';
  const color = call.status === 'pending' ? 'yellow' : call.status === 'ok' ? 'green' : 'red';
  const args = parseArgs(call.args);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>&gt; </Text>
        <Text color={color}>{icon} </Text>
        <Text>{call.tool}</Text>
        <Text color="gray"> ({call.summary})</Text>
      </Box>
      {/* edit/write 展开态显示变更 diff（参数内可得的片段；edit=old_text→new_text，write=新内容） */}
      {expanded && call.tool === 'edit' && (
        <Box marginLeft={2}>
          <DiffCard
            title="edit 变更"
            before={typeof args.old_text === 'string' ? args.old_text : ''}
            after={typeof args.new_text === 'string' ? args.new_text : ''}
          />
        </Box>
      )}
      {expanded && call.tool === 'write' && (
        <Box marginLeft={2}>
          <DiffCard
            title="write 内容"
            before=""
            after={typeof args.content === 'string' ? args.content : ''}
          />
        </Box>
      )}
    </Box>
  );
}

/** 中间历史区：Static 承载已完结行；当前 turn 内最后一块放下方实时刷新 */
export function Transcript({
  settled,
  liveText,
  liveTools,
  reasoningText,
  busy,
  reasoningExpanded = false,
}: TranscriptProps): ReactElement {
  const tail = busy && liveText.length > 0 ? liveText : '';
  return (
    <Box flexGrow={1} flexDirection="column">
      <Static items={settled}>
        {(line) => <Text key={line}>{line}</Text>}
      </Static>
      {/* 当前 turn 的推理折叠块（仅 live 期且非空时显示） */}
      {busy && reasoningText.trim().length > 0 && (
        <ReasoningBlock text={reasoningText} expanded={reasoningExpanded} />
      )}
      {busy && liveTools.map((c) => <ToolCallCard key={c.callId} call={c} expanded={reasoningExpanded} />)}
      {tail.length > 0 && <Text color="gray">{tail}</Text>}
    </Box>
  );
}