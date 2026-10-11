// Z-75 Button
import * as React from 'react';
import * as Slot from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent text-ui-base transition-colors disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground',
        outline: 'border-border hover:border-border-hover hover:bg-hover',
        secondary: 'bg-secondary',
        ghost: 'text-foreground-subtle hover:bg-hover hover:text-foreground',
        destructive: 'bg-destructive text-destructive-foreground',
        warning: 'bg-warning text-warning-foreground',
        link: 'text-interaction-ask-foreground underline underline-offset-2',
      },
      size: {
        default: 'h-7 px-2',
        xs: 'h-5 rounded-sm px-2 text-ui-sm',
        sm: 'h-6 px-2 text-ui-sm',
        lg: 'h-8 rounded-lg px-2.5',
        icon: 'size-7',
        'icon-xs': 'size-5',
        'icon-sm': 'size-6',
        'icon-md': 'size-7',
        'icon-lg': 'size-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
