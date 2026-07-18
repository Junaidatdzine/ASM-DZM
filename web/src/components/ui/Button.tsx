import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'outline' | 'ghost' | 'destructive' | 'link';
type Size = 'sm' | 'md' | 'lg' | 'icon' | 'iconSm';

const variants: Record<Variant, string> = {
  primary:
    'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 active:bg-primary/95',
  outline:
    'border bg-card text-foreground shadow-sm hover:bg-muted active:bg-muted/70',
  ghost: 'text-foreground hover:bg-muted active:bg-muted/70',
  destructive:
    'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
  link: 'text-primary underline-offset-4 hover:underline',
};

const sizes: Record<Size, string> = {
  sm: 'h-7 rounded-md px-2.5 text-[13px] gap-1.5',
  md: 'h-8.5 rounded-lg px-3.5 text-sm gap-2',
  lg: 'h-10 rounded-lg px-5 text-sm gap-2',
  icon: 'h-8.5 w-8.5 rounded-lg',
  iconSm: 'h-7 w-7 rounded-md',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', loading, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-colors',
        'disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      <span className={cn('contents', loading && '[&>svg]:hidden [&_.animate-spin]:hidden')}>
        {children}
      </span>
    </button>
  );
});
