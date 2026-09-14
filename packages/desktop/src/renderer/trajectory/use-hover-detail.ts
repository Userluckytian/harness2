// 悬停详情（D-43：悬停 500ms 出详情）。
//
// 拆成两个状态：`hoveredKey`（立即，用于高亮）与 `revealedKey`（延时到点后才出详情卡）。
// 延时是**要求的行为**（不是性能优化），因此用固定常量并在测试里用假时钟验证：
// 499ms 不出、500ms 出、移出即取消（不残留上一段的详情）。
import { useCallback, useEffect, useRef, useState } from 'react';

/** 详情揭示延时（D-43 原文：500ms） */
export const HOVER_DETAIL_DELAY_MS = 500;

export interface HoverDetail {
  readonly hoveredKey: string | null;
  readonly revealedKey: string | null;
  readonly hover: (key: string) => void;
  readonly leave: () => void;
}

export function useHoverDetail(delayMs: number = HOVER_DETAIL_DELAY_MS): HoverDetail {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const hover = useCallback(
    (key: string) => {
      clearTimer();
      setHoveredKey(key);
      setRevealedKey(null);
      timer.current = setTimeout(() => {
        timer.current = null;
        setRevealedKey(key);
      }, delayMs);
    },
    [clearTimer, delayMs],
  );

  const leave = useCallback(() => {
    clearTimer();
    setHoveredKey(null);
    setRevealedKey(null);
  }, [clearTimer]);

  // 卸载清理：离开页面时不留挂起的定时器（否则卸载后 setState 会报警告）
  useEffect(() => clearTimer, [clearTimer]);

  return { hoveredKey, revealedKey, hover, leave };
}
