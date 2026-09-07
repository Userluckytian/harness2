// ConfirmDialog：审批弹窗。y=同意本次 / a=本次会话总是允许 / n=拒绝。Esc = 拒绝。
// 替代 legacy 的 readline (y/N/a) 行内询问；返回值语义由调用方 map 到 askApproval 判定。
import React, { useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import { Modal } from './Modal.js';

export type ConfirmChoice = 'allow' | 'allow-always' | 'deny';

export interface ConfirmDialogProps {
  /** 审批描述（准备执行的 tool + arguments 摘要） */
  question: string;
  isActive: boolean;
  /** 选择结果：'allow' | 'allow-always' | 'deny' */
  onChoice: (choice: ConfirmChoice) => void;
  onCancel: () => void;
}

const CHOICES: { key: string; label: string }[] = [
  { key: 'y', label: 'y 允许本次' },
  { key: 'a', label: 'a 本次会话总是允许' },
  { key: 'n', label: 'n 拒绝' },
];

export function ConfirmDialog({ question, isActive, onChoice, onCancel }: ConfirmDialogProps): ReactElement {
  const [index, setIndex] = useState(0);

  useInput(
    (input, key) => {
      if (key.escape) {
        onChoice('deny');
        onCancel();
        return;
      }
      if (key.upArrow) {
        setIndex((i) => (i - 1 + CHOICES.length) % CHOICES.length);
        return;
      }
      if (key.downArrow) {
        setIndex((i) => (i + 1) % CHOICES.length);
        return;
      }
      if (key.return) {
        const c = CHOICES[index];
        if (c) {
          onChoice(c.key === 'y' ? 'allow' : c.key === 'a' ? 'allow-always' : 'deny');
          onCancel();
        }
        return;
      }
      const ch = input.trim().toLowerCase();
      if (ch === 'y') {
        onChoice('allow');
        onCancel();
      } else if (ch === 'a') {
        onChoice('allow-always');
        onCancel();
      } else if (ch === 'n') {
        onChoice('deny');
        onCancel();
      }
    },
    { isActive },
  );

  return (
    <Modal title="需要审批" hint="y/a/n 或 ↑↓+Enter，Esc=拒绝" onClose={() => { onChoice('deny'); onCancel(); }} isActive={isActive}>
      <Box flexDirection="column">
        <Text>{question}</Text>
        <Box flexDirection="column" marginTop={1}>
          {CHOICES.map((c, i) => (
            <Text key={c.key} color={i === index ? 'cyan' : undefined}>
              {i === index ? '› ' : '  '}
              {c.label}
            </Text>
          ))}
        </Box>
      </Box>
    </Modal>
  );
}