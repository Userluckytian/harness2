// ink App Shell 组件：SummaryBar（顶部状态条）。
// T2 先占位（一条摘要），T4 起流式在 Transcript 独立组件，T6 填真实上下文占用。
import React from 'react';
import { Box, Text } from 'ink';
import type { ChatRuntime } from '../chat-setup.js';

/** 顶部状态条（占位）：provider 名 + mock 标记；T6 填模式别名/角色/cwd/上下文占用 */
export function SummaryBar({ runtime }: { runtime: ChatRuntime }): React.ReactElement {
  return (
    <Box flexDirection="row" borderStyle="single" justifyContent="space-between" paddingX={1}>
      <Text>harness2 chat — {runtime.provider.name}</Text>
      <Text color="gray">TUI</Text>
    </Box>
  );
}