// Z-78 Tooltip
import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { cn } from '@/lib/utils';

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
  className,
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-[60] max-w-xs rounded-lg border border-border bg-tooltip px-3 py-1.5 text-ui-sm text-tooltip-foreground shadow-md',
          'data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-100',
          'data-[side=bottom]:data-[state=delayed-open]:slide-in-from-top-0.5 data-[side=top]:data-[state=delayed-open]:slide-in-from-bottom-0.5 data-[side=left]:data-[state=delayed-open]:slide-in-from-right-0.5 data-[side=right]:data-[state=delayed-open]:slide-in-from-left-0.5',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent };
