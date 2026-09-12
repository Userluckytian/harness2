// Transcript（T3）：typed item 分层渲染 + 虚拟化 viewport。
// - 不再用 Static + string[]：历史是 TranscriptItem[]，工具/推理卡片在 turn 落定后仍是组件，
//   可按稳定 id 展开（H2 闭环）。
// - 只渲染 viewport 切片（computeViewport），长历史渲染量有界；高度用 estimateItemHeight 估高 +
//   transcriptHeightCache 缓存（宽度/展开态变化时失效）。
// - 冻结语义：partial 标「未完成 / 已中断」+ stopReason/error；empty 只渲染 stopReason/error，
//   禁止空白气泡；final 按普通正文渲染；reasoning 只展示 provider 明确暴露的内容。
import React, { type ReactElement } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { ReasoningBlock } from './ReasoningBlock.js';
import { DiffCard } from './DiffCard.js';
import {
  computeViewport,
  estimateItemHeight,
  itemContentSignature,
  transcriptHeightCache,
  type TranscriptItem,
} from './transcript.js';

export interface TranscriptProps {
  /** 已落定结构条目（稳定 id） */
  items: TranscriptItem[];
  /** 当前流式正文（未完结，随 flush 更新） */
  liveText?: string;
  /** 当前流式推理（仅 provider 暴露的 reasoning-delta） */
  liveReasoning?: string;
  busy?: boolean;
  /** 推理折叠块展开态（Ctrl+R） */
  reasoningExpanded?: boolean;
  /** 已展开卡片 id 集合（shell 持有；落定后仍有效 = H2） */
  expandedIds?: ReadonlySet<string>;
  /** 是否贴尾跟随 */
  follow?: boolean;
  /** 绝对滚动偏移（非 follow 时生效） */
  scrollTop?: number;
  /** 锚点 item id（非 follow 时保证其可见） */
  anchorId?: string;
  /** 可用高度（缺省取终端 rows - 1；shell 传入扣除 StatusBar/Composer 后的实际值） */
  height?: number;
  /** 渲染宽度（缺省取终端 columns） */
  width?: number;
  /** viewport 变化回调（shell 用 ref 记录 maxScroll/首个可见 id 以实现锚定滚动） */
  onViewportChange?: (info: {
    totalHeight: number;
    maxScroll: number;
    start: number;
    end: number;
    firstVisibleId?: string;
  }) => void;
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const EXPAND_HINT = '[未完成 / 已中断]';

function reasonLine(stopReason: string | undefined, error: string | undefined): string {
  const parts: string[] = [];
  if (stopReason !== undefined && stopReason.length > 0) parts.push(`stopReason=${stopReason}`);
  if (error !== undefined && error.length > 0) parts.push(error);
  return parts.length > 0 ? parts.join(' · ') : '（无错误详情）';
}

function ToolCard({
  item,
  expanded,
}: {
  item: Extract<TranscriptItem, { kind: 'tool' }>;
  expanded: boolean;
}): ReactElement {
  const icon = item.status === 'pending' ? '…' : item.status === 'ok' ? '✓' : '✗';
  const color = item.status === 'pending' ? 'yellow' : item.status === 'ok' ? 'green' : 'red';
  const args = parseArgs(item.args);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>&gt; </Text>
        <Text color={color}>{icon} </Text>
        <Text>{item.tool}</Text>
        <Text color="gray"> ({item.summary})</Text>
      </Box>
      {/* T1：subagent 结果解析出子会话 id → 只读入口提示（解析不到不显示）
       * 键位说明：Ctrl+K 在所有终端可用（0x0B）；Ctrl+J 需终端走 kitty CSI-u 协议（0x0A 与 Enter 同字节） */}
      {item.childSessionId !== undefined && (
        <Text color="gray"> ↳ 子会话 {item.childSessionId}（Ctrl+J/K 查看）</Text>
      )}
      {/* 失败原因始终可见（真实 error，不只藏在展开态） */}
      {item.error !== undefined && item.error.length > 0 && <Text color="red"> ↳ {item.error}</Text>}
      {expanded && item.tool === 'edit' && (
        <Box marginLeft={2}>
          <DiffCard
            title="edit 变更"
            before={typeof args.old_text === 'string' ? args.old_text : ''}
            after={typeof args.new_text === 'string' ? args.new_text : ''}
          />
        </Box>
      )}
      {expanded && item.tool === 'write' && (
        <Box marginLeft={2}>
          <DiffCard title="write 内容" before="" after={typeof args.content === 'string' ? args.content : ''} />
        </Box>
      )}
      {/* 真实工具输出（来自会话 tool/result.output；展开态展示） */}
      {expanded && item.output !== undefined && item.output.length > 0 && (
        <Box marginLeft={2} flexDirection="column">
          <Text color="gray">输出:</Text>
          <Text color="gray">{item.output}</Text>
        </Box>
      )}
    </Box>
  );
}

