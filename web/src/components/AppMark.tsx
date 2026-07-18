import { cn } from '@/lib/utils';

/** Dzinemedia faceted "D" mark (inline so it renders instantly, before assets load). */
export function DzineMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden="true">
      <g stroke="#ffffff" strokeWidth="3" strokeLinejoin="round">
        <polygon points="256,56 429,156 256,144" fill="#F7941D" />
        <polygon points="256,144 429,156 353,200" fill="#F15A22" />
        <polygon points="429,156 429,356 353,200" fill="#EE1C25" />
        <polygon points="353,200 429,356 353,312" fill="#BE1E2D" />
        <polygon points="429,356 256,456 353,312" fill="#EC008C" />
        <polygon points="353,312 256,456 256,368" fill="#A3238E" />
        <polygon points="256,456 83,356 256,368" fill="#662D91" />
        <polygon points="256,368 83,356 159,312" fill="#21409A" />
        <polygon points="83,356 83,156 159,312" fill="#1C75BC" />
        <polygon points="159,312 83,156 159,200" fill="#27AAE1" />
        <polygon points="83,156 256,56 159,200" fill="#00A79D" />
        <polygon points="159,200 256,56 256,144" fill="#8DC63F" />
      </g>
    </svg>
  );
}

/** Product wordmark. `hero` = big stacked splash (logo above, name below). */
export function AppMark({
  className,
  compact,
  hero,
}: {
  className?: string;
  compact?: boolean;
  hero?: boolean;
}) {
  if (hero) {
    return (
      <div className={cn('flex flex-col items-center gap-3', className)}>
        <div className="flex size-24 items-center justify-center rounded-3xl bg-card shadow-card ring-1 ring-border">
          <DzineMark className="size-[70px]" />
        </div>
        <div className="text-center leading-tight">
          <div className="text-[22px] font-bold tracking-tight">Dzinemedia ASM</div>
          <div className="mt-1 text-[12px] text-muted-foreground">App Store operations</div>
        </div>
      </div>
    );
  }
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <div className="flex size-8 items-center justify-center rounded-lg bg-card shadow-sm ring-1 ring-border">
        <DzineMark className="size-6" />
      </div>
      {!compact && (
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight">Dzinemedia ASM</div>
          <div className="text-[11px] text-muted-foreground">App Store operations</div>
        </div>
      )}
    </div>
  );
}
