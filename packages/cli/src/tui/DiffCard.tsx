// DiffCard：用 diff（行级）渲染 before→after 的变化，红删绿增。
// 输入为文本对（如 edit 的 old_text→new_text、write 的新文件内容与空 before）；
// 前 20 行默认展示，超出可展开全部。OpenCode 环境不用真 ANSI 检测，降级用前景色。
import React, { type ReactElement } from 'react';
import { Box, Text } from 'ink';
import { diffLines } from 'diff';

export interface DiffCardProps {
  title: string;
  before: string;
  after: string;
  /** 默认展示的最大行数（超出折叠，按展开） */
  maxLines?: number;
}

const DEFAULT_MAX_LINES = 20;

export function DiffCard({ title, before, after, maxLines = DEFAULT_MAX_LINES }: DiffCardProps): ReactElement {
  const parts = diffLines(before, after);
  // 行化差异块（每块可能是多行文本）
  const rows: Array<{ type: 'keep' | 'add' | 'remove' | 'context'; text: string }> = [];
  for (const part of parts) {
    const lines = part.value.split('\n');
    // 去掉末尾空串（diff 在最后一段会带结尾换行产生的空项）
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const type: 'keep' | 'add' | 'remove' = part.added ? 'add' : part.removed ? 'remove' : 'keep';
    for (const line of lines) {
      rows.push({ type, text: line });
    }
  }

  const total = rows.length;
  const visible = maxLines > 0 ? rows.slice(0, maxLines) : rows;
  const hasMore = total > visible.length;

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {visible.map((row, i) => {
        if (row.type === 'add') {
          return <Text key={i} color="green">+ {row.text}</Text>;
        }
        if (row.type === 'remove') {
          return <Text key={i} color="red">- {row.text}</Text>;
        }
        return <Text key={i} color="gray">{row.text}</Text>;
      })}
      {hasMore && <Text color="gray">… 还有 {total - maxLines} 行</Text>}
    </Box>
  );
}