// SelectList：↑↓ 移动高亮、Enter 确认、Esc 取消（返回 null）。isActive 控制 useInput 互斥。
import React, { useEffect, useRef, useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
}

export interface SelectListProps<T extends string = string> {
  options: SelectOption<T>[];
  selected: T;
  isActive: boolean;
  onSelect: (value: T) => void;
  /** 取消（Esc 或没有匹配的 index） */
  onCancel: () => void;
}

/** 上下键高亮选择列表 */
export function SelectList<T extends string = string>({
  options,
  selected,
  isActive,
  onSelect,
  onCancel,
}: SelectListProps<T>): ReactElement {
  const defaultIndex = Math.max(
    0,
    options.findIndex((o) => o.value === selected),
  );
  const [index, setIndex] = useState(defaultIndex);
  const indexRef = useRef(index);
  indexRef.current = index;

  // 覆盖索引变更
  useEffect(() => {
    setIndex(defaultIndex);
  }, [defaultIndex]);

  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (options.length === 0) return;
      if (key.upArrow) {
        setIndex((i) => (i - 1 + options.length) % options.length);
      } else if (key.downArrow) {
        setIndex((i) => (i + 1) % options.length);
      } else if (key.tab) {
        setIndex((i) => (i + 1) % options.length);
      } else if (key.return) {
        const current = options[indexRef.current];
        if (current) onSelect(current.value);
      }
    },
    { isActive },
  );

  const isOutOfRange = index >= options.length;
  // 状态：用 indexRef 同步
  const cursor = isOutOfRange ? 0 : index;

  return (
    <Box flexDirection="column" minHeight={options.length}>
      {options.map((opt, i) => {
        const highlighted = i === cursor;
        return (
          <Box key={opt.value} minWidth={30}>
            <Text color={highlighted ? 'cyan' : undefined}>
              {highlighted ? '› ' : '  '}
              {opt.label}
            </Text>
            {opt.description && <Text color="gray">{`  ${opt.description}`}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
