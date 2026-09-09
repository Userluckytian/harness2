// OverlayHost：任意时刻只开一个浮层容器。App 维护 activeOverlay 状态，渲染单一浮层；
// 浮层开时 Composer 接收 active=false（useInput isActive 互斥），浮层自身 isActive=true，
// 避免多组件同时监听键盘。Esc 关闭由各浮层组件自行回调实现。
import React, { type ReactNode, type ReactElement } from 'react';
import { Box } from 'ink';

export interface OverlayHostProps {
  /** 当前激活浮层子树；null = 无浮层（焦点归 Composer） */
  children: ReactNode;
}

/** 占满终端并居中的浮层宿主 */
export function OverlayHost({ children }: OverlayHostProps): ReactElement | null {
  if (children === null || children === undefined) return null;
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      {children}
    </Box>
  );
}
