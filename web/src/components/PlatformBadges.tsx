import type { LucideIcon } from 'lucide-react';
import { Glasses, Monitor, Smartphone, Tablet, Tv, Watch } from 'lucide-react';
import type { AppleDeviceFamily, Platform } from '@asm/shared';

const SPECS: Record<AppleDeviceFamily, { label: string; icon: LucideIcon }> = {
  iphone: { label: 'iPhone', icon: Smartphone },
  ipad: { label: 'iPad', icon: Tablet },
  mac: { label: 'Mac', icon: Monitor },
  appletv: { label: 'TV', icon: Tv },
  watch: { label: 'Watch', icon: Watch },
  vision: { label: 'Vision', icon: Glasses },
};

const ORDER: AppleDeviceFamily[] = ['iphone', 'ipad', 'mac', 'appletv', 'watch', 'vision'];

/**
 * Merge ASC platforms (authoritative, always present) with the public listing's
 * device families (finer: iPhone vs iPad, released apps only) into badge keys.
 */
export function deviceBadges(
  platforms: Platform[] | undefined,
  devices: AppleDeviceFamily[] | undefined,
): { key: AppleDeviceFamily | 'ios'; label: string; icon: LucideIcon }[] {
  const set = new Set<AppleDeviceFamily>(devices ?? []);
  for (const p of platforms ?? []) {
    if (p === 'MAC_OS') set.add('mac');
    if (p === 'TV_OS') set.add('appletv');
    if (p === 'VISION_OS') set.add('vision');
  }
  const out = ORDER.filter((d) => set.has(d)).map((d) => ({ key: d as AppleDeviceFamily | 'ios', ...SPECS[d] }));
  // iOS app whose listing we can't read yet (unreleased): show a generic iOS badge.
  if ((platforms ?? []).includes('IOS') && !set.has('iphone') && !set.has('ipad')) {
    out.unshift({ key: 'ios', label: 'iOS', icon: Smartphone });
  }
  return out;
}

export function PlatformBadges({
  platforms,
  devices,
  className = '',
}: {
  platforms: Platform[] | undefined;
  devices: AppleDeviceFamily[] | undefined;
  className?: string;
}) {
  const badges = deviceBadges(platforms, devices);
  if (badges.length === 0) return null;
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${className}`}>
      {badges.map(({ key, label, icon: Icon }) => (
        <span
          key={key}
          title={`Available on ${label}`}
          className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          <Icon className="size-3" />
          {label}
        </span>
      ))}
    </span>
  );
}
