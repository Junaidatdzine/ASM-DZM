import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type Variant = 'neutral' | 'accent' | 'success' | 'warning' | 'destructive' | 'outline';

const variants: Record<Variant, string> = {
  neutral: 'bg-muted text-muted-foreground',
  accent: 'bg-accent text-accent-foreground',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/15 text-warning',
  destructive: 'bg-destructive/10 text-destructive',
  outline: 'border text-muted-foreground',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

export function Badge({ className, variant = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium',
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
