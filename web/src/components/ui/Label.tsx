import type { LabelHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('mb-1.5 block text-[13px] font-medium text-foreground', className)}
      {...props}
    />
  );
}

export function FieldHint({ className, children }: { className?: string; children: React.ReactNode }) {
  return <p className={cn('mt-1 text-xs text-muted-foreground', className)}>{children}</p>;
}
