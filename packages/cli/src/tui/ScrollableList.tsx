// ScrollableList：超过可视高度时只渲染窗口内条目，首尾显示省略指示。
import React, { useEffect, useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';

export interface ScrollableListProps {
  /** 展示条目（纯文本） */
  items: string[];
  /** 可视高度（行数） */
  viewport: number;
  isActive: boolean;
}

/** 上下滚动、窗口跟随光标的列表区 */
export function ScrollableList({ items, viewport, isActive }: ScrollableListProps): ReactElement {
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
      } else if (key.downArrow) {
        setCursor((c) => Math.min(items.length - 1, c + 1));
      } else if (key.pageUp) {
        setCursor((c) => Math.max(0, c - viewport));
      } else if (key.pageDown) {
        setCursor((c) => Math.min(items.length - 1, c + viewport));
      }
    },
    { isActive },
  );

  // 光标跟随：滚动窗口保持光标可见
  useEffect(() => {
    if (cursor < offset) setOffset(cursor);
    else if (cursor >= offset + viewport) setOffset(cursor - viewport + 1);
  }, [cursor, viewport, offset]);

  if (items.length === 0) {
    return <Text color="gray">（空）</Text>;
  }

  const visible = items.slice(offset, offset + viewport);
  return (
    <Box flexDirection="column" minHeight={1}>
      {offset > 0 && <Text color="gray">↑ {offset} 行</Text>}
      {visible.map((line, i) => {
        const absIndex = offset + i;
        const highlighted = absIndex === cursor;
        return (
          <Box key={absIndex} minWidth={1}>
            <Text color={highlighted ? 'cyan' : undefined}>{line}</Text>
          </Box>
        );
      })}
      {offset + viewport < items.length && (
        <Text color="gray">↓ {items.length - offset - visible.length} 行</Text>
      )}
    </Box>
  );
}