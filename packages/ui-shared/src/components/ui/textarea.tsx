// Z-76 Textarea
import * as React from 'react';

import { cn } from '@/lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'field-sizing-content min-h-16 w-full rounded-md border border-input-border bg-input/20 px-2 py-2 text-ui-base transition-colors placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
