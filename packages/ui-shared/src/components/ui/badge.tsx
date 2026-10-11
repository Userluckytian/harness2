// Z-77 Badge
import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex h-5 items-center gap-1 rounded-full px-2 py-0.5 text-ui-xs font-medium [&>svg]:pointer-events-none [&>svg]:size-2.5',
  {
    variants: {
      variant: {
        default: 'bg-surface text-foreground-subtle',
        secondary: 'bg-secondary',
        destructive: 'bg-destructive text-destructive-foreground',
        outline: 'border border-border bg-transparent text-foreground-subtle',
        ghost: 'text-foreground-subtle hover:bg-hover',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'span';

  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
