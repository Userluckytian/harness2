// Z-76 Input
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const inputVariants = cva(
  'flex w-full border border-input-border bg-input text-foreground text-ui-base transition-colors placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      size: {
        xs: 'h-5 rounded-sm px-2',
        sm: 'h-6 rounded-md',
        default: 'h-7 rounded-md px-2',
        lg: 'h-8 rounded-lg px-3',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

function Input({
  className,
  size,
  type = 'text',
  ...props
}: Omit<React.ComponentProps<'input'>, 'size'> & VariantProps<typeof inputVariants>) {
  return <input type={type} data-slot="input" className={cn(inputVariants({ size }), className)} {...props} />;
}

export { Input, inputVariants };
