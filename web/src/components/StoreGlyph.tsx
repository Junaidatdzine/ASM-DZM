import {
  Store,
  Rocket,
  Sparkles,
  Gamepad2,
  Music,
  Camera,
  HeartPulse,
  GraduationCap,
  Briefcase,
  ShoppingBag,
  Globe,
  Zap,
  Leaf,
  Flame,
  Diamond,
  Crown,
  type LucideIcon,
} from 'lucide-react';
import { defaultStoreColor, isHexColor } from '@asm/shared';
import { cn } from '@/lib/utils';

/** Palette key → tailwind classes (tuned for light + dark). */
export const STORE_COLOR_CLASSES: Record<string, { tile: string; dot: string; soft: string; text: string }> = {
  indigo: { tile: 'bg-indigo-500 text-white', dot: 'bg-indigo-500', soft: 'bg-indigo-500/12', text: 'text-indigo-600 dark:text-indigo-400' },
  emerald: { tile: 'bg-emerald-500 text-white', dot: 'bg-emerald-500', soft: 'bg-emerald-500/12', text: 'text-emerald-600 dark:text-emerald-400' },
  amber: { tile: 'bg-amber-500 text-white', dot: 'bg-amber-500', soft: 'bg-amber-500/12', text: 'text-amber-600 dark:text-amber-400' },
  rose: { tile: 'bg-rose-500 text-white', dot: 'bg-rose-500', soft: 'bg-rose-500/12', text: 'text-rose-600 dark:text-rose-400' },
  sky: { tile: 'bg-sky-500 text-white', dot: 'bg-sky-500', soft: 'bg-sky-500/12', text: 'text-sky-600 dark:text-sky-400' },
  violet: { tile: 'bg-violet-500 text-white', dot: 'bg-violet-500', soft: 'bg-violet-500/12', text: 'text-violet-600 dark:text-violet-400' },
  teal: { tile: 'bg-teal-500 text-white', dot: 'bg-teal-500', soft: 'bg-teal-500/12', text: 'text-teal-600 dark:text-teal-400' },
  orange: { tile: 'bg-orange-500 text-white', dot: 'bg-orange-500', soft: 'bg-orange-500/12', text: 'text-orange-600 dark:text-orange-400' },
  pink: { tile: 'bg-pink-500 text-white', dot: 'bg-pink-500', soft: 'bg-pink-500/12', text: 'text-pink-600 dark:text-pink-400' },
  lime: { tile: 'bg-lime-500 text-white', dot: 'bg-lime-500', soft: 'bg-lime-500/12', text: 'text-lime-600 dark:text-lime-400' },
};

export const STORE_ICON_MAP: Record<string, LucideIcon> = {
  store: Store,
  rocket: Rocket,
  sparkles: Sparkles,
  'gamepad-2': Gamepad2,
  music: Music,
  camera: Camera,
  'heart-pulse': HeartPulse,
  'graduation-cap': GraduationCap,
  briefcase: Briefcase,
  'shopping-bag': ShoppingBag,
  globe: Globe,
  zap: Zap,
  leaf: Leaf,
  flame: Flame,
  diamond: Diamond,
  crown: Crown,
};

export function storeColorClasses(color: string | undefined, seed = '') {
  return STORE_COLOR_CLASSES[color ?? ''] ?? STORE_COLOR_CLASSES[defaultStoreColor(seed)]!;
}

/**
 * Tile visual for any store color: palette keys map to tailwind classes,
 * generated `#rrggbb` colors (unique-per-store) render as inline styles.
 */
export function storeTileVisual(
  color: string | undefined,
  seed = '',
): { className: string; style?: React.CSSProperties } {
  if (isHexColor(color)) return { className: 'text-white', style: { backgroundColor: color } };
  return { className: storeColorClasses(color, seed).tile };
}

const sizes = { sm: 'size-6 rounded-md', md: 'size-8 rounded-lg', lg: 'size-10 rounded-xl' };
const iconSizes = { sm: 'size-3.5', md: 'size-4', lg: 'size-5' };

/** Colored tile with the store's chosen icon — the store's visual identity. */
export function StoreGlyph({
  color,
  icon,
  seed = '',
  size = 'md',
  className,
}: {
  color?: string;
  icon?: string;
  seed?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const Icon = STORE_ICON_MAP[icon ?? 'store'] ?? Store;
  const visual = storeTileVisual(color, seed);
  return (
    <div
      className={cn('flex shrink-0 items-center justify-center shadow-sm', sizes[size], visual.className, className)}
      style={visual.style}
    >
      <Icon className={iconSizes[size]} />
    </div>
  );
}

/** Small colored dot for inline store identification (activity, audit, breadcrumbs). */
export function StoreDot({ color, seed = '', className }: { color?: string; seed?: string; className?: string }) {
  if (isHexColor(color)) {
    return <span className={cn('inline-block size-2 shrink-0 rounded-full', className)} style={{ backgroundColor: color }} />;
  }
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', storeColorClasses(color, seed).dot, className)} />;
}

/** Deterministic app monogram tile (colored by app id). */
export function AppGlyph({
  name,
  iconUrl,
  seed,
  color,
  size = 'lg',
  className,
}: {
  name: string;
  iconUrl?: string | null;
  seed: string;
  color?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  if (iconUrl) {
    return <img src={iconUrl} alt="" className={cn(sizes[size], 'border object-cover', className)} />;
  }
  const classes = storeColorClasses(color, seed);
  return (
    <div className={cn('flex shrink-0 items-center justify-center font-bold', sizes[size], classes.tile, className)}>
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}
