// Modal：居中边框容器 + 标题 + 内容 + 底部操作提示，Esc 关闭（回调由调用方传入）。
import React, { type ReactNode, type ReactElement } from 'react';
import { Box, Text, useStdout, useInput } from 'ink';

export interface ModalProps {
  title: string;
  hint?: string;
  /** Esc 关闭（由调用方传入关闭回调） */
  onClose: () => void;
  children: ReactNode;
  isActive: boolean;
}

/** 居中边框弹窗：Esc 关闭 */
export function Modal({ title, hint = 'Esc 关闭', onClose, children, isActive }: ModalProps): ReactElement {
  const { stdout } = useStdout();
  const width = stdout.columns ?? 80;

  useInput(
    (_input, key) => {
      if (key.escape) onClose();
    },
    { isActive },
  );

  const frameWidth = Math.min(Math.max(width - 4, 40), 76);
  return (
    <Box width={frameWidth} flexDirection="column" borderStyle="round" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold>{title}</Text>
      </Box>
      <Box flexDirection="column">{children}</Box>
      <Box marginTop={1}>
        <Text color="gray">{hint}</Text>
      </Box>
    </Box>
  );
}