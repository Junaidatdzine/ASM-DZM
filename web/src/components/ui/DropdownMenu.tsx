import * as Dropdown from '@radix-ui/react-dropdown-menu';
import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/utils';

export const DropdownMenu = Dropdown.Root;
export const DropdownMenuTrigger = Dropdown.Trigger;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentPropsWithoutRef<typeof Dropdown.Content>) {
  return (
    <Dropdown.Portal>
      <Dropdown.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-44 overflow-hidden rounded-lg border bg-popover p-1 shadow-pop data-[state=open]:animate-in',
          className,
        )}
        {...props}
      />
    </Dropdown.Portal>
  );
}

export function DropdownMenuItem({
  className,
  destructive,
  ...props
}: ComponentPropsWithoutRef<typeof Dropdown.Item> & { destructive?: boolean }) {
  return (
    <Dropdown.Item
      className={cn(
        'flex cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] outline-none transition-colors',
        destructive
          ? 'text-destructive data-[highlighted]:bg-destructive/10'
          : 'data-[highlighted]:bg-muted',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentPropsWithoutRef<typeof Dropdown.Label>) {
  return <Dropdown.Label className={cn('px-2.5 py-1.5 text-xs text-muted-foreground', className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentPropsWithoutRef<typeof Dropdown.Separator>) {
  return <Dropdown.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}