function renderItem(item: TranscriptItem, expanded: boolean, reasoningExpanded: boolean): ReactElement {
  switch (item.kind) {
    case 'user':
      return <Text>{`> ${item.text}`}</Text>;
    case 'assistant':
      return (
        <Box flexDirection="column">
          <Text>{item.text}</Text>
          {item.reasoning !== undefined && item.reasoning.trim().length > 0 && (
            <ReasoningBlock text={item.reasoning} expanded={reasoningExpanded} />
          )}
        </Box>
      );
    case 'partial':
      return (
        <Box flexDirection="column">
          <Text>{item.text}</Text>
          <Text color="yellow">
            {EXPAND_HINT} {reasonLine(item.stopReason, item.error)}
          </Text>
        </Box>
      );
    case 'empty':
      // 禁止空白气泡：即使无正文也必须给出 stopReason/error 的可读行
      return (
        <Text color="red">
          {EXPAND_HINT} {reasonLine(item.stopReason, item.error)}
        </Text>
      );
    case 'tool':
      return <ToolCard item={item} expanded={expanded} />;
    case 'system':
    case 'status':
      return <Text>{item.text}</Text>;
    default:
      return <Box />;
  }
}

/** 历史区：只渲染 viewport 切片；live 正文/推理在切片下方随 flush 刷新 */
export function Transcript({
  items,
  liveText = '',
  liveReasoning = '',
  busy = false,
  reasoningExpanded = false,
  expandedIds,
  follow = true,
  scrollTop = 0,
  anchorId,
  height,
  width,
  onViewportChange,
}: TranscriptProps): ReactElement {
  const { columns, rows } = useWindowSize();
  const w = width ?? columns ?? 80;
  const h = height ?? Math.max(3, (rows ?? 24) - 1);
  const cacheRef = React.useRef(transcriptHeightCache());

  // 宽度变化时弃用旧估高（复合 key 已含宽度，这里回收内存）
  React.useEffect(() => {
    cacheRef.current.invalidate();
  }, [w]);

  const { heights, totalHeight } = React.useMemo(() => {
    const cache = cacheRef.current;
    const hs: number[] = [];
    let total = 0;
    for (const item of items) {
      const expanded = expandedIds?.has(item.id) ?? false;
      const key = `${item.id}|${w}|${expanded ? 1 : 0}|${itemContentSignature(item)}`;
      let value = cache.get(key);
      if (value === undefined) {
        value = estimateItemHeight(item, w);
        cache.set(key, value);
      }
      hs.push(value);
      total += value;
    }
    return { heights: hs, totalHeight: total };
  }, [items, w, expandedIds]);

  const viewport = computeViewport(items, {
    heights,
    totalHeight,
    height: h,
    follow,
    ...(anchorId !== undefined ? { anchorId } : {}),
    scrollTop,
  });

  React.useEffect(() => {
    if (onViewportChange === undefined) return;
    const firstVisible = items[viewport.start];
    onViewportChange({
      totalHeight,
      maxScroll: Math.max(0, totalHeight - h),
      start: viewport.start,
      end: viewport.end,
      ...(firstVisible !== undefined ? { firstVisibleId: firstVisible.id } : {}),
    });
  }, [items, totalHeight, h, viewport.start, viewport.end, onViewportChange]);

  const visible = items.slice(viewport.start, viewport.end);
  return (
    <Box flexGrow={1} flexDirection="column">
      {!viewport.follow && <Text color="gray">[已暂停跟随 · Ctrl+G 回到末尾]</Text>}
      {visible.map((item) => (
        <Box key={item.id} flexDirection="column">
          {renderItem(item, expandedIds?.has(item.id) ?? false, reasoningExpanded)}
        </Box>
      ))}
      {/* 当前 turn 的推理折叠块（仅 live 期且非空时显示；只展示 provider 暴露内容） */}
      {busy && liveReasoning.trim().length > 0 && <ReasoningBlock text={liveReasoning} expanded={reasoningExpanded} />}
      {busy && liveText.length > 0 && <Text color="gray">{liveText}</Text>}
    </Box>
  );
}
