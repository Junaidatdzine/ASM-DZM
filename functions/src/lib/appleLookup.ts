import type { AppleDeviceFamily } from '@asm/shared';

/** Subset of an iTunes lookup result we care about. */
export interface LookupResult {
  kind?: string;
  features?: string[];
  supportedDevices?: string[];
  artworkUrl100?: string;
}

export interface PublicAppMeta {
  iconUrl: string | null;
  /** undefined = listing not found (unreleased) — keep whatever we knew before. */
  devices?: AppleDeviceFamily[];
}

/**
 * Map a public store listing to device families. Deliberately ignores
 * `MacDesktop` entries in supportedDevices — every iOS app that allows
 * Apple-Silicon installs lists them, and badging those as "Mac" would be noise;
 * a real Mac app reports kind `mac-software` (or ASC platform MAC_OS) instead.
 */
export function deriveDevices(result: LookupResult): AppleDeviceFamily[] {
  const out = new Set<AppleDeviceFamily>();
  if (result.kind === 'mac-software') out.add('mac');
  const devices = result.supportedDevices ?? [];
  if (devices.some((d) => d.startsWith('iPhone') || d.startsWith('iPod'))) out.add('iphone');
  if (devices.some((d) => d.startsWith('iPad'))) out.add('ipad');
  if (devices.some((d) => d.startsWith('AppleTV'))) out.add('appletv');
  if (devices.some((d) => d.startsWith('Watch'))) out.add('watch');
  if (devices.some((d) => d.startsWith('AppleVision') || d.startsWith('RealityDevice'))) out.add('vision');
  if (result.features?.includes('iosUniversal')) {
    out.add('iphone');
    out.add('ipad');
  }
  return [...out];
}

/**
 * Best-effort public metadata for a released app: icon + device families.
 * Returns nulls/undefined on any failure — callers must treat this as optional.
 */
export async function fetchPublicMeta(bundleId: string): Promise<PublicAppMeta> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(
      `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}`,
      { signal: ctrl.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return { iconUrl: null };
    const data = (await res.json()) as { results?: LookupResult[] };
    const first = data.results?.[0];
    if (!first) return { iconUrl: null };
    return {
      iconUrl: first.artworkUrl100?.replace('100x100', '256x256') ?? null,
      devices: deriveDevices(first),
    };
  } catch {
    return { iconUrl: null };
  }
}
