// P0-2（Z-10）Context Menu —— 与 dropdown-menu.tsx 同一风格基线：
// 语义 token（bg-menu / data-[highlighted]:bg-menu-hover / text-ui-base）、
// 面板 `rounded-lg p-1 gap-0.5`、条目 min-h-7 rounded-md。
// 深路径导入（@radix-ui/react-context-menu 是 radix-ui 伞包的既有锁定依赖，零新增包）：
// 与 dropdown-menu/tooltip/slot 同一先例——伞包 barrel 会把 55 个子包拉进渲染图，
// 曾致 desktop 重型装配测试满载超时（issue-log §18），新原语一律走深路径。
import * as React from 'react';
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';

import { cn } from '@/lib/utils';

const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
const ContextMenuGroup = ContextMenuPrimitive.Group;
const ContextMenuPortal = ContextMenuPrimitive.Portal;

function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        className={cn(
          'z-[60] flex max-h-96 min-w-32 flex-col gap-0.5 overflow-auto rounded-lg border border-popover-border bg-menu p-1 shadow-md',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 duration-100',
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & { variant?: 'default' | 'destructive' }) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      className={cn(
        "relative flex min-h-7 items-center gap-2 rounded-md px-2 py-1 text-ui-base outline-none select-none data-[highlighted]:bg-menu-hover data-[disabled]:pointer-events-none data-[disabled]:text-foreground-subtlest [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        variant === 'destructive' && 'text-destructive',
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuLabel({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Label>) {
  return (
    <ContextMenuPrimitive.Label
      data-slot="context-menu-label"
      className={cn('px-2 py-1 text-ui-xs text-foreground-subtlest', className)}
      {...props}
    />
  );
}

function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn('my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuGroup,
  ContextMenuPortal,
};
