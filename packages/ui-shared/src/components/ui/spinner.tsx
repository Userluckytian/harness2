// Z-79 Spinner
import * as React from 'react';
import { LoaderIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

function Spinner({
  className,
  loadingLabel = '加载中',
  ...props
}: Omit<React.ComponentProps<typeof LoaderIcon>, 'aria-label'> & {
  loadingLabel?: string;
}) {
  return (
    <LoaderIcon
      data-slot="spinner"
      role="status"
      aria-label={loadingLabel}
      className={cn('size-4 animate-spin', className)}
      {...props}
    />
  );
}

export { Spinner };
