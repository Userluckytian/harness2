// ReasoningBlock：当前 turn 的推理过程显示块。默认折叠为一行；
// 由 InkShell 的 Ctrl+R 键切换 expanded（受控），展开显示完整灰色斜体文本。
// （T0 起忙时 Composer 也接管普通字符，快捷键由 r 改为 Ctrl+R）
import React, { type ReactElement } from 'react';
import { Box, Text } from 'ink';

export interface ReasoningBlockProps {
  text: string;
  expanded: boolean;
}

export function ReasoningBlock({ text, expanded }: ReasoningBlockProps): ReactElement {
  const trimmed = text.trim();
  if (trimmed.length === 0) return <Box />;
  return (
    <Box>
      {expanded ? (
        <Text color="gray" dimColor>
          {trimmed}
        </Text>
      ) : (
        <Text color="gray">[reasoning · 按 Ctrl+R 展开] {trimmed.replace(/\s+/g, ' ').slice(0, 72)}…</Text>
      )}
    </Box>
  );
}
