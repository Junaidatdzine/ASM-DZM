import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-8.5 w-full rounded-lg border border-input bg-card px-3 text-sm shadow-sm transition-colors',
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
