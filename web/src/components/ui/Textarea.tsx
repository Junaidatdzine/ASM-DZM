import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          'w-full rounded-lg border border-input bg-card px-3 py-2 text-sm shadow-sm transition-colors',
          'placeholder:text-muted-foreground/70',
          'focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-ring/30',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
        {...props}
      />
    );
  },
);

/** Live n/max counter for metadata fields; turns destructive when over limit. */
export function CharCounter({ value, max, className }: { value: string; max: number; className?: string }) {
  const over = value.length > max;
  return (
    <span
      className={cn(
        'tabular-nums text-[11px]',
        over ? 'font-semibold text-destructive' : 'text-muted-foreground/80',
        className,
      )}
    >
      {value.length}/{max}
    </span>
  );
}
