// 轮次导航（Z2-09b / Z-17 `ConversationTurnNavigator`）：左侧细 rail，按需出现。
//
// ZCode 条件（refs-zcode-layout.md Z-17 / §6 矩阵）：**轮次 ≥2 且容器 ≥864px**，不持久化。
//   - 轮次 ≥2：JS 侧判定（deriveTurns().length ≥ TURN_NAVIGATOR_MIN_TURNS）；
//   - 容器 ≥864px：CSS @container 断点（与 Z3-03 状态面板同一手法，以会话列为容器；
//     jsdom 测不了像素断点 → 常量与纯函数 turnNavigatorVisible 在此钉住，CSS 规则由
//     desktop 样式断言钉住，双保险）。
//
// 数据链路：ChatItem 流（P3-b turn 语义；turn-header / user 条目自带 turnId）→ deriveTurns
// 归组 → 轮次序号 + 首句截断标题。点击定位：滚动容器内 `[data-turn-id]` 行（ChatItemView 的
// turn-header 行携带）→ scrollTop 定位；当前轮由滚动位置判定（视口顶部内缩线）。
import type { ReactNode } from 'react';
import type { ChatItem } from '../chat-model.js';

/** 显示所需的最少轮次数（Z-17：≥2 项） */
export const TURN_NAVIGATOR_MIN_TURNS = 2;
/** 显示所需的最小容器宽（px；Z-17：conversation 列 ≥864px） */
export const TURN_NAVIGATOR_MIN_CONTAINER_PX = 864;
/** 跳转定位与「当前轮」判定的顶部内缩线（px） */
export const TURN_NAV_TOP_INSET_PX = 32;
/** 轮次标题截断上限（字符；首句截断用） */
export const TURN_TITLE_MAX_CHARS = 48;

export interface TurnNavEntry {
  turnId: string;
  /** 1 起的轮次序号 */
  index: number;
  /** 该轮首条 user 消息的首句截断标题（无 user 文本 → undefined，title 属性回落序号） */
  title?: string;
}

/** 显示阈值（Z-17：轮次 ≥2 且容器 ≥864px；单一事实源，组件与测试共用） */
export function turnNavigatorVisible(turnCount: number, containerWidth: number): boolean {
  return turnCount >= TURN_NAVIGATOR_MIN_TURNS && containerWidth >= TURN_NAVIGATOR_MIN_CONTAINER_PX;
}

/** 首句截断：优先在句末标点处断（。！？!?；;\n），否则硬截；超出加省略号 */
export function truncateTurnTitle(text: string, max: number = TURN_TITLE_MAX_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  const sentenceEnd = trimmed.search(/[。！？!?；;\n]/);
  const head = sentenceEnd > 0 ? trimmed.slice(0, sentenceEnd) : trimmed;
  return head.length > max ? `${head.slice(0, max)}…` : head;
}

/**
 * 归组：ChatItem 流 → 轮次条目。turn-header 起新轮；轮标题取该轮第一条 user 消息文本
 * （首句截断）。marker / streaming / tool 等条目不参与归组；无 turnId 的条目跳过。
 */
export function deriveTurns(items: readonly ChatItem[]): TurnNavEntry[] {
  const turns: TurnNavEntry[] = [];
  const byId = new Map<string, TurnNavEntry>();
  for (const item of items) {
    if (item.kind === 'turn-header' && item.turnId !== undefined && item.turnId.length > 0) {
      if (!byId.has(item.turnId)) {
        const entry: TurnNavEntry = { turnId: item.turnId, index: turns.length + 1 };
        turns.push(entry);
        byId.set(item.turnId, entry);
      }
      continue;
    }
    if (item.kind === 'user' && item.turnId !== undefined && typeof item.text === 'string') {
      const entry = byId.get(item.turnId);
      if (entry !== undefined && entry.title === undefined && item.text.trim().length > 0) {
        const title = truncateTurnTitle(item.text);
        if (title.length > 0) entry.title = title;
      }
    }
  }
  return turns;
}

/** selector 字面量转义（turnId 是服务端字符串，进 querySelector 前转义） */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

/**
 * 点击定位：把滚动容器滚到该轮首行（turn-header 行，`[data-turn-id]`）。
 * 返回 false = 容器缺失 / 找不到该轮行（调用方不更新高亮）。
 */
export function jumpToTurn(container: HTMLElement | null, turnId: string): boolean {
  if (container === null) return false;
  const el = container.querySelector(`[data-turn-id="${cssEscape(turnId)}"]`);
  if (!(el instanceof HTMLElement)) return false;
  const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
  container.scrollTop = Math.max(0, top - TURN_NAV_TOP_INSET_PX);
  return true;
}

/**
 * 当前轮判定：按 DOM 顺序取「顶部越过内缩线」的最后一个轮首行（正在阅读的那一轮）。
 * 无任何行越过线（还在第一轮首屏上方）→ undefined（rail 无高亮）。
 */
export function activeTurnIdOf(container: HTMLElement | null): string | undefined {
  if (container === null) return undefined;
  const containerTop = container.getBoundingClientRect().top;
  let current: string | undefined;
  for (const el of container.querySelectorAll<HTMLElement>('[data-turn-id]')) {
    const turnId = el.getAttribute('data-turn-id');
    if (turnId === null || turnId.length === 0) continue;
    if (el.getBoundingClientRect().top - containerTop <= TURN_NAV_TOP_INSET_PX) current = turnId;
  }
  return current;
}

export interface TurnNavigatorProps {
  readonly turns: readonly TurnNavEntry[];
  readonly activeTurnId?: string | undefined;
  /** 点击定位回调（滚动与高亮由宿主接线：jumpToTurn + setActiveTurnId） */
  readonly onJump: (turnId: string) => void;
}

/**
 * 轮次导航 rail：垂直细条（视觉低饱：ZCode rail 细条风格）。
 * 轮次 <2 → 不渲染（JS 侧阈值）；容器 <864px → CSS @container 隐藏（见 shell.css .turn-rail）。
 */
export function TurnNavigator({ turns, activeTurnId, onJump }: TurnNavigatorProps): ReactNode {
  if (turns.length < TURN_NAVIGATOR_MIN_TURNS) return null;
  return (
    <nav data-testid="turn-rail" aria-label="轮次导航" className="turn-rail">
      {turns.map((turn) => {
        const active = turn.turnId === activeTurnId;
        return (
          <button
            key={turn.turnId}
            type="button"
            data-turn-nav={turn.turnId}
            aria-current={active ? 'true' : undefined}
            aria-label={`第 ${turn.index} 轮`}
            title={turn.title ?? `第 ${turn.index} 轮`}
            className={active ? 'turn-rail-item turn-rail-item-active' : 'turn-rail-item'}
            onClick={() => onJump(turn.turnId)}
          >
            <span className="tabular-nums">{turn.index}</span>
          </button>
        );
      })}
    </nav>
  );
}
