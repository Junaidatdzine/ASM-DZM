import { useState } from 'react';
import { cn, initials } from '@/lib/utils';

export function Avatar({
  src,
  name,
  seed,
  className,
}: {
  src?: string | null;
  name: string;
  seed?: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const hue = [...(seed ?? name)].reduce((value, char) => (value * 31 + char.charCodeAt(0)) % 360, 0);
  const generated = !src || broken;
  return (
    <div
      className={cn(
        'flex size-7 shrink-0 select-none items-center justify-center overflow-hidden rounded-full',
        'bg-accent text-[11px] font-semibold text-accent-foreground',
        className,
      )}
      style={generated ? { backgroundColor: `hsl(${hue} 72% 90%)`, color: `hsl(${hue} 62% 28%)` } : undefined}
    >
      {src && !broken ? (
        <img
          src={src}
          alt={name}
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        initials(name || '?')
      )}
    </div>
  );
}
