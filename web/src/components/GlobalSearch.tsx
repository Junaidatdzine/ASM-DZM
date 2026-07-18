import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AppWindow, Search, Store as StoreIcon } from 'lucide-react';
import { api, type OverviewRow } from '@/lib/callables';
import { useMyStores } from '@/features/stores/StoresPage';
import { AppGlyph, StoreDot, StoreGlyph } from '@/components/StoreGlyph';
import { PlatformBadges } from '@/components/PlatformBadges';
import { cn } from '@/lib/utils';

interface AppHit {
  storeId: string;
  storeName: string;
  storeColor: string | null;
  appId: string;
  appName: string;
  iconUrl: string | null;
  platforms: string[];
  devices: string[] | null;
}

/**
 * Top-bar search across every store and app the user can see.
 * Stores come from the live query; the app index piggybacks on appsOverview
 * (already cached for the dashboard cards) — no extra backend needed.
 */
export function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const stores = useMyStores();

  const overview = useQuery({
    queryKey: ['apps-overview'],
    queryFn: () => api.appsOverview({}),
    staleTime: 5 * 60_000,
    enabled: open, // fetch lazily the first time the search is used
  });

  // ⌘K / Ctrl-K focuses the search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const needle = q.trim().toLowerCase();

  const storeHits = useMemo(() => {
    if (!needle) return [];
    return stores.rows
      .filter((s) => s.data.name.toLowerCase().includes(needle))
      .slice(0, 5);
  }, [stores.rows, needle]);

  const appHits = useMemo<AppHit[]>(() => {
    if (!needle) return [];
    const seen = new Map<string, AppHit>();
    for (const row of (overview.data?.rows ?? []) as OverviewRow[]) {
      if (!row.appName.toLowerCase().includes(needle)) continue;
      const key = `${row.storeId}/${row.appId}`;
      if (!seen.has(key)) {
        seen.set(key, {
          storeId: row.storeId,
          storeName: row.storeName,
          storeColor: row.storeColor,
          appId: row.appId,
          appName: row.appName,
          iconUrl: row.iconUrl,
          platforms: row.platforms ?? [],
          devices: row.devices ?? null,
        });
      }
    }
    return [...seen.values()].slice(0, 8);
  }, [overview.data, needle]);

  const flat = useMemo(
    () => [
      ...storeHits.map((s) => ({ type: 'store' as const, to: `/stores/${s.id}`, key: s.id })),
      ...appHits.map((a) => ({ type: 'app' as const, to: `/stores/${a.storeId}/apps/${a.appId}`, key: `${a.storeId}/${a.appId}` })),
    ],
    [storeHits, appHits],
  );

  useEffect(() => setActive(0), [needle]);

  const go = (to: string) => {
    setOpen(false);
    setQ('');
    navigate(to);
  };

  const showPanel = open && needle.length > 0;

  return (
    <div ref={wrap} className="relative min-w-0 max-w-md flex-1">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={input}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            input.current?.blur();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, flat.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' && flat[active]) {
            go(flat[active]!.to);
          }
        }}
        placeholder="Search stores & apps…  ⌘K"
        className="h-8.5 w-full rounded-lg border bg-muted/40 pl-8 pr-3 text-[13px] outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:bg-card"
      />
      {showPanel && (
        <div className="absolute left-0 right-0 top-10 z-50 max-h-96 overflow-y-auto rounded-xl border bg-card p-1.5 shadow-pop">
          {storeHits.length === 0 && appHits.length === 0 ? (
            <p className="px-3 py-4 text-center text-[13px] text-muted-foreground">
              {overview.isLoading ? 'Loading the app index…' : `Nothing matches “${q.trim()}”.`}
            </p>
          ) : (
            <>
              {storeHits.length > 0 && (
                <>
                  <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <StoreIcon className="size-3" /> Stores
                  </div>
                  {storeHits.map((s, i) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => go(`/stores/${s.id}`)}
                      onMouseEnter={() => setActive(i)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left',
                        active === i ? 'bg-muted' : 'hover:bg-muted/60',
                      )}
                    >
                      <StoreGlyph color={s.data.color} icon={s.data.icon} seed={s.id} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{s.data.name}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{s.data.appsCount ?? 0} apps</span>
                    </button>
                  ))}
                </>
              )}
              {appHits.length > 0 && (
                <>
                  <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <AppWindow className="size-3" /> Apps
                  </div>
                  {appHits.map((a, i) => {
                    const idx = storeHits.length + i;
                    return (
                      <button
                        key={`${a.storeId}/${a.appId}`}
                        type="button"
                        onClick={() => go(`/stores/${a.storeId}/apps/${a.appId}`)}
                        onMouseEnter={() => setActive(idx)}
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left',
                          active === idx ? 'bg-muted' : 'hover:bg-muted/60',
                        )}
                      >
                        <AppGlyph name={a.appName} iconUrl={a.iconUrl} seed={a.appId} size="sm" className="rounded-[22%]" />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{a.appName}</span>
                        <PlatformBadges platforms={a.platforms as never} devices={a.devices as never} className="shrink-0" />
                        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                          <StoreDot color={a.storeColor ?? undefined} seed={a.storeId} />
                          {a.storeName}
                        </span>
                      </button>
                    );
                  })}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
