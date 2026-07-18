/** Per-store accent colors + icon symbols for instant visual identification. */

export interface StoreColor {
  key: string;
  label: string;
}

/** Palette keys — mapped to concrete CSS in the web app (light + dark tuned). */
export const STORE_COLORS: StoreColor[] = [
  { key: 'indigo', label: 'Indigo' },
  { key: 'emerald', label: 'Emerald' },
  { key: 'amber', label: 'Amber' },
  { key: 'rose', label: 'Rose' },
  { key: 'sky', label: 'Sky' },
  { key: 'violet', label: 'Violet' },
  { key: 'teal', label: 'Teal' },
  { key: 'orange', label: 'Orange' },
  { key: 'pink', label: 'Pink' },
  { key: 'lime', label: 'Lime' },
];

/** Curated lucide icon names selectable per store. */
export const STORE_ICONS = [
  'store',
  'rocket',
  'sparkles',
  'gamepad-2',
  'music',
  'camera',
  'heart-pulse',
  'graduation-cap',
  'briefcase',
  'shopping-bag',
  'globe',
  'zap',
  'leaf',
  'flame',
  'diamond',
  'crown',
] as const;

export type StoreIcon = (typeof STORE_ICONS)[number];

export const DEFAULT_STORE_ICON: StoreIcon = 'store';

/** Deterministic default color/icon from an id, so unassigned stores still look distinct. */
export function defaultStoreColor(seed: string): string {
  return STORE_COLORS[hashString(seed) % STORE_COLORS.length]!.key;
}

export function defaultAppColor(seed: string): string {
  return STORE_COLORS[hashString(seed + 'app') % STORE_COLORS.length]!.key;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function isStoreColor(key: string | undefined | null): key is string {
  return !!key && STORE_COLORS.some((c) => c.key === key);
}

// ---- Unique colors beyond the 10-key palette ----
// With 60+ stores a fixed palette must repeat, so stores can also carry an
// arbitrary `#rrggbb` color. New colors are picked to be maximally distant
// (in hue) from every color already in use; a one-shot recolor spreads ALL
// stores evenly around the wheel so no two are the same or similar.

export function isHexColor(v: string | undefined | null): v is string {
  return !!v && /^#[0-9a-fA-F]{6}$/.test(v);
}

/** Approximate hue of each palette key (matches the web CSS). */
export const PALETTE_HUES: Record<string, number> = {
  indigo: 239, emerald: 152, amber: 43, rose: 350, sky: 199,
  violet: 258, teal: 173, orange: 25, pink: 330, lime: 84,
};

export function hexToHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}

/** Hue of any store color value (palette key or hex); null when unknown. */
export function colorHue(color: string | undefined | null): number | null {
  if (!color) return null;
  if (isHexColor(color)) return hexToHue(color);
  return PALETTE_HUES[color] ?? null;
}

export function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to255 = (x: number) => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${to255(f(0))}${to255(f(8))}${to255(f(4))}`;
}

const circularDistance = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Two colors read as "similar" below this hue distance. */
export const SIMILAR_HUE_DEGREES = 18;

/** Vivid, dark-and-light-friendly band the generated colors live in. */
const GEN_SATURATION = 72;
const GEN_LIGHTNESS = 50;

/**
 * Pick a new color maximally distant (min circular hue distance) from every
 * color in use. Scans golden-angle candidates so successive picks stay spread.
 */
export function nextDistinctColor(existingColors: Array<string | undefined | null>): string {
  const used = existingColors.map(colorHue).filter((h): h is number => h !== null);
  if (used.length === 0) return hslToHex(222, GEN_SATURATION, GEN_LIGHTNESS);
  let best = 0;
  let bestScore = -1;
  for (let k = 0; k < 90; k++) {
    const hue = Math.round((k * 137.508 + 7) % 360);
    const score = Math.min(...used.map((u) => circularDistance(hue, u)));
    if (score > bestScore) {
      bestScore = score;
      best = hue;
    }
  }
  return hslToHex(best, GEN_SATURATION, GEN_LIGHTNESS);
}

/**
 * True when a recolor would help: any two colors are the same or similar in
 * hue, or any store has no explicit color at all (seed fallbacks can collide).
 */
export function hasSimilarColors(colors: Array<string | undefined | null>): boolean {
  if (colors.length < 2) return false;
  if (colors.some((c) => !c)) return true;
  const hues = colors.map(colorHue);
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      const a = hues[i];
      const b = hues[j];
      if (a === null || b === null) continue;
      if (circularDistance(a!, b!) < SIMILAR_HUE_DEGREES) return true;
    }
  }
  return false;
}

/**
 * Evenly spread N colors around the hue wheel (maximal pairwise separation),
 * alternating lightness bands so even neighbours read differently.
 */
export function assignDistinctColors(count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const hue = Math.round((i * 360) / Math.max(count, 1) + 7) % 360;
    const light = i % 2 === 0 ? GEN_LIGHTNESS : GEN_LIGHTNESS - 8;
    out.push(hslToHex(hue, GEN_SATURATION, light));
  }
  return out;
}
