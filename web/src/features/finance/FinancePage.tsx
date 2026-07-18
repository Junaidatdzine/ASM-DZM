import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { collection, doc, limit, orderBy, query } from 'firebase/firestore';
import { ArrowLeft, Banknote, Download, LineChart, Package, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import type { AppDoc, FinanceDayDoc, StoreDoc } from '@asm/shared';
import { can, isAdminUser } from '@asm/shared';
import { db } from '@/lib/firebase';
import { useSession } from '@/auth/AuthProvider';
import { api, callableMessage } from '@/lib/callables';
import { useLiveDoc, useLiveQuery } from '@/lib/hooks';
import { isStale, useAutoSync } from '@/lib/staleness';
import { AppGlyph, StoreGlyph } from '@/components/StoreGlyph';
import { PlatformBadges } from '@/components/PlatformBadges';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn, timeAgo } from '@/lib/utils';

const RANGES = [
  { key: '1', label: 'Latest day' },
  { key: '7', label: '7 days' },
  { key: '30', label: '30 days' },
  { key: '90', label: '90 days' },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

function fmtMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: amount >= 1000 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function fmtCount(n: number): string {
  return new Intl.NumberFormat().format(n);
}

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  explain,
}: {
  icon: typeof Banknote;
  label: string;
  value: string;
  sub?: string;
  explain?: string;
}) {
  return (
    <div title={explain} className="rounded-xl border bg-card p-4 shadow-card">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className="mt-1 truncate text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function FinancePage() {
  const { sid } = useParams<{ sid: string }>();
  const { user } = useSession();
  // Admins always; members need the explicit viewFinance grant for this store.
  const allowed = !!user && !!sid && (isAdminUser(user) || can(user, 'viewFinance', sid));
  const store = useLiveDoc<StoreDoc>(sid && allowed ? doc(db, 'stores', sid) : null);
  const daysQ = useLiveQuery<FinanceDayDoc>(
    useMemo(
      () => (sid && allowed ? query(collection(db, 'stores', sid, 'financeDays'), orderBy('date', 'desc'), limit(90)) : null),
      [sid, allowed],
    ),
    `finance-${sid}`,
  );
  const appsQ = useLiveQuery<AppDoc>(
    useMemo(() => (sid && allowed ? query(collection(db, 'stores', sid, 'apps')) : null), [sid, allowed]),
    `finance-apps-${sid}`,
  );
  const appNames = useMemo(() => new Map(appsQ.rows.map((a) => [a.id, a.data])), [appsQ.rows]);

  const [range, setRange] = useState<RangeKey>('7');
  const [syncing, setSyncing] = useState(false);

  const canFinance = !!store.data && (store.data.mock || !!store.data.vendorNumber);

  const runSync = useCallback(async () => {
    if (!sid) return;
    setSyncing(true);
    try {
      await api.financeSync({ storeId: sid, days: 90 });
    } catch (err) {
      toast.error('Finance sync failed', { description: callableMessage(err) });
    } finally {
      setSyncing(false);
    }
  }, [sid]);

  useAutoSync(
    sid ? `finance-${sid}` : null,
    store.exists === true && canFinance && isStale(store.data?.financeSyncedAt, 6 * 3600 * 1000),
    runSync,
  );

  // ---- aggregate the selected range (proceeds only — prices are never stored) ----
  const daysAsc = useMemo(() => [...daysQ.rows].map((r) => r.data).sort((a, b) => a.date.localeCompare(b.date)), [daysQ.rows]);
  const rangeDays = useMemo(() => daysAsc.slice(-Number(range)), [daysAsc, range]);

  const agg = useMemo(() => {
    const proceeds: Record<string, number> = { USD: 0 };
    let downloads = 0;
    let units = 0;
    const perApp = new Map<string, { downloads: number; units: number; proceeds: Record<string, number>; proceedsUsd: number }>();
    for (const day of rangeDays) {
      downloads += day.downloads;
      units += day.units;
      proceeds.USD = (proceeds.USD ?? 0) + (day.proceedsUsd ?? 0);
      for (const [appId, stat] of Object.entries(day.perApp ?? {})) {
        const rec = perApp.get(appId) ?? { downloads: 0, units: 0, proceeds: {}, proceedsUsd: 0 };
        rec.downloads += stat.downloads;
        rec.units += stat.units;
        rec.proceedsUsd += stat.proceedsUsd ?? 0;
        perApp.set(appId, rec);
      }
    }
    const primaryCurrency = 'USD';
    const topApps = [...perApp.entries()]
      .map(([appId, rec]) => ({ appId, ...rec, primary: rec.proceedsUsd }))
      .sort((a, b) => b.primary - a.primary || b.downloads - a.downloads);
    return { proceeds, downloads, units, primaryCurrency, topApps };
  }, [rangeDays]);

  const maxDayProceeds = Math.max(1, ...rangeDays.map((d) => d.proceedsUsd ?? 0));
  const maxTopApp = Math.max(1, ...agg.topApps.map((a) => a.primary));
  const [detailApp, setDetailApp] = useState<string | null>(null);

  // Rows keyed by an id we can't resolve to an app are old-schema aggregates
  // (IAP rows counted under their own Apple ID). One re-sync re-attributes them
  // to the parent app — trigger it automatically, once.
  const healedRef = useRef(false);
  useEffect(() => {
    if (healedRef.current || syncing || appsQ.loading || appsQ.rows.length === 0) return;
    const unresolved = agg.topApps.some((row) => !appNames.has(row.appId));
    if (unresolved && canFinance) {
      healedRef.current = true;
      toast.info('Re-crunching older reports…', {
        description: 'Some purchases were counted under their product ID — merging them into their apps now.',
      });
      void runSync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agg.topApps, appsQ.loading, appNames, canFinance, syncing]);

  if (!sid) return null;
  if (user && !allowed) {
    return (
      <div className="mx-auto w-full max-w-md px-6 py-16 text-center">
        <h1 className="text-lg font-semibold">No finance access</h1>
        <p className="mt-2 text-[13px] text-muted-foreground">
          Financial reports for this store require the “View finance reports” permission. Ask an admin to grant it.
        </p>
        <Link to={`/stores/${sid}`} className="mt-4 inline-block text-[13px] text-primary hover:underline">
          Back to the store
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to={`/stores/${sid}`}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </Link>
          {store.data && <StoreGlyph color={store.data.color} icon={store.data.icon} seed={sid} size="md" />}
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight">Finance — {store.data?.name}</h1>
            <p className="text-[12px] text-muted-foreground">
              Your proceeds (after Apple’s cut) — customer prices are never shown or stored. Visible to admins and explicitly granted users only.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            updated {timeAgo(store.data?.financeSyncedAt)}
          </span>
          <Button variant="outline" size="sm" onClick={() => void runSync()} loading={syncing} disabled={!canFinance}>
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        </div>
      </div>

      {!canFinance && store.exists ? (
        <EmptyState
          icon={LineChart}
          title="Add the vendor number to unlock finance"
          description="Stores → ⋯ → Settings & appearance → vendor number (from App Store Connect → Payments and Financial Reports). The API key also needs the Finance or Admin role."
        />
      ) : daysQ.loading && rangeDays.length === 0 ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : rangeDays.length === 0 ? (
        <EmptyState
          icon={LineChart}
          title="No report data yet"
          description={
            syncing
              ? 'Fetching daily reports from Apple — this first pull takes a moment…'
              : 'Hit Refresh to pull the daily sales reports. Apple publishes each day’s report the next day.'
          }
          action={
            <Button onClick={() => void runSync()} loading={syncing}>
              <RefreshCw className="size-3.5" /> Fetch reports
            </Button>
          }
        />
      ) : (
        <>
          {/* Range filter */}
          <div className="mb-4 inline-flex rounded-lg bg-muted p-1">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={cn(
                  'rounded-md px-3 py-1 text-[13px] font-medium transition-colors',
                  range === r.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* Headline tiles */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              icon={Banknote}
              label="Proceeds (USD)"
              value={fmtMoney(agg.proceeds[agg.primaryCurrency] ?? 0, agg.primaryCurrency)}
              sub={rangeDays.length > 1 ? `${fmtMoney((agg.proceeds.USD ?? 0) / rangeDays.length, 'USD')}/day avg` : undefined}
              explain="Your earnings after Apple's commission, from Apple's daily sales reports, converted to USD."
            />
            <StatTile icon={Download} label="Downloads" value={fmtCount(agg.downloads)} sub="first-time installs" explain="First-time installs only — updates and re-downloads are not counted." />
            <StatTile icon={Package} label="Paid units" value={fmtCount(agg.units - agg.downloads < 0 ? 0 : agg.units - agg.downloads)} sub="IAP, subscriptions & updates" explain="Paid transactions: in-app purchases, subscription starts & renewals, and paid app sales." />
            <StatTile
              icon={LineChart}
              label="Days covered"
              value={String(rangeDays.length)}
              sub={`${rangeDays[0]?.date} → ${rangeDays[rangeDays.length - 1]?.date}`}
            />
          </div>

          {/* Daily proceeds trend — single hue, thin bars, per-mark tooltip */}
          {rangeDays.length > 1 && (
            <section className="mt-4 rounded-xl border bg-card p-4 shadow-card">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="text-[13px] font-semibold">Daily proceeds ({agg.primaryCurrency})</h2>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  peak {fmtMoney(maxDayProceeds, agg.primaryCurrency)}
                </span>
              </div>
              <div className="flex h-32 items-end gap-[2px] overflow-x-auto pb-1">
                {rangeDays.map((day) => {
                  const v = day.proceedsUsd ?? 0;
                  const h = Math.max(2, Math.round((v / maxDayProceeds) * 120));
                  return (
                    <div key={day.date} className="group relative flex-1" style={{ minWidth: 8 }}>
                      <div
                        className="mx-auto w-full rounded-t-[4px] bg-primary transition-opacity group-hover:opacity-80"
                        style={{ height: h }}
                      />
                      <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-[11px] text-background shadow-pop group-hover:block">
                        <div className="font-semibold">{day.date}</div>
                        <div>{fmtMoney(v, agg.primaryCurrency)} · {fmtCount(day.downloads)} downloads</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground">
                <span>{rangeDays[0]?.date}</span>
                <span>{rangeDays[rangeDays.length - 1]?.date}</span>
              </div>
            </section>
          )}

          {/* Top apps */}
          <section className="mt-4 overflow-hidden rounded-xl border bg-card shadow-card">
            <div className="border-b bg-muted/40 px-4 py-2.5 text-[13px] font-semibold">Top apps</div>
            {agg.topApps.length === 0 ? (
              <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No per-app data in this range.</p>
            ) : (
              <div className="divide-y">
                {agg.topApps.map((row) => {
                  const app = appNames.get(row.appId);
                  const label = app?.name ?? 'In-app purchases (older report — merging…)';
                  return (
                    <button
                      type="button"
                      onClick={() => setDetailApp(row.appId)}
                      key={row.appId}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/40"
                    >
                      <AppGlyph
                        name={app?.name ?? 'I'}
                        iconUrl={app?.iconUrl}
                        seed={row.appId}
                        size="md"
                        className="rounded-[22%]"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className={cn('truncate text-[13px] font-medium', !app && 'text-muted-foreground')}>{label}</span>
                            {app && <PlatformBadges platforms={app.platforms} devices={app.devices} className="shrink-0" />}
                          </span>
                          <span className="shrink-0 text-[13px] font-semibold tabular-nums">
                            {fmtMoney(row.primary, agg.primaryCurrency)}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary"
                              style={{ width: `${Math.round((row.primary / maxTopApp) * 100)}%` }}
                            />
                          </div>
                          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                            {fmtCount(row.downloads)} downloads
                          </span>
                        </div>
                      </div>
                      {app && (
                        <Link
                          to={`/stores/${sid}/apps/${row.appId}`}
                          onClick={(e) => e.stopPropagation()}
                          className="shrink-0"
                        >
                          <Badge variant="outline">open</Badge>
                        </Link>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </section>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Source: Apple daily sales reports (proceeds & units only). Reports for a given day appear the
            following day — “Latest day” shows the most recent available report.
          </p>

          {detailApp && (
            <AppFinanceDetail
              appId={detailApp}
              app={appNames.get(detailApp) ?? null}
              storeId={sid}
              days={rangeDays}
              onClose={() => setDetailApp(null)}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Per-app breakdown for the selected range — computed entirely from the
 * financeDays docs already on screen, so opening it costs zero extra reads.
 */
function AppFinanceDetail({
  appId,
  app,
  storeId,
  days,
  onClose,
}: {
  appId: string;
  app: AppDoc | null;
  storeId: string;
  days: FinanceDayDoc[];
  onClose: () => void;
}) {
  const series = useMemo(
    () =>
      days.map((day) => {
        const stat = day.perApp?.[appId];
        return { date: day.date, proceeds: stat?.proceedsUsd ?? 0, downloads: stat?.downloads ?? 0, units: stat?.units ?? 0 };
      }),
    [days, appId],
  );
  const totals = useMemo(
    () =>
      series.reduce(
        (acc, point) => ({
          proceeds: acc.proceeds + point.proceeds,
          downloads: acc.downloads + point.downloads,
          units: acc.units + point.units,
        }),
        { proceeds: 0, downloads: 0, units: 0 },
      ),
    [series],
  );
  const peak = Math.max(1, ...series.map((point) => point.proceeds));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border bg-card p-5 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-3">
          <AppGlyph name={app?.name ?? 'I'} iconUrl={app?.iconUrl} seed={appId} size="lg" className="rounded-[22%]" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate text-[15px] font-semibold">{app?.name ?? 'In-app purchases (older report)'}</h3>
              {app && <PlatformBadges platforms={app.platforms} devices={app.devices} className="shrink-0" />}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {series[0]?.date} → {series[series.length - 1]?.date}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Proceeds</div>
            <div className="mt-0.5 truncate text-lg font-semibold tabular-nums">{fmtMoney(totals.proceeds, 'USD')}</div>
          </div>
          <div className="rounded-lg border p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Downloads</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums">{fmtCount(totals.downloads)}</div>
          </div>
          <div className="rounded-lg border p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Paid units</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums">{fmtCount(Math.max(0, totals.units - totals.downloads))}</div>
          </div>
        </div>

        {series.length > 1 && (
          <div className="mt-4">
            <div className="mb-1 flex items-baseline justify-between text-[11px] text-muted-foreground">
              <span>Daily proceeds</span>
              <span className="tabular-nums">peak {fmtMoney(peak, 'USD')}</span>
            </div>
            <div className="flex h-24 items-end gap-[2px]">
              {series.map((point) => (
                <div key={point.date} className="group relative flex-1" style={{ minWidth: 6 }}>
                  <div
                    className="mx-auto w-full rounded-t-[3px] bg-primary transition-opacity group-hover:opacity-80"
                    style={{ height: Math.max(2, Math.round((point.proceeds / peak) * 88)) }}
                  />
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-[11px] text-background shadow-pop group-hover:block">
                    <div className="font-semibold">{point.date}</div>
                    <div>{fmtMoney(point.proceeds, 'USD')} · {fmtCount(point.downloads)} downloads</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {app && (
          <div className="mt-4 flex justify-end">
            <Link to={`/stores/${storeId}/apps/${appId}`} onClick={onClose}>
              <Button variant="outline" size="sm">Open app workspace</Button>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
