// Z-79 Switch
import * as React from 'react';
import { Switch as SwitchPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

// Z-79 Switch：default 轨道 h-[18px] w-[32px] + thumb size-4；sm 轨道 h-4 w-7 + thumb size-3.5
// 平移量按「轨道宽 − thumb 宽 − 2×1px 内缩」推算，保证两端都留 1px。
const switchTrackSize = {
  default: 'h-[18px] w-[32px]',
  sm: 'h-4 w-7',
} as const;

const switchThumbSize = {
  default: 'size-4 data-[state=unchecked]:translate-x-px data-[state=checked]:translate-x-[15px]',
  sm: 'size-3.5 data-[state=unchecked]:translate-x-px data-[state=checked]:translate-x-[13px]',
} as const;

function Switch({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: 'default' | 'sm';
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full bg-primary/30 transition-colors data-[state=checked]:bg-primary focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45',
        switchTrackSize[size],
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn('block rounded-full bg-background transition-transform', switchThumbSize[size])}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
