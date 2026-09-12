// SubagentView（T1）：子会话只读浮层内容。
// - 复用 projectSession（core 只读重投影）从子会话目录重建转录，纯展示；
// - 不提供任何输入/undo/审批（只读；不订阅、不桥接实时流）；
// - 目录不存在 / 定位失败 / 读取失败时渲染如实错误文案（绝不伪造内容）。
import React, { useMemo, type ReactElement } from 'react';
import { Box, Text } from 'ink';
import { projectSession } from './transcript.js';
import { Transcript } from './TranscriptView.js';

export interface SubagentViewProps {
  /** 子会话 id（仅展示用；实际路径来自 dir） */
  sessionId: string;
  /** 已定位的子会话目录；undefined = 定位失败（此时 locateError 应给出原因） */
  dir: string | undefined;
  /** 定位阶段的失败原因（locate 抛错信息） */
  locateError?: string;
  width?: number;
  height?: number;
}

export function SubagentView({
  sessionId,
  dir,
  locateError,
  width,
  height,
}: SubagentViewProps): ReactElement {
  const content = useMemo(() => {
    if (dir === undefined) {
      return { kind: 'error' as const, message: locateError ?? '未定位到子会话目录' };
    }
    try {
      return { kind: 'ok' as const, items: projectSession(dir).items };
    } catch (e) {
      return { kind: 'error' as const, message: (e as Error)?.message ?? String(e) };
    }
  }, [dir, locateError]);

  if (content.kind === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="red">无法读取子会话 {sessionId}: {content.message}</Text>
        <Text color="gray">（子会话目录不存在或日志尚未落盘；父会话日志仍在原处）</Text>
      </Box>
    );
  }

  return <Transcript items={content.items} height={height} width={width} />;
}
