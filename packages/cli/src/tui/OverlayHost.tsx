// OverlayHost：单一浮层容器（T3 位置规则：渲染在输入框上方区域）。
// - App 维护 activeOverlay 状态，渲染单一浮层；浮层开时 Composer 接收 active=false（useInput 互斥），
//   浮层自身 isActive=true，避免多组件同时监听键盘。Esc 关闭由各浮层组件自行回调实现。
// - 布局：作为「转录区之后、Composer 之前」的流式元素渲染（T2 锚底后即为输入框正上方），
//   高度 = 内容实际高度（有界；转录区让出等量行，输入框绝不被顶起）。
import React, { type ReactNode, type ReactElement } from 'react';
import { Box } from 'ink';

export interface OverlayHostProps {
  /** 当前激活浮层子树；null = 无浮层（焦点归 Composer） */
  children: ReactNode;
  /** 本浮层占用的行数（上层已测量并扣减转录视口；用于外层布局约束） */
  height?: number;
}

/** 浮层宿主：流式渲染在输入框上方（flexShrink 0：绝不压缩弹层挤占输入框） */
export function OverlayHost({ children, height }: OverlayHostProps): ReactElement | null {
  if (children === null || children === undefined) return null;
  return (
    <Box flexDirection="column" alignItems="center" flexShrink={0} height={height}>
      {children}
    </Box>
  );
}
