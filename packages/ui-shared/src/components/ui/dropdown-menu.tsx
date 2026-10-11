// Z-78 DropdownMenu
import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
const DropdownMenuSub = DropdownMenuPrimitive.Sub;
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

const dropdownMenuItemVariants = cva(
  "relative flex min-h-7 items-center gap-2 rounded-md px-2 py-1 text-ui-base outline-none select-none data-[highlighted]:bg-menu-hover data-[disabled]:pointer-events-none data-[disabled]:text-foreground-subtlest [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: '',
        destructive: 'text-destructive',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          'z-[60] flex max-h-96 min-w-32 flex-col gap-0.5 overflow-auto rounded-lg border border-popover-border bg-menu p-1 shadow-md',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 duration-100',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & VariantProps<typeof dropdownMenuItemVariants>) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(dropdownMenuItemVariants({ variant }), className)}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      checked={checked}
      className={cn(dropdownMenuItemVariants(), 'pr-2 pl-7', className)}
      {...props}
    >
      <span
        data-slot="dropdown-menu-checkbox-item-indicator"
        className="absolute left-2 flex size-4 items-center justify-center"
      >
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(dropdownMenuItemVariants(), 'pr-2 pl-7', className)}
      {...props}
    >
      <span
        data-slot="dropdown-menu-radio-item-indicator"
        className="absolute left-2 flex size-4 items-center justify-center"
      >
        <DropdownMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn('px-2 py-1 text-ui-xs text-foreground-subtlest', className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(dropdownMenuItemVariants(), 'data-[state=open]:bg-menu-hover', className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        'z-[60] flex max-h-96 min-w-32 flex-col gap-0.5 overflow-auto rounded-lg border border-popover-border bg-menu p-1 shadow-md',
        'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 duration-100',
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  dropdownMenuItemVariants,
};
