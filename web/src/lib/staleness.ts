import { useEffect, useRef } from 'react';
import type { TS } from '@asm/shared';

export const STALE_APPS_LIST_MS = 12 * 3600 * 1000;
export const STALE_APP_DEEP_MS = 30 * 60 * 1000;
export const STALE_SCREENSHOTS_MS = 15 * 60 * 1000;

export function isStale(ts: TS | null | undefined, maxAgeMs: number): boolean {
  if (!ts || typeof ts.toMillis !== 'function') return true;
  return Date.now() - ts.toMillis() > maxAgeMs;
}

/**
 * Fire a background refresh at most once per mount when data is stale.
 * The UI keeps rendering cached data; listeners pick up the sync results.
 */
export function useAutoSync(key: string | null, stale: boolean, run: () => Promise<unknown>) {
  const fired = useRef<string | null>(null);
  useEffect(() => {
    if (!key || !stale || fired.current === key) return;
    fired.current = key;
    run().catch(() => {
      // Background refresh — errors surface via the Activity feed, not toasts.
    });
  }, [key, stale, run]);
}
