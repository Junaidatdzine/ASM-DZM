/** Best-effort IP → location for the admin "where did they log in from" view. */

export interface GeoInfo {
  countryCode?: string;
  country?: string;
  city?: string;
}

const cache = new Map<string, GeoInfo>();

function isPrivate(ip: string): boolean {
  return (
    ip === '' ||
    ip === '::1' ||
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('172.16.') ||
    ip.startsWith('fc') ||
    ip.startsWith('fe80')
  );
}

export async function lookupGeo(ip: string | undefined): Promise<GeoInfo> {
  if (!ip || isPrivate(ip)) return {};
  const hit = cache.get(ip);
  if (hit) return hit;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return {};
    const data = (await res.json()) as { success?: boolean; country_code?: string; country?: string; city?: string };
    if (data.success === false) return {};
    const info: GeoInfo = {
      ...(data.country_code ? { countryCode: data.country_code } : {}),
      ...(data.country ? { country: data.country } : {}),
      ...(data.city ? { city: data.city } : {}),
    };
    cache.set(ip, info);
    return info;
  } catch {
    return {};
  }
}
